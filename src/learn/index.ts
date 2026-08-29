import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { stableId } from '../util/hash.js';
import { logger } from '../util/log.js';
import { refreshSourceStatistics } from '../rank/sourceStats.js';

const log = logger('learn');

/**
 * Learning from feedback (§19).
 *
 * Transparent and slow on purpose. No model is trained; a small set of named
 * weights moves a little at a time, every change is stored with the evidence
 * count behind it, and hard bounds mean a bad week cannot wreck the system.
 *
 * Three rules are non-negotiable and enforced in code, not prompt text:
 *
 *   1. An open is a weak signal. Explicit feedback dominates it.
 *   2. Opening ragebait never teaches the system that ragebait is wanted.
 *   3. Editorial penalties (outrage, PR, engagement bait) have floors that no
 *      amount of engagement can lift.
 */

export interface Signal {
  itemId: string;
  sourceId: string;
  category: string | null;
  bestAnchorId: string | null;
  ragebait: number;
  /** Net signal strength: positive = liked, negative = rejected. */
  value: number;
  kinds: string[];
}

/** Collect the evidence: opens and explicit feedback, weighted per config. */
export function collectSignals(db: Db, config: AppConfig): Signal[] {
  const weights = config.pipeline.feedback.signal_weights;
  const openWeight = weights['opened'] ?? 0.15;
  const excellentWeight = weights['excellent'] ?? 1;
  const notForMeWeight = weights['not_for_me'] ?? -1;
  const rageThreshold = config.pipeline.learning.ignore_opens_when_ragebait_above;

  const rows = db.all<{
    item_id: string;
    source_id: string;
    category: string | null;
    best_anchor_id: string | null;
    ragebait: number;
    opens: number;
    excellent: number;
    not_for_me: number;
  }>(
    `SELECT p.item_id, fi.source_id, de.category, ce.best_anchor_id,
            COALESCE(de.ragebait, 0) AS ragebait,
            (SELECT COUNT(*) FROM open_events o WHERE o.item_id = p.item_id) AS opens,
            (SELECT COUNT(*) FROM explicit_feedback f
              WHERE f.item_id = p.item_id AND f.signal = 'excellent') AS excellent,
            (SELECT COUNT(*) FROM explicit_feedback f
              WHERE f.item_id = p.item_id AND f.signal = 'not_for_me') AS not_for_me
     FROM (SELECT DISTINCT item_id FROM published_feed_items) p
     JOIN feed_items fi ON fi.id = p.item_id
     LEFT JOIN deep_evaluations de ON de.item_id = p.item_id
     LEFT JOIN cheap_evaluations ce ON ce.item_id = p.item_id`,
  );

  const signals: Signal[] = [];
  for (const row of rows) {
    const kinds: string[] = [];
    let value = 0;

    // Rule 2: a click on something the model flagged as ragebait teaches
    // nothing. This is the single most important line in the learning code.
    if (row.opens > 0) {
      if (row.ragebait > rageThreshold) {
        kinds.push('open_ignored_ragebait');
      } else {
        value += openWeight;
        kinds.push('opened');
      }
    }
    if (row.excellent > 0) {
      value += excellentWeight;
      kinds.push('excellent');
    }
    if (row.not_for_me > 0) {
      value += notForMeWeight;
      kinds.push('not_for_me');
    }

    // Not opening something is not a negative signal (§18). No branch here.
    if (value === 0 && kinds.length === 0) continue;

    signals.push({
      itemId: row.item_id,
      sourceId: row.source_id,
      category: row.category,
      bestAnchorId: row.best_anchor_id,
      ragebait: row.ragebait,
      value,
      kinds,
    });
  }
  return signals;
}

