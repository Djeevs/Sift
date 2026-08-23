/**
 * How much upside is there in paying Terra to look at this item?
 *
 * This is an allocation score, not a quality score. It never reaches the final
 * ranking and never decides what publishes -- it decides only what is worth
 * buying a deep evaluation for, given everything already known for free.
 *
 * The distinction matters. A brilliant item that is the fifth excellent AI post
 * of the day has low *opportunity* (the edition is already well served) while
 * still having high quality. Conversely a merely promising Games item can be
 * worth evaluating when Games has nothing, because that is where another good
 * item would actually change the edition.
 */
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';

export interface OpportunityInput {
  item_id: string;
  source_id: string;
  free_score: number;
  triage_score: number;
  luna_action: string | null;
  interest_match: number;
  novelty: number;
  junk_probability: number;
  quality_prior: number;
  categories: string[];
  cluster_id: string | null;
  perspective_distance: number;
  serendipity_potential: number;
  content_type: string | null;
  published_at: number | null;
}

export interface OpportunityResult {
  item_id: string;
  score: number;
  /** Every contribution, so an allocation decision can be explained. */
  components: Record<string, number>;
  feed_need: number;
  essential_candidate: boolean;
  serendipity: boolean;
  reason: string;
}

/**
 * How badly each feed still needs candidates today: 1 when empty, 0 when it has
 * reached the top of its target range. This is what makes Terra spend follow
 * where the edition is actually thin.
 */
export function feedNeed(db: Db, config: AppConfig, dayKey: string): Map<string, number> {
  const published = new Map<string, number>();
  for (const row of db.all<{ feed_id: string; n: number }>(
    `SELECT feed_id, COUNT(*) AS n FROM published_feed_items WHERE day_key = :d GROUP BY feed_id`,
    { d: dayKey },
  )) {
    published.set(row.feed_id, row.n);
  }

  // Items already evaluated and waiting are supply too: a feed with ten strong
  // unpublished candidates does not need more bought for it.
  const queued = new Map<string, number>();
  for (const row of db.all<{ feed_id: string; n: number }>(
    `SELECT r.feed_id, COUNT(*) AS n
     FROM routing_decisions r JOIN feed_items fi ON fi.id = r.item_id
     WHERE fi.status = 'deep_evaluated' GROUP BY r.feed_id`,
    {},
  )) {
    queued.set(row.feed_id, row.n);
  }

  const need = new Map<string, number>();
  for (const feed of config.feeds) {
    const target = feed.target_items_per_day?.[1] ?? feed.daily_cap ?? 5;
    const supply = (published.get(feed.id) ?? 0) + (queued.get(feed.id) ?? 0) * 0.5;
    need.set(feed.id, target <= 0 ? 0 : Math.max(0, Math.min(1, 1 - supply / target)));
  }
  return need;
}

/** Feeds that would accept an item in this category at all. */
function feedsForCategories(config: AppConfig, categories: string[]): string[] {
  const out: string[] = [];
  for (const feed of config.feeds) {
    const accepted = feed.categories;
    if (!accepted || accepted.length === 0 || categories.some((c) => accepted.includes(c))) {
      out.push(feed.id);
    }
  }
  return out;
}

export function scoreOpportunity(
  input: OpportunityInput,
  ctx: {
    config: AppConfig;
    need: Map<string, number>;
    /** Items already selected this run, per source and per category. */
    sourceCounts: Map<string, number>;
    categoryCounts: Map<string, number>;
  },
): OpportunityResult {
  const cfg = ctx.config.terraOpportunity;
  const w = cfg.weights;
  const p = cfg.penalties;

  const feeds = feedsForCategories(ctx.config, input.categories);
  const need = feeds.length === 0 ? 0 : Math.max(...feeds.map((f) => ctx.need.get(f) ?? 0));

  // Luna's confidence, as distance from a coin flip.
  const confidence = Math.abs(input.triage_score) > 0 ? Math.min(1, Math.abs(input.triage_score)) : 0;

  // A story already represented loses most of its claim unless this member
  // genuinely reads as a different take.
  const differentiation = input.cluster_id ? input.perspective_distance : 1;

  const components: Record<string, number> = {
    luna_interest_match: (w.luna_interest_match ?? 0) * input.interest_match,
    luna_novelty: (w.luna_novelty ?? 0) * input.novelty,
    luna_confidence: (w.luna_confidence ?? 0) * confidence,
    free_score: (w.free_score ?? 0) * Math.max(0, input.free_score),
    source_quality_prior: (w.source_quality_prior ?? 0) * input.quality_prior,
    cluster_differentiation: (w.cluster_differentiation ?? 0) * differentiation,
    feed_need: (w.feed_need ?? 0) * need,
    serendipity_potential: (w.serendipity_potential ?? 0) * input.serendipity_potential,
  };

  // Saturation: the nth item from one source, or in one category, this run is
  // worth progressively less than the first.
  const sourceSeen = ctx.sourceCounts.get(input.source_id) ?? 0;
  const categorySeen = Math.max(
    0,
    ...input.categories.map((c) => ctx.categoryCounts.get(c) ?? 0),
    0,
  );
  components.source_saturation = -(p.source_saturation ?? 0) * (1 - 1 / (1 + sourceSeen));
  components.topic_saturation = -(p.topic_saturation ?? 0) * (1 - 1 / (1 + categorySeen));

  // Junk suppresses everything: no upside in a deep look at obvious bait.
  components.junk = -input.junk_probability * 0.5;

  // UNCERTAIN is precisely where a deep evaluation changes the answer, which is
  // the definition of information value.
  if (input.luna_action === 'UNCERTAIN') {
    components.uncertainty_bonus = cfg.uncertainty_bonus;
  }

  let score = Object.values(components).reduce((a, b) => a + b, 0);

  // If every feed this could land in is already full, the upside is small
  // whatever the item's merits.
  if (need <= 0.01) score *= cfg.saturated_feed_multiplier;

  score = Math.max(0, Math.min(1, score));

  const top = Object.entries(components)
    .filter(([, v]) => Math.abs(v) > 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(3)}`);

  return {
    item_id: input.item_id,
    score,
    components,
    feed_need: need,
    // Essential is the feed whose absence is felt most, so its candidates keep
    // buying evaluations even at the hard limit.
    essential_candidate: input.interest_match >= 0.7 && input.free_score >= 0.45,
    serendipity: input.serendipity_potential >= 0.5,
    reason: `opportunity ${score.toFixed(3)} (${top.join(', ')}; feed need ${need.toFixed(2)})`,
  };
}
