import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { logger } from '../util/log.js';

const log = logger('source-stats');

/**
 * Empirical source statistics: uniqueness, overlap and historical value.
 *
 * These are learned and stored separately from the priors in sources.yaml, and
 * never overwrite them. Both are read at scoring time.
 *
 * The smoothing matters more than the arithmetic. Two excellent posts out of two
 * must not make a source "perfect", so every learned value is pulled toward the
 * global mean until enough evidence accumulates (`prior_strength`).
 */

export interface SourceStatsSummary {
  source_id: string;
  items_seen: number;
  items_surfaced: number;
  items_opened: number;
  explicit_positive: number;
  explicit_negative: number;
  learned_value: number;
  uniqueness: number;
  mean_terra_value: number | null;
}

/** How many items each source has ever contributed. Drives exploration. */
export function sourceItemCounts(db: Db): Map<string, number> {
  const rows = db.all<{ source_id: string; c: number }>(
    `SELECT source_id, COUNT(*) AS c FROM feed_items GROUP BY source_id`,
  );
  return new Map(rows.map((r) => [r.source_id, r.c]));
}

/** Stored uniqueness per source, defaulting to 0.5 where unknown. */
export function sourceUniqueness(db: Db): Map<string, number> {
  const rows = db.all<{ source_id: string; uniqueness: number }>(
    `SELECT source_id, uniqueness FROM source_statistics`,
  );
  return new Map(rows.map((r) => [r.source_id, r.uniqueness]));
}

export function learnedSourceValues(db: Db): Map<string, number> {
  const rows = db.all<{ source_id: string; learned_value: number }>(
    `SELECT source_id, learned_value FROM source_statistics`,
  );
  return new Map(rows.map((r) => [r.source_id, r.learned_value]));
}

/**
 * Recompute uniqueness from cluster history.
 *
 *   uniqueness = 1 - (items redundant with another source's coverage / clustered items)
 *
 * "Redundant" means: this item shared a cluster with an item from a *different*
 * source. Note what this deliberately does not do -- it does not punish a source
 * for covering an important story everyone covered. Every member of such a cluster
 * counts as redundant, including the best one, so a source is only marked
 * low-uniqueness when it is *consistently* one of several voices rather than
 * occasionally. The useful distinction is commodity reporting versus
 * differentiated analysis, and consistency is what separates them.
 */
export function recomputeSourceUniqueness(db: Db, priorStrength = 8): number {
  const rows = db.all<{ source_id: string; clustered: number; redundant: number }>(
    `SELECT fi.source_id,
            COUNT(*) AS clustered,
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM story_cluster_members m2
                  JOIN feed_items fi2 ON fi2.id = m2.item_id
                  WHERE m2.cluster_id = m.cluster_id AND fi2.source_id != fi.source_id
                ) THEN 1 ELSE 0 END) AS redundant
     FROM story_cluster_members m
     JOIN feed_items fi ON fi.id = m.item_id
     GROUP BY fi.source_id`,
  );

  const ts = Date.now();
  let updated = 0;
  db.transaction(() => {
    for (const row of rows) {
      // With little history, sit near the neutral 0.5 rather than claiming a
      // source is perfectly unique because its two items happened not to cluster.
      const evidence = row.clustered;
      const raw = evidence > 0 ? 1 - row.redundant / evidence : 0.5;
      const smoothed = (raw * evidence + 0.5 * priorStrength) / (evidence + priorStrength);

      db.run(
        `INSERT INTO source_statistics (source_id, uniqueness, clustered_items, redundant_items, updated_at)
         VALUES (:id, :u, :c, :r, :ts)
         ON CONFLICT(source_id) DO UPDATE SET
           uniqueness = excluded.uniqueness,
           clustered_items = excluded.clustered_items,
           redundant_items = excluded.redundant_items,
           updated_at = excluded.updated_at`,
        { id: row.source_id, u: smoothed, c: row.clustered, r: row.redundant, ts },
      );
      updated += 1;
    }
  });
  return updated;
}