export interface LearnStats {
  signals: number;
  updated: Array<{ scope: string; key: string; from: number; to: number; events: number }>;
  skipped: Array<{ scope: string; key: string; reason: string }>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Apply one slow update round. Idempotent in spirit rather than in letter: it
 * is safe to run daily, and each run nudges weights by at most learning_rate.
 */
export function applyLearning(db: Db, config: AppConfig): LearnStats {
  // Recompute the empirical source statistics first: they are the smoothed,
  // authoritative view of source value, uniqueness and overlap.
  refreshSourceStatistics(db, config);

  const cfg = config.pipeline.learning;
  const stats: LearnStats = { signals: 0, updated: [], skipped: [] };
  if (!cfg.enabled) {
    log.info('learning is disabled in ranking-config.yaml');
    return stats;
  }

  const signals = collectSignals(db, config);
  stats.signals = signals.length;
  if (signals.length === 0) return stats;

  // Aggregate evidence per scope key.
  const buckets = new Map<string, { scope: string; key: string; sum: number; count: number }>();
  const bump = (scope: string, key: string | null, value: number) => {
    if (!key) return;
    const mapKey = `${scope}:${key}`;
    const bucket = buckets.get(mapKey) ?? { scope, key, sum: 0, count: 0 };
    bucket.sum += value;
    bucket.count += 1;
    buckets.set(mapKey, bucket);
  };

  for (const signal of signals) {
    bump('source', signal.sourceId, signal.value);
    bump('category', signal.category, signal.value);
    bump('anchor', signal.bestAnchorId, signal.value);
  }

  const ts = Date.now();
  db.transaction(() => {
    for (const bucket of buckets.values()) {
      if (bucket.count < cfg.min_events_before_update) {
        stats.skipped.push({
          scope: bucket.scope,
          key: bucket.key,
          reason: `only ${bucket.count} events (need ${cfg.min_events_before_update})`,
        });
        continue;
      }

      const mean = bucket.sum / bucket.count;
      const existing = db.get<{ value: number; events: number }>(
        `SELECT value, events FROM learned_weights WHERE scope = :s AND key = :k`,
        { s: bucket.scope, k: bucket.key },
      );
      const current = existing?.value ?? 0;

      // Exponential moving average, so old evidence fades rather than dominating.
      let next = current + cfg.learning_rate * (mean - current);

      if (bucket.scope === 'source') {
        next = clamp(next, cfg.min_learned_source_value, cfg.max_learned_source_value);
      } else if (bucket.scope === 'anchor' || bucket.scope === 'category') {
        // Stored as a delta around 0; the effective multiplier is 1 + delta,
        // and it is that multiplier the configured bounds apply to.
        next = clamp(1 + next, cfg.min_interest_weight, cfg.max_interest_weight) - 1;
      }

      // Rule 3: editorial penalties have floors. A trait that config marks as
      // protected can never be learned into a positive.
      const penalty = cfg.protected_penalties[bucket.key];
      if (penalty !== undefined && next > penalty) {
        next = penalty;
        stats.skipped.push({
          scope: bucket.scope,
          key: bucket.key,
          reason: `clamped to protected penalty ${penalty}`,
        });
      }

      if (Math.abs(next - current) < 0.0005) continue;

      db.run(
        `INSERT INTO learned_weights (scope, key, value, events, updated_at)
         VALUES (:s, :k, :v, :e, :ts)
         ON CONFLICT(scope, key) DO UPDATE SET
           value = excluded.value, events = excluded.events, updated_at = excluded.updated_at`,
        { s: bucket.scope, k: bucket.key, v: next, e: (existing?.events ?? 0) + bucket.count, ts },
      );

      // Source value is not written here. It is recomputed from the raw counts
      // with Bayesian smoothing in rank/sourceStats.ts, so that two good posts
      // out of two cannot make a source look perfect. Writing a second,
      // differently-smoothed copy here would give two answers to one question.

      stats.updated.push({
        scope: bucket.scope,
        key: bucket.key,
        from: current,
        to: next,
        events: bucket.count,
      });
    }

    // Snapshot, so a change of taste can always be traced and compared.
    const snapshot = {
      taste_hash: config.hashes.taste,
      ranking_hash: config.hashes.ranking,
      learned: db.all(`SELECT scope, key, value, events FROM learned_weights ORDER BY scope, key`),
    };
    db.run(
      `INSERT INTO taste_profile_versions (id, config_hash, snapshot_json, note, created_at)
       VALUES (:id, :hash, :snap, :note, :ts)
       ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      {
        id: stableId('taste', config.hashes.taste, String(ts)),
        hash: `${config.hashes.ranking}`,
        snap: JSON.stringify(snapshot),
        note: `learning round: ${stats.updated.length} weights adjusted from ${signals.length} signals`,
        ts,
      },
    );
  });

  log.info(`learning: ${stats.updated.length} weights adjusted from ${signals.length} signals`);
  return stats;
}

/**
 * The exploration budget (§19). Returns true when this slot should be spent on
 * exploration rather than exploitation, so behavioural learning can never
 * squeeze serendipity out entirely.
 */
export function shouldExplore(config: AppConfig, random: () => number = Math.random): boolean {
  return random() < config.pipeline.learning.exploration_fraction;
}

export function learnedWeights(db: Db): Array<{ scope: string; key: string; value: number; events: number }> {
  return db.all(`SELECT scope, key, value, events FROM learned_weights ORDER BY scope, ABS(value) DESC`);
}
