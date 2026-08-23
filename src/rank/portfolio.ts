import type { AppConfig, FeedConfig } from '../config/index.js';
import { feedWeight } from '../config/index.js';
import type { DeepScores } from '../route/score.js';
import { scoreForFeed, type FeedScore } from '../route/score.js';
import type { OverlapPair } from './sourceStats.js';

/**
 * Stage 6: portfolio construction.
 *
 * The rule this file exists to enforce:
 *
 *   Terra identifies excellent candidates. Deterministic portfolio construction
 *   decides what combination of those candidates should actually reach the reader.
 *
 * So this is not "sort by expected_attention_value, take N". Feeds are built by
 * repeated marginal-value selection: pick the best remaining candidate, add it to
 * the edition, then re-score everything else against what the edition now
 * contains. Diminishing returns rather than caps, so an exceptional fourth item
 * from one source can still win a slot that a mediocre first item would not.
 *
 * Pure functions over an explicit ledger: no database, no clock. The runner in
 * publishEdition.ts supplies state and persists the decisions.
 */

export interface Candidate {
  itemId: string;
  sourceId: string;
  clusterId: string | null;
  category: string;
  scores: DeepScores;
  recommendedFeeds: string[];
  /** Minutes of attention this item is expected to cost. */
  minutes: number;
  /** Source prior, nearly spent by this point: it already bought the Terra call. */
  qualityPrior: number;
  /** Empirical, from feedback. */
  learnedSourceValue: number;
  /** True when the source is under-sampled and holds an exploration claim. */
  exploration: boolean;
  why: string | null;
}

/** What a feed's edition already contains. Mutated as items are selected. */
export interface EditionLedger {
  feedId: string;
  items: number;
  minutes: number;
  perSource: Map<string, number>;
  perCategory: Map<string, number>;
  perCluster: Map<string, number>;
  explorationSlots: number;
}

export function emptyLedger(feedId: string): EditionLedger {
  return {
    feedId,
    items: 0,
    minutes: 0,
    perSource: new Map(),
    perCategory: new Map(),
    perCluster: new Map(),
    explorationSlots: 0,
  };
}

export interface Adjustments {
  baseScore: number;
  feedWeightApplied: number;
  qualityAdjust: number;
  learnedAdjust: number;
  sourcePenalty: number;
  topicPenalty: number;
  clusterPenalty: number;
  correlationPenalty: number;
  finalScore: number;
  notes: string[];
}

/** Look up a decay multiplier for the nth occurrence (0-based). */
function decayAt(decay: number[], tail: number, index: number): number {
  return decay[index] ?? tail;
}

/**
 * Diminishing returns for a source already represented in this edition. Soft: an
 * exceptional later item survives, which a hard cap would forbid.
 */
export function sourceDiminishing(
  count: number,
  feed: FeedConfig,
  config: AppConfig,
): number {
  const global = config.final.final_ranking.source_diminishing;
  const decay = feed.diversity.source_decay ?? global.decay;
  return decayAt(decay, global.tail, count);
}

export function topicDiminishing(count: number, config: AppConfig): number {
  const t = config.final.final_ranking.topic_diminishing;
  return decayAt(t.decay, t.tail, count);
}

/**
 * Diminishing returns for a second (or third) item from one story.
 *
 * Scaled by how duplicative the item actually is. A flat penalty would make any
 * second take fail a feed's min_score, including the technical explainer plus
 * sceptical critique case that this system explicitly wants to keep. The penalty
 * exists to suppress recaps, so it should be proportional to how much of a recap
 * the item is: Terra's duplicate_information is exactly that measurement.
 *
 * duplicate_information 0.05 -> almost no penalty; 0.9 -> the full decay (and the
 * hard gate has usually excluded it before this point anyway).
 */
export function clusterDiminishing(
  count: number,
  feed: FeedConfig,
  config: AppConfig,
  duplicateInformation = 1,
): number {
  const t = config.final.final_ranking.topic_diminishing;
  const decay = feed.diversity.cluster_decay ?? t.cluster_decay;
  const base = decayAt(decay, t.cluster_tail, count);
  if (count === 0) return base;
  const novelShare = Math.max(0, Math.min(1, 1 - duplicateInformation));
  return base + (1 - base) * novelShare;
}

