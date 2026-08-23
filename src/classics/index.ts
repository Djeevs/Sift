import type { AppConfig } from '../config/index.js';
import type { Db } from '../db/index.js';
import { AiClient } from '../ai/client.js';
import { discoverClassics, type DiscoveryStats } from './discovery.js';
import { evaluateClassics, verifyClassicEligibility, type EligibilityStats, type EvaluationStats } from './evaluate.js';
import { dayKey, DAY_MS } from '../util/time.js';
import { hostOf } from '../util/url.js';
import { logger } from '../util/log.js';

const log = logger('classics');

export interface ClassicsTopCandidate {
  itemId: string;
  title: string;
  author: string | null;
  source: string;
  canonicalUrl: string;
  originalPublishedAt: number | null;
  originalPublished: string;
  score: number;
  predictedRead: number;
  predictedPayoff: number;
  predictedSatisfaction: number;
  category: string;
  pleasureClass: string | null;
  why: string | null;
  discoverySource: string;
  discoverySources: string;
  accessCheck: 'passed';
}

export interface PublishClassicsStats {
  considered: number;
  published: number;
  itemIds: string[];
  reason: string | null;
}

export interface ClassicsRunResult {
  discovery?: DiscoveryStats;
  eligibility: EligibilityStats;
  evaluation: EvaluationStats;
  publication: PublishClassicsStats;
  top: ClassicsTopCandidate[];
}

function parseSources(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).join(' + ') : '';
  } catch {
    return '';
  }
}

export function topClassicCandidates(db: Db, limit = 20): ClassicsTopCandidate[] {
  const rows = db.all<{
    item_id: string;
    title: string;
    author: string | null;
    source_name: string;
    canonical_url: string;
    original_published_at: number | null;
    archival_score: number;
    predicted_read: number;
    predicted_payoff: number;
    predicted_satisfaction: number;
    category: string;
    pleasure_class: string | null;
    why_picked: string | null;
    best_discovery_source: string;
    discovery_sources_json: string;
  }>(
    `SELECT cc.item_id, fi.title, COALESCE(cc.original_author, fi.author) AS author,
            cc.source_name, fi.canonical_url, cc.original_published_at,
            ce.archival_score, ce.predicted_read, ce.predicted_payoff,
            ce.predicted_satisfaction, ce.category,
            ce.pleasure_class, ce.why_picked, cc.best_discovery_source,
            cc.discovery_sources_json
     FROM classics_evaluations ce
     JOIN classics_candidates cc ON cc.item_id = ce.item_id
     JOIN feed_items fi ON fi.id = ce.item_id
     WHERE cc.status IN ('evaluated', 'recommended')
     ORDER BY ce.archival_score DESC, ce.predicted_satisfaction DESC
     LIMIT :limit`,
    { limit },
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    title: row.title,
    author: row.author,
    source: row.source_name,
    canonicalUrl: row.canonical_url,
    originalPublishedAt: row.original_published_at,
    originalPublished: row.original_published_at
      ? new Date(row.original_published_at).toISOString().slice(0, 10)
      : 'unknown',
    score: row.archival_score,
    predictedRead: row.predicted_read,
    predictedPayoff: row.predicted_payoff,
    predictedSatisfaction: row.predicted_satisfaction,
    category: row.category,
    pleasureClass: row.pleasure_class,
    why: row.why_picked,
    discoverySource: row.best_discovery_source,
    discoverySources: parseSources(row.discovery_sources_json),
    accessCheck: 'passed',
  }));
}

