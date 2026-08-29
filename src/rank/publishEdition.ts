import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { feedWeight, orderedFeeds } from '../config/index.js';
import { buildEdition, emptyLedger, type Candidate, type EditionLedger } from './portfolio.js';
import { correlatedSources, learnedSourceValues } from './sourceStats.js';
import { attentionMinutes, minutesSpentToday } from './attention.js';
import { setStatus } from '../pipeline/journal.js';
import { dayKey } from '../util/time.js';
import { logger } from '../util/log.js';

const log = logger('edition');

/**
 * Stage 6 runner: turn Terra's candidate pool into today's editions.
 *
 * Every (item, feed) pair considered gets a row in final_ranking_decisions with
 * each adjustment that moved it, so both "why did this reach me?" and "why did
 * this disappear?" are answerable from the database alone.
 */

export interface EditionStats {
  candidates: number;
  published: number;
  perFeed: Record<string, number>;
  minutesPerFeed: Record<string, number>;
  skipped: Record<string, number>;
}

function safeArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function loadCandidates(db: Db, config: AppConfig): Candidate[] {
  const rows = db.all<{
    id: string;
    source_id: string;
    cluster_id: string | null;
    category: string | null;
    personal_interest: number;
    intellectual_depth: number;
    novelty: number;
    practical_usefulness: number;
    entertainment: number;
    storytelling: number;
    authorial_voice: number;
    critique: number;
    humor: number;
    obsessive_expertise: number;
    rabbit_hole: number;
    delight: number;
    headline_sufficiency: number;
    source_quality: number;
    serendipity: number;
    ragebait: number;
    duplicate_information: number;
    expected_attention_value: number;
    anchor_distance: number;
    recommended_feeds_json: string;
    why_it_surfaced: string | null;
    items_seen: number | null;
  }>(
    `SELECT fi.id, fi.source_id, fi.cluster_id, de.category,
            de.personal_interest, de.intellectual_depth, de.novelty, de.practical_usefulness,
            de.entertainment, de.storytelling, de.authorial_voice, de.critique, de.humor,
            de.obsessive_expertise, de.rabbit_hole, de.delight, de.headline_sufficiency,
            de.source_quality, de.serendipity, de.ragebait,
            de.duplicate_information, de.expected_attention_value, de.anchor_distance,
            de.recommended_feeds_json, de.why_it_surfaced,
            (SELECT items_seen FROM source_statistics ss WHERE ss.source_id = fi.source_id) AS items_seen
     FROM deep_evaluations de
     JOIN feed_items fi ON fi.id = de.item_id
     JOIN sources s ON s.id = fi.source_id
     WHERE s.publishable = 1
       -- Audit samples are measured, never auto-published: that is the point.
       AND de.is_audit_sample = 0
       AND NOT EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = fi.id)
     ORDER BY de.expected_attention_value DESC`,
  );

  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));
  const learned = learnedSourceValues(db);
  const minutes = attentionMinutes(db, rows.map((r) => r.id));
  const explorationThreshold = config.free.free_ranking.exploration.min_items_for_confidence;
  const fallbackMinutes = config.final.final_ranking.attention.default_reading_minutes;

  return rows.map((r) => ({
    itemId: r.id,
    sourceId: r.source_id,
    clusterId: r.cluster_id,
    category: r.category ?? 'other',
    scores: {
      personal_interest: r.personal_interest,
      intellectual_depth: r.intellectual_depth,
      novelty: r.novelty,
      practical_usefulness: r.practical_usefulness,
      entertainment: r.entertainment,
      storytelling: r.storytelling,
      authorial_voice: r.authorial_voice,
      critique: r.critique,
      humor: r.humor,
      obsessive_expertise: r.obsessive_expertise,
      rabbit_hole: r.rabbit_hole,
      delight: r.delight,
      headline_sufficiency: r.headline_sufficiency,
      source_quality: r.source_quality,
      serendipity: r.serendipity,
      ragebait: r.ragebait,
      duplicate_information: r.duplicate_information,
      expected_attention_value: r.expected_attention_value,
      anchor_distance: r.anchor_distance,
    },
    recommendedFeeds: safeArray(r.recommended_feeds_json),
    minutes: minutes.get(r.id) ?? fallbackMinutes,
    qualityPrior: sourceMap.get(r.source_id)?.quality_prior ?? 0.55,
    learnedSourceValue: learned.get(r.source_id) ?? 0,
    exploration: (r.items_seen ?? 0) < explorationThreshold,
    why: r.why_it_surfaced,
  }));
}