/**
 * Correlated-source discount. If a source that usually covers the same stories
 * has already contributed to this edition, the marginal information here is lower
 * even when the two items are not in the same cluster.
 */
export function correlationPenalty(
  candidate: Candidate,
  ledger: EditionLedger,
  overlaps: Map<string, OverlapPair[]>,
  config: AppConfig,
): { multiplier: number; note: string | null } {
  const cfg = config.final.final_ranking.correlation;
  if (!cfg.enabled) return { multiplier: 1, note: null };

  const partners = overlaps.get(candidate.sourceId);
  if (!partners || partners.length === 0) return { multiplier: 1, note: null };

  let worst = 0;
  let worstPartner: string | null = null;
  for (const partner of partners) {
    const alreadyFromPartner = ledger.perSource.get(partner.partner) ?? 0;
    if (alreadyFromPartner === 0) continue;
    const penalty = Math.min(cfg.max_penalty, cfg.strength * partner.overlap * alreadyFromPartner);
    if (penalty > worst) {
      worst = penalty;
      worstPartner = partner.partner;
    }
  }
  if (worst <= 0) return { multiplier: 1, note: null };
  return {
    multiplier: Math.max(0, 1 - worst),
    note: `correlated with ${worstPartner} already in this edition (-${worst.toFixed(2)})`,
  };
}

/**
 * Marginal value of adding this candidate to a feed, given what the edition
 * already holds. Returns null when the candidate is not eligible at all.
 */
export function marginalValue(
  candidate: Candidate,
  feed: FeedConfig,
  ledger: EditionLedger,
  overlaps: Map<string, OverlapPair[]>,
  config: AppConfig,
  sourceFeedWeight: number,
): { eligible: boolean; adjustments: Adjustments; reason: string } {
  const feedScore: FeedScore = scoreForFeed(
    candidate.scores,
    feed,
    candidate.category,
    candidate.recommendedFeeds,
  );

  const bw = config.final.final_ranking.base_weights;
  const notes: string[] = [];

  if (!feedScore.eligible) {
    return {
      eligible: false,
      adjustments: {
        baseScore: feedScore.score,
        feedWeightApplied: sourceFeedWeight,
        qualityAdjust: 0,
        learnedAdjust: 0,
        sourcePenalty: 1,
        topicPenalty: 1,
        clusterPenalty: 1,
        correlationPenalty: 1,
        finalScore: feedScore.score,
        notes: [feedScore.reason],
      },
      reason: feedScore.reason,
    };
  }

  // Base: Terra's verdict through the feed's formula, then small nudges. Source
  // quality contributes only a little here -- it already earned the Terra call,
  // and Terra has now actually read the article.
  const base = feedScore.score * bw.terra_score;
  const qualityAdjust = bw.quality_prior * (candidate.qualityPrior - 0.5);
  const learnedAdjust = bw.learned_source_value * candidate.learnedSourceValue;
  const feedWeightAdjust = bw.feed_weight * (sourceFeedWeight - 0.6);

  const sourceCount = ledger.perSource.get(candidate.sourceId) ?? 0;
  const categoryCount = ledger.perCategory.get(candidate.category) ?? 0;
  const clusterCount = candidate.clusterId ? (ledger.perCluster.get(candidate.clusterId) ?? 0) : 0;

  const sourcePenalty = sourceDiminishing(sourceCount, feed, config);
  const topicPenalty = topicDiminishing(categoryCount, config);
  const clusterPenalty = candidate.clusterId
    ? clusterDiminishing(clusterCount, feed, config, candidate.scores.duplicate_information)
    : 1;
  const { multiplier: corrPenalty, note: corrNote } = correlationPenalty(
    candidate,
    ledger,
    overlaps,
    config,
  );
  if (corrNote) notes.push(corrNote);
  if (sourceCount > 0) notes.push(`${sourceCount} already from this source (x${sourcePenalty.toFixed(2)})`);
  if (categoryCount > 0) notes.push(`${categoryCount} already in ${candidate.category} (x${topicPenalty.toFixed(2)})`);
  if (clusterCount > 0) notes.push(`${clusterCount} already from this story (x${clusterPenalty.toFixed(2)})`);

  const adjusted = base + qualityAdjust + learnedAdjust + feedWeightAdjust;
  const finalScore = adjusted * sourcePenalty * topicPenalty * clusterPenalty * corrPenalty;

  return {
    eligible: true,
    adjustments: {
      baseScore: feedScore.score,
      feedWeightApplied: sourceFeedWeight,
      qualityAdjust,
      learnedAdjust,
      sourcePenalty,
      topicPenalty,
      clusterPenalty,
      correlationPenalty: corrPenalty,
      finalScore,
      notes,
    },
    reason: feedScore.reason,
  };
}