/**
 * Recompute pairwise source overlap from shared clusters. Two sources that keep
 * covering the same stories carry correlated information, which the final ranker
 * uses to discount the second one once the first has contributed.
 */
export function recomputeSourceOverlap(db: Db): number {
  const rows = db.all<{ source_a: string; source_b: string; shared: number }>(
    `SELECT a.source_id AS source_a, b.source_id AS source_b, COUNT(DISTINCT m1.cluster_id) AS shared
     FROM story_cluster_members m1
     JOIN feed_items a ON a.id = m1.item_id
     JOIN story_cluster_members m2 ON m2.cluster_id = m1.cluster_id
     JOIN feed_items b ON b.id = m2.item_id
     WHERE a.source_id < b.source_id
     GROUP BY a.source_id, b.source_id`,
  );

  const clusterCounts = new Map(
    db
      .all<{ source_id: string; c: number }>(
        `SELECT fi.source_id, COUNT(DISTINCT m.cluster_id) AS c
         FROM story_cluster_members m JOIN feed_items fi ON fi.id = m.item_id
         GROUP BY fi.source_id`,
      )
      .map((r) => [r.source_id, r.c]),
  );

  const ts = Date.now();
  let updated = 0;
  db.transaction(() => {
    db.run(`DELETE FROM source_overlap_statistics`);
    for (const row of rows) {
      const a = clusterCounts.get(row.source_a) ?? 0;
      const b = clusterCounts.get(row.source_b) ?? 0;
      const denominator = Math.min(a, b);
      // Overlap as a share of the *smaller* source's coverage: a small
      // specialist that always shadows a large outlet is highly correlated with
      // it, even though the large one is mostly doing other things.
      const overlap = denominator > 0 ? Math.min(1, row.shared / denominator) : 0;
      db.run(
        `INSERT INTO source_overlap_statistics (source_a, source_b, shared_clusters, a_clusters, b_clusters, overlap, updated_at)
         VALUES (:a, :b, :shared, :ac, :bc, :o, :ts)
         ON CONFLICT(source_a, source_b) DO UPDATE SET
           shared_clusters = excluded.shared_clusters, a_clusters = excluded.a_clusters,
           b_clusters = excluded.b_clusters, overlap = excluded.overlap, updated_at = excluded.updated_at`,
        { a: row.source_a, b: row.source_b, shared: row.shared, ac: a, bc: b, o: overlap, ts },
      );
      updated += 1;
    }
  });
  return updated;
}

export interface OverlapPair {
  partner: string;
  overlap: number;
  shared: number;
}

/** Sources correlated with the given one, above the configured evidence floor. */
export function correlatedSources(db: Db, config: AppConfig): Map<string, OverlapPair[]> {
  const min = config.final.final_ranking.correlation.min_shared_clusters;
  const rows = db.all<{ source_a: string; source_b: string; overlap: number; shared_clusters: number }>(
    `SELECT source_a, source_b, overlap, shared_clusters FROM source_overlap_statistics
     WHERE shared_clusters >= :min`,
    { min },
  );
  const map = new Map<string, OverlapPair[]>();
  const add = (from: string, to: string, overlap: number, shared: number) => {
    const list = map.get(from) ?? [];
    list.push({ partner: to, overlap, shared });
    map.set(from, list);
  };
  for (const r of rows) {
    add(r.source_a, r.source_b, r.overlap, r.shared_clusters);
    add(r.source_b, r.source_a, r.overlap, r.shared_clusters);
  }
  return map;
}

/**
 * Recompute learned source value from feedback, with Bayesian-style smoothing.
 *
 * value_per_item = sum(signal values) / items_surfaced, smoothed toward 0 by
 * prior_strength pseudo-observations, then squashed into the configured bounds.
 * The result moves slowly by construction: a source needs sustained evidence, not
 * a good week.
 *
 * Ragebait clicks are excluded upstream (see learn/index.ts) so engagement on
 * manipulative content cannot raise a source's value.
 */
