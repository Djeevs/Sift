import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { cosine, fromBlob } from '../embed/index.js';
import { titleSimilarity, namedEntities, jaccard, tokenize } from '../util/text.js';
import { canonicalizeUrl } from '../util/url.js';
import { stableId } from '../util/hash.js';
import {
  sameStorySignals,
  isSameStory,
  perspectiveDistance,
  type SameStorySignals,
} from './signals.js';
import { HOUR_MS } from '../util/time.js';
import { logger } from '../util/log.js';

const log = logger('cluster');

/**
 * Semantic story clustering (§11).
 *
 * Several publications covering one event become one cluster. Clustering does
 * *not* mean showing only one article: routing later allows a limited number of
 * genuinely different takes to survive, using the deep model's
 * duplicate_information score to tell recap from perspective.
 */

export interface ClusterCandidate {
  id: string;
  source_id: string;
  title: string;
  canonical_url: string | null;
  rss_summary: string | null;
  publication_time: number | null;
  first_seen_at: number;
  gist: string | null;
  cluster_id: string | null;
  vector: Float32Array | null;
}

export interface MatchResult {
  matched: boolean;
  similarity: number;
  reason: string;
}

/**
 * Are two items the same story? Pure function, so the rules are testable
 * without a database.
 */
export function compareItems(
  a: ClusterCandidate,
  b: ClusterCandidate,
  config: AppConfig,
): MatchResult {
  const c = config.pipeline.clustering;

  // Same canonical URL: the same article syndicated twice.
  if (a.canonical_url && b.canonical_url && a.canonical_url === b.canonical_url) {
    return { matched: true, similarity: 1, reason: 'canonical_url' };
  }

  // Publication timing. Items with no date fall back to when we first saw them.
  const timeA = a.publication_time ?? a.first_seen_at;
  const timeB = b.publication_time ?? b.first_seen_at;
  if (Math.abs(timeA - timeB) > c.time_window_hours * HOUR_MS) {
    return { matched: false, similarity: 0, reason: 'outside time window' };
  }

  const titleSim = titleSimilarity(a.title, b.title);
  if (titleSim >= c.title_similarity_threshold) {
    return { matched: true, similarity: titleSim, reason: `title similarity ${titleSim.toFixed(2)}` };
  }

  const embeddingSim = a.vector && b.vector ? cosine(a.vector, b.vector) : 0;
  if (embeddingSim >= c.similarity_threshold) {
    return { matched: true, similarity: embeddingSim, reason: `embedding ${embeddingSim.toFixed(3)}` };
  }

  // Entities plus a decent embedding score: two outlets describing one event
  // often share little headline wording but the same proper nouns.
  const entitiesA = new Set(namedEntities(`${a.title}. ${a.gist ?? ''}`));
  const entitiesB = new Set(namedEntities(`${b.title}. ${b.gist ?? ''}`));
  const entitySim = jaccard(entitiesA, entitiesB);
  if (entitySim >= 0.45 && embeddingSim >= c.similarity_threshold - 0.08) {
    return {
      matched: true,
      similarity: Math.max(embeddingSim, entitySim),
      reason: `entities ${entitySim.toFixed(2)} + embedding ${embeddingSim.toFixed(3)}`,
    };
  }

  // Two cheap-model gists describing the same thing.
  if (a.gist && b.gist) {
    const gistSim = jaccard(tokenize(a.gist), tokenize(b.gist));
    if (gistSim >= 0.6 && embeddingSim >= c.similarity_threshold - 0.1) {
      return { matched: true, similarity: gistSim, reason: `gist ${gistSim.toFixed(2)}` };
    }
  }

  return { matched: false, similarity: Math.max(titleSim, embeddingSim), reason: 'below thresholds' };
}

export interface ClusterStats {
  examined: number;
  newClusters: number;
  joined: number;
  clustersTotal: number;
}

function loadCandidates(db: Db, model: string, sinceMs: number): ClusterCandidate[] {
  const rows = db.all<{
    id: string;
    source_id: string;
    title: string;
    canonical_url: string | null;
    rss_summary: string | null;
    publication_time: number | null;
    first_seen_at: number;
    gist: string | null;
    cluster_id: string | null;
    vector: Uint8Array | null;
  }>(
    `SELECT fi.id, fi.source_id, fi.title, fi.canonical_url, fi.rss_summary, fi.publication_time,
            fi.first_seen_at, ce.gist, fi.cluster_id, e.vector
     FROM feed_items fi
     LEFT JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN embeddings e ON e.owner_id = fi.id AND e.owner_type = 'item' AND e.model = :model
     WHERE fi.is_podcast = 0
       AND COALESCE(fi.publication_time, fi.first_seen_at) >= :since
       AND fi.status NOT IN ('rejected_hard', 'skipped_duplicate')
     ORDER BY COALESCE(fi.publication_time, fi.first_seen_at) ASC`,
    { model, since: sinceMs },
  );

  return rows.map((r) => ({
    id: r.id,
    source_id: r.source_id,
    title: r.title,
    canonical_url: r.canonical_url,
    rss_summary: r.rss_summary,
    publication_time: r.publication_time,
    first_seen_at: r.first_seen_at,
    gist: r.gist,
    cluster_id: r.cluster_id,
    vector: r.vector ? fromBlob(r.vector) : null,
  }));
}