export interface SelectionResult {
  itemId: string;
  order: number;
  adjustments: Adjustments;
  explorationSlot: boolean;
  minutes: number;
}

export interface BuildOutcome {
  selected: SelectionResult[];
  /** Why each rejected candidate was not taken, keyed by item id. */
  rejected: Map<string, { adjustments: Adjustments; reason: string }>;
}

/**
 * Build one feed's edition by repeated marginal-value selection.
 *
 * Each round re-scores every remaining candidate against the current edition,
 * which is what makes this portfolio construction rather than a ranked slice: a
 * candidate's value depends on what has already been chosen.
 */
export function buildEdition(
  feed: FeedConfig,
  candidates: Candidate[],
  ledger: EditionLedger,
  overlaps: Map<string, OverlapPair[]>,
  config: AppConfig,
  options: {
    sourceFeedWeight: (sourceId: string) => number;
    /** Feeds an item has already been placed into this run. */
    feedsUsed: Map<string, number>;
  },
): BuildOutcome {
  const fr = config.final.final_ranking;
  const attention = fr.attention;
  const minutesBudget = feed.attention.minutes_per_day;
  const selected: SelectionResult[] = [];
  const rejected = new Map<string, { adjustments: Adjustments; reason: string }>();
  const remaining = [...candidates];

  // Exploration slots are reserved up front so behavioural learning cannot
  // compete them away, and protected slots (Serendipity) are honoured first.
  const protectedSlots = feed.protected_slots_per_day;

  while (remaining.length > 0 && ledger.items < feed.daily_cap) {
    let best: { index: number; value: number; adjustments: Adjustments; exploration: boolean } | null = null;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;

      if ((options.feedsUsed.get(candidate.itemId) ?? 0) >= fr.max_feeds_per_item) {
        rejected.set(candidate.itemId, {
          adjustments: zeroAdjustments(`already in ${fr.max_feeds_per_item} feeds`),
          reason: `already in ${fr.max_feeds_per_item} feeds`,
        });
        remaining.splice(i, 1);
        i -= 1;
        continue;
      }

      const evaluation = marginalValue(
        candidate,
        feed,
        ledger,
        overlaps,
        config,
        options.sourceFeedWeight(candidate.sourceId),
      );
      if (!evaluation.eligible) {
        rejected.set(candidate.itemId, { adjustments: evaluation.adjustments, reason: evaluation.reason });
        remaining.splice(i, 1);
        i -= 1;
        continue;
      }

      // Hard cap is the final safety valve, not the mechanism.
      const sourceCount = ledger.perSource.get(candidate.sourceId) ?? 0;
      if (sourceCount >= fr.source_diminishing.hard_cap_per_feed_per_day) continue;

      const categoryCount = ledger.perCategory.get(candidate.category) ?? 0;
      if (categoryCount >= feed.diversity.max_per_category_per_day) continue;

      // A second item from one story needs Terra to say it is not a recap.
      const clusterCount = candidate.clusterId ? (ledger.perCluster.get(candidate.clusterId) ?? 0) : 0;
      if (
        clusterCount > 0 &&
        candidate.scores.duplicate_information > fr.topic_diminishing.cluster_max_duplicate_information
      ) {
        continue;
      }

      const value = evaluation.adjustments.finalScore;
      if (value < feed.min_score) continue;

      // Once protected slots remain, only exploration candidates may be picked.
      const protectedRemaining = Math.max(0, protectedSlots - ledger.explorationSlots);
      const slotsLeft = feed.daily_cap - ledger.items;
      if (protectedRemaining >= slotsLeft && !candidate.exploration && !isExploratory(candidate, feed, config)) {
        continue;
      }

      if (!best || value > best.value) {
        best = {
          index: i,
          value,
          adjustments: evaluation.adjustments,
          exploration: candidate.exploration || isExploratory(candidate, feed, config),
        };
      }
    }

    if (!best) break;

    const candidate = remaining[best.index]!;

    // Attention budget. A feed stops taking items once its minutes are spent,
    // even with item slots unfilled -- but the last item may spill a little
    // rather than being dropped for a few minutes' overrun.
    if (attention.enabled && minutesBudget !== null) {
      const projected = ledger.minutes + candidate.minutes;
      if (projected > minutesBudget + attention.overflow_tolerance_minutes) {
        rejected.set(candidate.itemId, {
          adjustments: best.adjustments,
          reason:
            `attention budget: ${ledger.minutes.toFixed(0)} of ${minutesBudget} min used, ` +
            `this item needs ${candidate.minutes.toFixed(0)} min`,
        });
        remaining.splice(best.index, 1);
        continue;
      }
    }

    selected.push({
      itemId: candidate.itemId,
      order: selected.length + 1,
      adjustments: best.adjustments,
      explorationSlot: best.exploration,
      minutes: candidate.minutes,
    });

    ledger.items += 1;
    ledger.minutes += candidate.minutes;
    ledger.perSource.set(candidate.sourceId, (ledger.perSource.get(candidate.sourceId) ?? 0) + 1);
    ledger.perCategory.set(candidate.category, (ledger.perCategory.get(candidate.category) ?? 0) + 1);
    if (candidate.clusterId) {
      ledger.perCluster.set(candidate.clusterId, (ledger.perCluster.get(candidate.clusterId) ?? 0) + 1);
    }
    if (best.exploration) ledger.explorationSlots += 1;
    options.feedsUsed.set(candidate.itemId, (options.feedsUsed.get(candidate.itemId) ?? 0) + 1);

    remaining.splice(best.index, 1);
  }

  // Anything still standing lost on marginal value rather than eligibility.
  for (const candidate of remaining) {
    if (rejected.has(candidate.itemId)) continue;
    const evaluation = marginalValue(
      candidate,
      feed,
      ledger,
      overlaps,
      config,
      options.sourceFeedWeight(candidate.sourceId),
    );
    rejected.set(candidate.itemId, {
      adjustments: evaluation.adjustments,
      reason: evaluation.eligible
        ? ledger.items >= feed.daily_cap
          ? `feed full (${feed.daily_cap} items)`
          : `marginal value ${evaluation.adjustments.finalScore.toFixed(3)} below min_score ${feed.min_score}`
        : evaluation.reason,
    });
  }

  return { selected, rejected };
}

/**
 * Serendipity-shaped: far from known interests, which is what protected slots
 * exist to defend. Thresholds are configurable because they decide who may claim
 * those slots, and that is an editorial choice rather than an implementation
 * detail.
 */
function isExploratory(candidate: Candidate, feed: FeedConfig, config: AppConfig): boolean {
  if (feed.mode === 'serendipity') return true;
  const cfg = config.final.final_ranking.exploration;
  return (
    candidate.scores.anchor_distance >= cfg.min_anchor_distance &&
    candidate.scores.serendipity >= cfg.min_serendipity
  );
}

function zeroAdjustments(note: string): Adjustments {
  return {
    baseScore: 0,
    feedWeightApplied: 0,
    qualityAdjust: 0,
    learnedAdjust: 0,
    sourcePenalty: 1,
    topicPenalty: 1,
    clusterPenalty: 1,
    correlationPenalty: 1,
    finalScore: 0,
    notes: [note],
  };
}

export { feedWeight };