export function recomputeSourceValue(db: Db, config: AppConfig): number {
  const cfg = config.pipeline.learning;
  const vf = cfg.value_function;

  const rows = db.all<{
    source_id: string;
    items_seen: number;
    surfaced: number;
    opened: number;
    positive: number;
    negative: number;
    mean_terra: number | null;
    terra_count: number;
  }>(
    `SELECT s.id AS source_id,
            (SELECT COUNT(*) FROM feed_items fi WHERE fi.source_id = s.id) AS items_seen,
            (SELECT COUNT(DISTINCT p.item_id) FROM published_feed_items p
               JOIN feed_items fi ON fi.id = p.item_id WHERE fi.source_id = s.id) AS surfaced,
            (SELECT COUNT(DISTINCT o.item_id) FROM open_events o
               JOIN feed_items fi ON fi.id = o.item_id
               LEFT JOIN deep_evaluations de ON de.item_id = o.item_id
               WHERE fi.source_id = s.id
                 AND COALESCE(de.ragebait, 0) <= :rageMax) AS opened,
            (SELECT COUNT(*) FROM explicit_feedback f
               JOIN feed_items fi ON fi.id = f.item_id
               WHERE fi.source_id = s.id AND f.signal = 'excellent') AS positive,
            (SELECT COUNT(*) FROM explicit_feedback f
               JOIN feed_items fi ON fi.id = f.item_id
               WHERE fi.source_id = s.id AND f.signal = 'not_for_me') AS negative,
            (SELECT AVG(de.expected_attention_value) FROM deep_evaluations de
               JOIN feed_items fi ON fi.id = de.item_id WHERE fi.source_id = s.id) AS mean_terra,
            (SELECT COUNT(*) FROM deep_evaluations de
               JOIN feed_items fi ON fi.id = de.item_id WHERE fi.source_id = s.id) AS terra_count
     FROM sources s`,
    { rageMax: cfg.ignore_opens_when_ragebait_above },
  );

  const ts = Date.now();
  let updated = 0;

  db.transaction(() => {
    for (const row of rows) {
      const rawTotal =
        row.surfaced * vf.surfaced +
        row.opened * vf.opened +
        row.positive * vf.explicit_positive +
        row.negative * vf.explicit_negative;

      // Observations = items actually surfaced: a source cannot be judged on
      // items the reader never saw.
      const observations = row.surfaced;
      const perItem = observations > 0 ? rawTotal / observations : 0;

      // Smooth toward 0 (neutral) with prior_strength pseudo-observations.
      const smoothed = (perItem * observations) / (observations + cfg.prior_strength);

      // Normalise into the configured range. The bound is asymptotic on purpose:
      // a source whose every item is marked excellent approaches the maximum but
      // only reaches it with unbounded evidence, because smoothing always holds
      // back a share proportional to prior_strength. A perfect record over a
      // dozen items should look good, not finished.
      const scale = Math.max(1, Math.abs(vf.explicit_positive));
      const bounded = Math.max(
        cfg.min_learned_source_value,
        Math.min(cfg.max_learned_source_value, (smoothed / scale) * cfg.max_learned_source_value),
      );

      db.run(
        `INSERT INTO source_statistics (source_id, items_seen, items_surfaced, items_opened,
                                        explicit_positive, explicit_negative, learned_value,
                                        mean_terra_value, terra_evaluations, updated_at)
         VALUES (:id, :seen, :surfaced, :opened, :pos, :neg, :value, :terra, :tcount, :ts)
         ON CONFLICT(source_id) DO UPDATE SET
           items_seen = excluded.items_seen, items_surfaced = excluded.items_surfaced,
           items_opened = excluded.items_opened, explicit_positive = excluded.explicit_positive,
           explicit_negative = excluded.explicit_negative, learned_value = excluded.learned_value,
           mean_terra_value = excluded.mean_terra_value,
           terra_evaluations = excluded.terra_evaluations, updated_at = excluded.updated_at`,
        {
          id: row.source_id,
          seen: row.items_seen,
          surfaced: row.surfaced,
          opened: row.opened,
          pos: row.positive,
          neg: row.negative,
          value: bounded,
          terra: row.mean_terra,
          tcount: row.terra_count,
          ts,
        },
      );
      updated += 1;
    }
  });

  return updated;
}