export function publishClassics(db: Db, config: AppConfig, now = Date.now()): PublishClassicsStats {
  const feed = config.classics.feed;
  const today = dayKey(now);
  const existingToday = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM published_feed_items WHERE feed_id = :feed AND day_key = :day`,
    { feed: feed.id, day: today },
  )?.count ?? 0;
  if (existingToday >= config.classics.publishing.max_per_day) {
    return { considered: 0, published: 0, itemIds: [], reason: 'daily cap already filled' };
  }

  const candidates = db.all<{
    item_id: string;
    canonical_url: string;
    category: string;
    archival_score: number;
    predicted_read: number;
    predicted_payoff: number;
    predicted_satisfaction: number;
    why_picked: string | null;
    pleasure_class: string | null;
  }>(
    `SELECT ce.item_id, fi.canonical_url, ce.category, ce.archival_score,
            ce.predicted_read, ce.predicted_payoff, ce.predicted_satisfaction,
            ce.why_picked, ce.pleasure_class
     FROM classics_evaluations ce
     JOIN classics_candidates cc ON cc.item_id = ce.item_id
     JOIN feed_items fi ON fi.id = ce.item_id
     WHERE cc.status = 'evaluated'
       AND ce.archival_score >= :score
       AND ce.predicted_read >= :predicted_read
       AND ce.predicted_payoff >= :predicted_payoff
       AND NOT EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = ce.item_id)
       AND NOT EXISTS (SELECT 1 FROM open_events o WHERE o.item_id = ce.item_id)
     ORDER BY ce.archival_score DESC, ce.predicted_satisfaction DESC`,
    {
      score: config.classics.ranking.min_score,
      predicted_read: config.classics.ranking.min_predicted_read,
      predicted_payoff: config.classics.ranking.min_predicted_payoff,
    },
  );

  const learnedTraits = new Map(
    db.all<{ key: string; value: number }>(
      `SELECT key, value FROM learned_weights WHERE scope = 'classic_trait'`,
    ).map((row) => [row.key, row.value]),
  );
  // Classic-trait feedback is deliberately a small tie-breaker. The normal
  // learning threshold requires repeated evidence before these rows exist.
  candidates.sort((a, b) => {
    const adjustedA = a.archival_score + (learnedTraits.get(a.pleasure_class ?? '') ?? 0) * 0.05;
    const adjustedB = b.archival_score + (learnedTraits.get(b.pleasure_class ?? '') ?? 0) * 0.05;
    return adjustedB - adjustedA || b.predicted_satisfaction - a.predicted_satisfaction;
  });

  const lookback = now - config.classics.publishing.diversity_lookback_days * DAY_MS;
  const recent = db.all<{ canonical_url: string; category: string }>(
    `SELECT fi.canonical_url, ce.category
     FROM published_feed_items p
     JOIN feed_items fi ON fi.id = p.item_id
     LEFT JOIN classics_evaluations ce ON ce.item_id = p.item_id
     WHERE p.feed_id = :feed AND p.published_at >= :lookback`,
    { feed: feed.id, lookback },
  );
  const domains = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const row of recent) {
    const domain = hostOf(row.canonical_url);
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    categories.set(row.category ?? 'other', (categories.get(row.category ?? 'other') ?? 0) + 1);
  }

  const slots = Math.min(
    config.classics.publishing.max_per_run,
    config.classics.publishing.max_per_day - existingToday,
  );
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    const domain = hostOf(candidate.canonical_url);
    if (domain && (domains.get(domain) ?? 0) >= config.classics.publishing.max_same_domain_in_lookback) continue;
    if (
      (categories.get(candidate.category) ?? 0) >=
      config.classics.publishing.max_same_category_in_lookback
    ) continue;
    selected.push(candidate);
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    categories.set(candidate.category, (categories.get(candidate.category) ?? 0) + 1);
    if (selected.length >= slots) break;
  }

  db.transaction(() => {
    for (const [index, candidate] of selected.entries()) {
      db.run(
        `INSERT INTO published_feed_items (
           feed_id, item_id, score, rank_position, why_it_surfaced, published_at, day_key)
         VALUES (:feed, :item, :score, :rank, :why, :now, :day)
         ON CONFLICT(feed_id, item_id) DO NOTHING`,
        {
          feed: feed.id,
          item: candidate.item_id,
          score: candidate.archival_score,
          rank: existingToday + index + 1,
          why: candidate.why_picked,
          now,
          day: today,
        },
      );
      db.run(
        `UPDATE classics_candidates SET status = 'recommended', rejection_reason = NULL, updated_at = :now
         WHERE item_id = :item`,
        { item: candidate.item_id, now },
      );
    }
  });

  return {
    considered: candidates.length,
    published: selected.length,
    itemIds: selected.map((candidate) => candidate.item_id),
    reason: selected.length
      ? null
      : candidates.length
        ? 'diversity constraints'
        : 'no candidate cleared the start-and-9/10-payoff bar',
  };
}

function discoveryDue(db: Db, config: AppConfig, now: number): boolean {
  const last = db.get<{ value: string }>(`SELECT value FROM schema_meta WHERE key = 'classics_last_discovery_at'`);
  if (!last) return true;
  return now - Number(last.value) >= config.classics.discovery.refresh_interval_days * DAY_MS;
}

export async function runClassics(
  db: Db,
  config: AppConfig,
  ai: AiClient,
  options: { forceDiscovery?: boolean; publish?: boolean; publishOnly?: boolean; top?: number; now?: number } = {},
): Promise<ClassicsRunResult> {
  const now = options.now ?? Date.now();
  let discovery: DiscoveryStats | undefined;
  const mayDiscover = !options.publishOnly && (options.forceDiscovery || config.env.environment !== 'test');
  if (mayDiscover && (options.forceDiscovery || discoveryDue(db, config, now))) {
    discovery = await discoverClassics(db, config, now);
    db.run(
      `INSERT INTO schema_meta(key, value) VALUES('classics_last_discovery_at', :now)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      { now: String(now) },
    );
  }

  // Page extraction expands the historical pool only on the weekly discovery
  // cadence. Subsequent daily runs may finish evaluating that verified cohort,
  // but never chew through the whole archive 40 expensive calls at a time.
  const eligibility = discovery
    ? await verifyClassicEligibility(db, config)
    : { attempted: 0, eligible: 0, rejectedAccess: 0, rejectedLanguage: 0, rejectedDuplicate: 0 };
  const evaluation = options.publishOnly
    ? { considered: 0, evaluated: 0, failed: 0, spendUsd: 0 }
    : await evaluateClassics(db, config, ai);
  const publication =
    options.publish === false
      ? { considered: 0, published: 0, itemIds: [], reason: 'publishing disabled for this run' }
      : publishClassics(db, config, now);
  const top = topClassicCandidates(db, options.top ?? 20);
  log.info(
    `classics: ${eligibility.eligible} access-verified, ${evaluation.evaluated} evaluated, ` +
      `${publication.published} published`,
  );
  return { discovery, eligibility, evaluation, publication, top };
}