export function publishEditions(db: Db, config: AppConfig, now: number = Date.now()): EditionStats {
  const candidates = loadCandidates(db, config);
  const stats: EditionStats = {
    candidates: candidates.length,
    published: 0,
    perFeed: {},
    minutesPerFeed: {},
    skipped: {},
  };
  if (candidates.length === 0) return stats;

  const today = dayKey(now);
  const overlaps = correlatedSources(db, config);
  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));
  const feedsUsed = new Map<string, number>();
  const ts = now;

  // Feeds already partly filled today: continue their editions rather than
  // starting fresh, so a second run of the day cannot double a feed's budget.
  const ledgers = new Map<string, EditionLedger>();
  for (const feed of config.feeds) {
    const ledger = emptyLedger(feed.id);
    const existing = db.all<{ source_id: string; category: string | null; cluster_id: string | null }>(
      `SELECT fi.source_id, de.category, fi.cluster_id
       FROM published_feed_items p
       JOIN feed_items fi ON fi.id = p.item_id
       LEFT JOIN deep_evaluations de ON de.item_id = p.item_id
       WHERE p.feed_id = :f AND p.day_key = :d`,
      { f: feed.id, d: today },
    );
    for (const row of existing) {
      ledger.items += 1;
      ledger.perSource.set(row.source_id, (ledger.perSource.get(row.source_id) ?? 0) + 1);
      const cat = row.category ?? 'other';
      ledger.perCategory.set(cat, (ledger.perCategory.get(cat) ?? 0) + 1);
      if (row.cluster_id) ledger.perCluster.set(row.cluster_id, (ledger.perCluster.get(row.cluster_id) ?? 0) + 1);
    }
    ledger.minutes = minutesSpentToday(db, feed.id, today);
    ledgers.set(feed.id, ledger);
  }

  db.transaction(() => {
    for (const feed of orderedFeeds(config)) {
      const ledger = ledgers.get(feed.id)!;
      const outcome = buildEdition(feed, candidates, ledger, overlaps, config, {
        sourceFeedWeight: (sourceId) => feedWeight(sourceMap.get(sourceId), feed.id),
        feedsUsed,
      });

      for (const pick of outcome.selected) {
        const candidate = candidates.find((c) => c.itemId === pick.itemId)!;
        db.run(
          `INSERT INTO final_ranking_decisions (
              item_id, feed_id, base_score, feed_weight, quality_adjust, learned_adjust,
              source_penalty, topic_penalty, cluster_penalty, correlation_penalty,
              final_score, threshold, selection_order, published, exploration_slot,
              reason, estimated_minutes, config_hash, day_key, created_at)
           VALUES (:item, :feed, :base, :fw, :qa, :la, :sp, :tp, :cp, :corr, :final,
                   :threshold, :order, 1, :expl, :reason, :minutes, :hash, :day, :ts)
           ON CONFLICT(item_id, feed_id) DO UPDATE SET
              base_score = excluded.base_score, final_score = excluded.final_score,
              source_penalty = excluded.source_penalty, topic_penalty = excluded.topic_penalty,
              cluster_penalty = excluded.cluster_penalty,
              correlation_penalty = excluded.correlation_penalty,
              selection_order = excluded.selection_order, published = 1,
              exploration_slot = excluded.exploration_slot, reason = excluded.reason,
              estimated_minutes = excluded.estimated_minutes, day_key = excluded.day_key,
              created_at = excluded.created_at`,
          {
            item: pick.itemId,
            feed: feed.id,
            base: pick.adjustments.baseScore,
            fw: pick.adjustments.feedWeightApplied,
            qa: pick.adjustments.qualityAdjust,
            la: pick.adjustments.learnedAdjust,
            sp: pick.adjustments.sourcePenalty,
            tp: pick.adjustments.topicPenalty,
            cp: pick.adjustments.clusterPenalty,
            corr: pick.adjustments.correlationPenalty,
            final: pick.adjustments.finalScore,
            threshold: feed.min_score,
            order: pick.order,
            expl: pick.explorationSlot ? 1 : 0,
            reason: pick.adjustments.notes.join('; ') || 'selected on marginal value',
            minutes: pick.minutes,
            hash: config.hashes.ranking,
            day: today,
            ts,
          },
        );

        db.run(
          `INSERT INTO published_feed_items (feed_id, item_id, score, rank_position, why_it_surfaced, published_at, day_key)
           VALUES (:f, :i, :s, :rank, :why, :ts, :day)
           ON CONFLICT(feed_id, item_id) DO NOTHING`,
          {
            f: feed.id,
            i: pick.itemId,
            s: pick.adjustments.finalScore,
            rank: pick.order,
            why: candidate.why,
            ts,
            day: today,
          },
        );
        setStatus(db, pick.itemId, 'published', `published to ${feed.id}`);

        stats.published += 1;
        stats.perFeed[feed.id] = (stats.perFeed[feed.id] ?? 0) + 1;
      }

      for (const [itemId, rejection] of outcome.rejected) {
        stats.skipped[rejection.reason] = (stats.skipped[rejection.reason] ?? 0) + 1;
        db.run(
          `INSERT INTO final_ranking_decisions (
              item_id, feed_id, base_score, feed_weight, quality_adjust, learned_adjust,
              source_penalty, topic_penalty, cluster_penalty, correlation_penalty,
              final_score, threshold, published, reason, config_hash, day_key, created_at)
           VALUES (:item, :feed, :base, :fw, :qa, :la, :sp, :tp, :cp, :corr, :final,
                   :threshold, 0, :reason, :hash, :day, :ts)
           ON CONFLICT(item_id, feed_id) DO UPDATE SET
              base_score = excluded.base_score, final_score = excluded.final_score,
              reason = excluded.reason, day_key = excluded.day_key, created_at = excluded.created_at
           WHERE final_ranking_decisions.published = 0`,
          {
            item: itemId,
            feed: feed.id,
            base: rejection.adjustments.baseScore,
            fw: rejection.adjustments.feedWeightApplied,
            qa: rejection.adjustments.qualityAdjust,
            la: rejection.adjustments.learnedAdjust,
            sp: rejection.adjustments.sourcePenalty,
            tp: rejection.adjustments.topicPenalty,
            cp: rejection.adjustments.clusterPenalty,
            corr: rejection.adjustments.correlationPenalty,
            final: rejection.adjustments.finalScore,
            threshold: feed.min_score,
            reason: rejection.reason,
            hash: config.hashes.ranking,
            day: today,
            ts,
          },
        );
      }

      stats.minutesPerFeed[feed.id] = Math.round(ledger.minutes);
    }
  });

  log.info(
    `editions: ${stats.published} placements from ${stats.candidates} candidates`,
    stats.perFeed,
  );
  return stats;
}