/**
 * Incremental single-link clustering over a rolling window. Each unclustered
 * item is compared against recent items; the best match wins its cluster.
 */
export function clusterRecentItems(
  db: Db,
  config: AppConfig,
  embeddingModel: string,
  opts: { allHistory?: boolean } = {},
): ClusterStats {
  const windowMs = config.pipeline.clustering.time_window_hours * HOUR_MS;
  // Look back over two windows so a late-arriving item can still find its story.
  const candidates = loadCandidates(db, embeddingModel, opts.allHistory ? 0 : Date.now() - windowMs * 2);
  const stats: ClusterStats = { examined: 0, newClusters: 0, joined: 0, clustersTotal: 0 };

  const clustered: ClusterCandidate[] = candidates.filter((c) => c.cluster_id);
  const unclustered = candidates.filter((c) => !c.cluster_id);
  const ts = Date.now();

  db.transaction(() => {
    for (const item of unclustered) {
      stats.examined += 1;

      let best: {
        candidate: ClusterCandidate;
        match: MatchResult;
        signals: SameStorySignals;
      } | null = null;
      for (const other of clustered) {
        if (other.id === item.id) continue;
        const signals = sameStorySignals(item, other, config);
        if (!isSameStory(signals, config)) continue;
        if (best && signals.confidence <= best.signals.confidence) continue;
        best = {
          candidate: other,
          signals,
          match: { matched: true, similarity: signals.confidence, reason: signals.reason },
        };
      }

      if (best?.candidate.cluster_id) {
        const clusterId = best.candidate.cluster_id;
        const perspective = perspectiveDistance(item, best.candidate, best.signals, config);
        addMember(db, clusterId, item.id, best.match, ts, best.signals, perspective);
        item.cluster_id = clusterId;
        clustered.push(item);
        stats.joined += 1;
        continue;
      }

      // No existing cluster: start one. Singleton clusters are normal and
      // cheap; most articles are the only coverage of their story.
      const clusterId = stableId('cluster', item.id);
      db.run(
        `INSERT INTO story_clusters (id, cluster_topic, representative_item_id, member_count, first_seen_at, last_updated_at)
         VALUES (:id, :topic, :rep, 0, :ts, :ts)
         ON CONFLICT(id) DO NOTHING`,
        { id: clusterId, topic: item.gist ?? item.title, rep: item.id, ts },
      );
      addMember(db, clusterId, item.id, { matched: true, similarity: 1, reason: 'cluster seed' }, ts, undefined, 1);
      item.cluster_id = clusterId;
      clustered.push(item);
      stats.newClusters += 1;
    }
  });

  const total = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM story_clusters`);
  stats.clustersTotal = total?.c ?? 0;
  log.info(`clustering: ${stats.newClusters} new, ${stats.joined} joined existing`);
  return stats;
}

function addMember(
  db: Db,
  clusterId: string,
  itemId: string,
  match: MatchResult,
  ts: number,
  signals?: SameStorySignals,
  perspective = 0,
): void {
  db.run(
    `INSERT INTO story_cluster_members
       (cluster_id, item_id, similarity, match_reason, signals_json, perspective_distance, joined_at)
     VALUES (:c, :i, :s, :r, :sig, :pd, :ts)
     ON CONFLICT(cluster_id, item_id) DO NOTHING`,
    {
      c: clusterId,
      i: itemId,
      s: match.similarity,
      r: match.reason,
      sig: signals ? JSON.stringify(signals) : null,
      pd: perspective,
      ts,
    },
  );
  db.run(`UPDATE feed_items SET cluster_id = :c WHERE id = :i`, { c: clusterId, i: itemId });
  db.run(
    `UPDATE story_clusters
     SET member_count = (SELECT COUNT(*) FROM story_cluster_members WHERE cluster_id = :c),
         last_updated_at = :ts
     WHERE id = :c`,
    { c: clusterId, ts },
  );
}

export interface ClusterMemberInfo {
  item_id: string;
  title: string;
  source_id: string;
  gist: string | null;
  why_it_surfaced: string | null;
  published: number;
}

/** Sibling coverage, given to the deep model so it can judge marginal value. */
export function clusterContext(db: Db, itemId: string, clusterId: string | null): ClusterMemberInfo[] {
  if (!clusterId) return [];
  return db.all<ClusterMemberInfo>(
    `SELECT m.item_id, fi.title, fi.source_id, ce.gist, de.why_it_surfaced,
            CASE WHEN EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = m.item_id)
                 THEN 1 ELSE 0 END AS published
     FROM story_cluster_members m
     JOIN feed_items fi ON fi.id = m.item_id
     LEFT JOIN cheap_evaluations ce ON ce.item_id = m.item_id
     LEFT JOIN deep_evaluations de ON de.item_id = m.item_id
     WHERE m.cluster_id = :c AND m.item_id != :i
     ORDER BY published DESC, m.joined_at ASC
     LIMIT 6`,
    { c: clusterId, i: itemId },
  );
}

/**
 * Limit how many members of one cluster reach the (expensive) deep model.
 * Returns the item ids allowed through, preferring the strongest triage scores
 * and always keeping items from distinct sources.
 */
export function limitClusterMembers(
  db: Db,
  config: AppConfig,
  itemIds: string[],
): { allowed: string[]; deferred: Array<{ id: string; reason: string }> } {
  if (itemIds.length === 0) return { allowed: [], deferred: [] };
  const max = config.final.terra_gate.cluster.max_members_per_run;

  const rows = db.all<{
    id: string;
    cluster_id: string | null;
    score: number;
    source_id: string;
    uniqueness: number;
    free_score: number;
    perspective_distance: number;
  }>(
    `SELECT fi.id, fi.cluster_id, COALESCE(ce.triage_score, f.free_score, 0) AS score,
            fi.source_id, COALESCE(ss.uniqueness, 0.5) AS uniqueness,
            COALESCE(f.free_score, 0) AS free_score,
            COALESCE(m.perspective_distance, 1) AS perspective_distance
     FROM feed_items fi
     LEFT JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN free_score_components f ON f.item_id = fi.id
     LEFT JOIN source_statistics ss ON ss.source_id = fi.source_id
     LEFT JOIN story_cluster_members m ON m.item_id = fi.id AND m.cluster_id = fi.cluster_id
     WHERE fi.id IN (${itemIds.map((_, i) => `:id${i}`).join(',')})
     ORDER BY score DESC`,
    Object.fromEntries(itemIds.map((id, i) => [`id${i}`, id])),
  );

  const perCluster = new Map<string, number>();
  // Best free score per cluster, so a later member can be compared against it.
  const clusterBestFree = new Map<string, number>();
  for (const row of rows) {
    if (!row.cluster_id) continue;
    const current = clusterBestFree.get(row.cluster_id) ?? 0;
    if (row.free_score > current) clusterBestFree.set(row.cluster_id, row.free_score);
  }
  const allowed: string[] = [];
  const deferred: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    if (!row.cluster_id) {
      allowed.push(row.id);
      continue;
    }
    // Count members of this cluster already evaluated in earlier runs, so the
    // limit holds across runs rather than only within one.
    const already =
      perCluster.get(row.cluster_id) ??
      db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM story_cluster_members m
         JOIN deep_evaluations d ON d.item_id = m.item_id
         WHERE m.cluster_id = :c`,
        { c: row.cluster_id },
      )?.c ??
      0;

    if (already >= max) {
      deferred.push({ id: row.id, reason: `cluster already has ${already} deep evaluations (max ${max})` });
      continue;
    }

    // The first member of a cluster goes through on its own merit. A second or
    // third has to justify the extra Terra call: either it reads as a genuinely
    // different take on the story, or it scored close to the best member. This
    // is what keeps the sceptical critique while dropping the commodity recap.
    //
    // The differentiation test used to be source uniqueness, which measured
    // nothing while clustering was inert -- every source looked unique because
    // nothing ever clustered. It is now the per-pair perspective distance
    // recorded when the item joined its cluster.
    if (already > 0) {
      const cfg = config.final.terra_gate.cluster;
      const best = clusterBestFree.get(row.cluster_id) ?? row.free_score;
      const ratio = best > 0 ? row.free_score / best : 1;
      const differentiated = row.perspective_distance >= config.pipeline.clustering.perspective.distinct_threshold;
      if (!differentiated && ratio < cfg.second_member_min_free_score_ratio) {
        deferred.push({
          id: row.id,
          reason:
            `commodity coverage of a story already queued: perspective distance ` +
            `${row.perspective_distance.toFixed(2)} < ` +
            `${config.pipeline.clustering.perspective.distinct_threshold} and ` +
            `free score ${(ratio * 100).toFixed(0)}% of the best member`,
        });
        continue;
      }
    }

    perCluster.set(row.cluster_id, already + 1);
    allowed.push(row.id);
  }

  return { allowed, deferred };
}

/** Used by the ingest path to spot an identical URL arriving from two feeds. */
export function findByCanonicalUrl(db: Db, url: string | null): string | null {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return null;
  const row = db.get<{ id: string }>(`SELECT id FROM feed_items WHERE canonical_url = :u LIMIT 1`, {
    u: canonical,
  });
  return row?.id ?? null;
}

/**
 * Drop every cluster and rebuild from scratch. Needed after changing clustering
 * weights: assignments are incremental, so old decisions would otherwise persist
 * and the new settings would only ever apply to newly arriving items.
 */
export function rebuildClusters(db: Db, config: AppConfig, embeddingModel: string): ClusterStats {
  db.transaction(() => {
    db.run(`DELETE FROM story_cluster_members`);
    db.run(`DELETE FROM story_clusters`);
    db.run(`UPDATE feed_items SET cluster_id = NULL`);
  });
  return clusterRecentItems(db, config, embeddingModel, { allHistory: true });
}
