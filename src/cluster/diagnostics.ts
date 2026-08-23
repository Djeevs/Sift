/**
 * Clustering health metrics, and the evidence behind individual decisions.
 *
 * Clustering was silently inert for the system's whole life -- 495 clusters
 * holding 504 items -- because nothing ever reported on it. These are the
 * numbers that would have made that obvious.
 */
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';

export interface ClusteringStats {
  clusters: number;
  multiItemClusters: number;
  multiItemRate: number;
  averageSize: number;
  medianSize: number;
  largestSize: number;
  crossSourceItems: number;
  crossSourceRate: number;
  sameSourcePairs: number;
  crossSourcePairs: number;
  distinctMembers: number;
  nonSeedMembers: number;
  uniquenessCalibrated: boolean;
  uniquenessNote: string;
  largest: Array<{ cluster_id: string; cluster_topic: string | null; member_count: number }>;
}

export function clusteringStats(db: Db, config: AppConfig): ClusteringStats {
  const sizes = db
    .all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM story_cluster_members GROUP BY cluster_id ORDER BY n`,
      {},
    )
    .map((r) => r.n);

  const clusters = sizes.length;
  const members = sizes.reduce((a, b) => a + b, 0);
  const multi = sizes.filter((n) => n > 1);
  const itemsInMulti = multi.reduce((a, b) => a + b, 0);

  // Pairs of members inside one cluster, split by whether they came from the
  // same publisher. Cross-source pairs are the interesting ones: that is one
  // story covered twice rather than a source repeating itself.
  const pairRow = db.get<{ same: number; cross: number }>(
    `SELECT
       SUM(CASE WHEN a.source_id = b.source_id THEN 1 ELSE 0 END) AS same,
       SUM(CASE WHEN a.source_id <> b.source_id THEN 1 ELSE 0 END) AS cross
     FROM story_cluster_members ma
     JOIN story_cluster_members mb ON mb.cluster_id = ma.cluster_id AND mb.item_id > ma.item_id
     JOIN feed_items a ON a.id = ma.item_id
     JOIN feed_items b ON b.id = mb.item_id`,
    {},
  );

  const crossSourceItems = db.get<{ c: number }>(
    `SELECT COUNT(DISTINCT ma.item_id) AS c
     FROM story_cluster_members ma
     JOIN story_cluster_members mb ON mb.cluster_id = ma.cluster_id AND mb.item_id <> ma.item_id
     JOIN feed_items a ON a.id = ma.item_id
     JOIN feed_items b ON b.id = mb.item_id
     WHERE a.source_id <> b.source_id`,
    {},
  )?.c ?? 0;

  // Seed members joined at distance 1 by construction; they are not decisions.
  const nonSeed = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM story_cluster_members WHERE match_reason <> 'cluster seed'`,
    {},
  )?.c ?? 0;
  const distinct = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM story_cluster_members
     WHERE match_reason <> 'cluster seed' AND perspective_distance >= :t`,
    { t: config.pipeline.clustering.perspective.distinct_threshold },
  )?.c ?? 0;

  const cal = config.pipeline.learning.uniqueness_calibration;
  const multiRate = members === 0 ? 0 : itemsInMulti / members;

  // A source still sitting on the 0.5 prior has no clustering evidence behind
  // it. While many sources are in that state, uniqueness encodes "not enough
  // data yet" rather than a property of the source.
  const sourceCount = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM source_statistics`, {})?.c ?? 0;
  const noEvidence = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM source_statistics WHERE ABS(uniqueness - 0.5) < 0.001`,
    {},
  )?.c ?? 0;
  const noEvidenceRate = sourceCount === 0 ? 1 : noEvidence / sourceCount;

  const calibrated =
    multi.length >= cal.min_multi_item_clusters &&
    multiRate >= cal.min_multi_item_rate &&
    noEvidenceRate <= cal.max_sources_without_evidence;

  return {
    clusters,
    multiItemClusters: multi.length,
    multiItemRate: multiRate,
    averageSize: clusters === 0 ? 0 : members / clusters,
    medianSize: clusters === 0 ? 0 : sizes[Math.floor(clusters / 2)]!,
    largestSize: clusters === 0 ? 0 : sizes[clusters - 1]!,
    crossSourceItems,
    crossSourceRate: members === 0 ? 0 : crossSourceItems / members,
    sameSourcePairs: pairRow?.same ?? 0,
    crossSourcePairs: pairRow?.cross ?? 0,
    distinctMembers: distinct,
    nonSeedMembers: nonSeed,
    uniquenessCalibrated: calibrated,
    uniquenessNote: calibrated
      ? `(${multi.length} multi-item clusters, ${(multiRate * 100).toFixed(1)}% rate, ` +
        `${noEvidence} sources without evidence)`
      : `(needs >=${cal.min_multi_item_clusters} multi-item clusters [have ${multi.length}], ` +
        `>=${(cal.min_multi_item_rate * 100).toFixed(0)}% rate [have ${(multiRate * 100).toFixed(1)}%], ` +
        `and <=${(cal.max_sources_without_evidence * 100).toFixed(0)}% of sources without evidence ` +
        `[have ${(noEvidenceRate * 100).toFixed(0)}%, ${noEvidence} of ${sourceCount}])`,
    largest: db.all(
      `SELECT m.cluster_id, c.cluster_topic, COUNT(*) AS member_count
       FROM story_cluster_members m JOIN story_clusters c ON c.id = m.cluster_id
       GROUP BY m.cluster_id HAVING member_count > 1
       ORDER BY member_count DESC LIMIT 8`,
      {},
    ),
  };
}

export interface SampleCluster {
  cluster_id: string;
  members: Array<{
    item_id: string;
    source_id: string;
    title: string;
    match_reason: string;
    perspective_distance: number | null;
    signals_json: string | null;
  }>;
}

/** Multi-item clusters, so a decision can be read back and judged. */
export function sampleClusters(db: Db, limit = 6): SampleCluster[] {
  const ids = db.all<{ cluster_id: string }>(
    `SELECT cluster_id FROM story_cluster_members
     GROUP BY cluster_id HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, cluster_id LIMIT :n`,
    { n: limit },
  );
  return ids.map((row) => ({
    cluster_id: row.cluster_id,
    members: db.all(
      `SELECT m.item_id, fi.source_id, fi.title, m.match_reason, m.perspective_distance, m.signals_json
       FROM story_cluster_members m JOIN feed_items fi ON fi.id = m.item_id
       WHERE m.cluster_id = :c ORDER BY m.joined_at`,
      { c: row.cluster_id },
    ),
  }));
}