/** Per-source-per-category learned value, for category_priors to lean on. */
export function recomputeSourceCategoryValue(db: Db, config: AppConfig): number {
  const cfg = config.pipeline.learning;
  const vf = cfg.value_function;

  const rows = db.all<{
    source_id: string;
    category: string;
    seen: number;
    surfaced: number;
    positive: number;
    negative: number;
  }>(
    `SELECT fi.source_id, COALESCE(de.category, 'other') AS category,
            COUNT(*) AS seen,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = fi.id)
                     THEN 1 ELSE 0 END) AS surfaced,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM explicit_feedback f
                                  WHERE f.item_id = fi.id AND f.signal = 'excellent')
                     THEN 1 ELSE 0 END) AS positive,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM explicit_feedback f
                                  WHERE f.item_id = fi.id AND f.signal = 'not_for_me')
                     THEN 1 ELSE 0 END) AS negative
     FROM feed_items fi
     JOIN deep_evaluations de ON de.item_id = fi.id
     GROUP BY fi.source_id, category`,
  );

  const ts = Date.now();
  db.transaction(() => {
    for (const row of rows) {
      const total = row.positive * vf.explicit_positive + row.negative * vf.explicit_negative;
      const observations = Math.max(row.surfaced, 0);
      const smoothed =
        observations > 0 ? total / (observations + cfg.prior_strength) / Math.max(1, vf.explicit_positive) : 0;
      db.run(
        `INSERT INTO source_category_statistics (source_id, category, items_seen, items_surfaced,
                                                 explicit_positive, explicit_negative, learned_value, updated_at)
         VALUES (:s, :c, :seen, :surfaced, :pos, :neg, :value, :ts)
         ON CONFLICT(source_id, category) DO UPDATE SET
           items_seen = excluded.items_seen, items_surfaced = excluded.items_surfaced,
           explicit_positive = excluded.explicit_positive,
           explicit_negative = excluded.explicit_negative,
           learned_value = excluded.learned_value, updated_at = excluded.updated_at`,
        {
          s: row.source_id,
          c: row.category,
          seen: row.seen,
          surfaced: row.surfaced,
          pos: row.positive,
          neg: row.negative,
          value: smoothed,
          ts,
        },
      );
    }
  });
  return rows.length;
}

/** Refresh everything derived. Cheap, deterministic, safe to run every pipeline. */
export function refreshSourceStatistics(db: Db, config: AppConfig): Record<string, number> {
  const uniqueness = recomputeSourceUniqueness(db, config.pipeline.learning.uniqueness_prior_strength);
  const overlap = recomputeSourceOverlap(db);
  const value = recomputeSourceValue(db, config);
  const categoryValue = recomputeSourceCategoryValue(db, config);
  log.info(`source stats: ${uniqueness} uniqueness, ${overlap} overlap pairs, ${value} values`);
  return { uniqueness, overlap, value, categoryValue };
}

export function sourceStatsSummary(db: Db): SourceStatsSummary[] {
  return db.all<SourceStatsSummary>(
    `SELECT source_id, items_seen, items_surfaced, items_opened, explicit_positive,
            explicit_negative, learned_value, uniqueness, mean_terra_value
     FROM source_statistics ORDER BY items_surfaced DESC, items_seen DESC`,
  );
}
