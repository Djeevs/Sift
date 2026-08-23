import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { sourceCategories } from '../config/index.js';
import { cosine, fromBlob } from '../embed/index.js';
import { computeFreeScore, type Band, type FreeScoreInput, type FreeScoreResult } from './freeScore.js';
import { setStatus } from '../pipeline/journal.js';
import { sourceUniqueness, sourceItemCounts } from './sourceStats.js';
import { HOUR_MS } from '../util/time.js';
import { logger } from '../util/log.js';

const log = logger('free-rank');

/**
 * Stage 3 runner: score every rule-filtered item, band it, and decide who is
 * worth a Luna call.
 *
 * Order matters here. Items are scored per source, best first, so the volume
 * penalty can express diminishing returns; and the whole run is scored before any
 * band is assigned, so budget decisions see the full distribution.
 */

export interface FreeRankerStats {
  scored: number;
  byBand: Record<Band, number>;
  selectedForLuna: number;
  auditSelected: number;
  rejected: number;
  semanticProvider: string;
}

interface Candidate {
  id: string;
  source_id: string;
  title: string;
  subtitle: string | null;
  rss_summary: string | null;
  publication_time: number | null;
  first_seen_at: number;
  feed_categories_json: string;
  cluster_id: string | null;
  raw_feed_metadata: string | null;
  vector: Uint8Array | null;
}

/** A deterministic pseudo-random number in 0..1 from a string. Seedable audits. */
export function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function runFreeRanker(
  db: Db,
  config: AppConfig,
  options: {
    embeddingModel: string;
    semanticProvider: string;
    now?: number;
    /** Injectable for deterministic tests. */
    random?: (seed: string) => number;
  },
): FreeRankerStats {
  const now = options.now ?? Date.now();
  const random = options.random ?? hashUnit;
  const stats: FreeRankerStats = {
    scored: 0,
    byBand: { A: 0, B: 0, C: 0, D: 0 },
    selectedForLuna: 0,
    auditSelected: 0,
    rejected: 0,
    semanticProvider: options.semanticProvider,
  };

  const rows = db.all<Candidate>(
    `SELECT fi.id, fi.source_id, fi.title, fi.subtitle, fi.rss_summary, fi.publication_time,
            fi.first_seen_at, fi.feed_categories_json, fi.cluster_id, fi.raw_feed_metadata, e.vector
     FROM feed_items fi
     LEFT JOIN embeddings e
       ON e.owner_id = fi.id AND e.owner_type = 'item' AND e.model = :model
     WHERE fi.status = 'filtered' AND fi.is_podcast = 0
     ORDER BY COALESCE(fi.publication_time, fi.first_seen_at) DESC`,
    { model: options.embeddingModel },
  );
  if (rows.length === 0) return stats;

  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));
  const uniqueness = sourceUniqueness(db);
  const itemCounts = sourceItemCounts(db);

  // Anchor vectors, for interest and avoid similarity.
  const anchors = db.all<{ owner_id: string; vector: Uint8Array }>(
    `SELECT owner_id, vector FROM embeddings WHERE owner_type = 'anchor' AND model = :m`,
    { m: options.embeddingModel },
  );
  const avoidAnchors = db.all<{ owner_id: string; vector: Uint8Array }>(
    `SELECT owner_id, vector FROM embeddings WHERE owner_type = 'avoid_anchor' AND model = :m`,
    { m: options.embeddingModel },
  );
  const anchorVectors = anchors.map((a) => ({ id: a.owner_id, v: fromBlob(a.vector) }));
  const avoidVectors = avoidAnchors.map((a) => fromBlob(a.vector));

  // Anchors carry the category they belong to, so the closest anchor implies a
  // category when the feed gives no usable hint.
  const anchorCategory = new Map(config.taste.interest_anchors.map((a) => [a.id, a.category]));

  // --- Pass 1: per-item signals, before any cross-item comparison ------------
  interface Scored {
    row: Candidate;
    vector: Float32Array | null;
    anchorSimilarities: number[];
    avoidSimilarity: number;
    bestAnchorId: string | null;
    category: string;
    provisional: number;
  }

  const scoredItems: Scored[] = rows.map((row) => {
    const vector = row.vector ? fromBlob(row.vector) : null;
    const sims: number[] = [];
    let best = -1;
    let bestAnchorId: string | null = null;

    if (vector) {
      for (const anchor of anchorVectors) {
        const sim = cosine(vector, anchor.v);
        sims.push(sim);
        if (sim > best) {
          best = sim;
          bestAnchorId = anchor.id;
        }
      }
    }
    let avoid = 0;
    if (vector) for (const a of avoidVectors) avoid = Math.max(avoid, cosine(vector, a));

    const source = sourceMap.get(row.source_id);
    let feedCats: string[] = [];
    try {
      feedCats = JSON.parse(row.feed_categories_json) as string[];
    } catch {
      feedCats = [];
    }
    const category =
      source?.hard_rules?.force_category ??
      (bestAnchorId ? anchorCategory.get(bestAnchorId) : undefined) ??
      sourceCategories(source)[0] ??
      (feedCats.length ? 'other' : 'other');

    return {
      row,
      vector,
      anchorSimilarities: sims,
      avoidSimilarity: avoid,
      bestAnchorId,
      category: config.categories.includes(category) ? category : 'other',
      // Provisional ordering signal for the per-source ranking below.
      provisional: (source?.quality_prior ?? 0.5) + (sims.length ? Math.max(...sims) : 0),
    };
  });

  // --- Pass 2: per-source rank, for diminishing returns ---------------------
  const bySource = new Map<string, Scored[]>();
  for (const item of scoredItems) {
    const list = bySource.get(item.row.source_id) ?? [];
    list.push(item);
    bySource.set(item.row.source_id, list);
  }
  const rankInRun = new Map<string, number>();
  for (const [, list] of bySource) {
    list.sort((a, b) => b.provisional - a.provisional);
    list.forEach((item, index) => rankInRun.set(item.row.id, index + 1));
  }

  // --- Pass 3: redundancy against everything else in the window -------------
  // Cluster membership comes from the clustering stage; near-duplicate text is
  // detected here so the free score can see it before Luna is paid for.
  const clusterBest = new Map<string, number>();
  for (const item of scoredItems) {
    if (!item.row.cluster_id) continue;
    const current = clusterBest.get(item.row.cluster_id) ?? -1;
    if (item.provisional > current) clusterBest.set(item.row.cluster_id, item.provisional);
  }

  const windowMs = config.pipeline.clustering.time_window_hours * HOUR_MS;
  const nearest = new Map<string, number>();
  for (let i = 0; i < scoredItems.length; i += 1) {
    const a = scoredItems[i]!;
    if (!a.vector) continue;
    let maxSim = 0;
    for (let j = 0; j < scoredItems.length; j += 1) {
      if (i === j) continue;
      const b = scoredItems[j]!;
      if (!b.vector) continue;
      const ta = a.row.publication_time ?? a.row.first_seen_at;
      const tb = b.row.publication_time ?? b.row.first_seen_at;
      if (Math.abs(ta - tb) > windowMs) continue;
      const sim = cosine(a.vector, b.vector);
      if (sim > maxSim) maxSim = sim;
    }
    nearest.set(a.row.id, maxSim);
  }

  // --- Pass 4: the score ---------------------------------------------------
  const results: Array<{ item: Scored; result: FreeScoreResult }> = [];
  for (const item of scoredItems) {
    const source = sourceMap.get(item.row.source_id);
    const clusterTop = item.row.cluster_id ? clusterBest.get(item.row.cluster_id) : undefined;

    let discoverySignal = 0.5;
    try {
      const metadata = JSON.parse(item.row.raw_feed_metadata ?? '{}') as { discovery_signal?: unknown };
      const parsed = Number(metadata.discovery_signal);
      if (Number.isFinite(parsed)) discoverySignal = parsed;
    } catch {
      // Ordinary feeds have no discovery metadata and stay neutral.
    }

    const input: FreeScoreInput = {
      id: item.row.id,
      sourceId: item.row.source_id,
      title: item.row.title,
      subtitle: item.row.subtitle,
      summary: item.row.rss_summary,
      publicationTime: item.row.publication_time,
      firstSeenAt: item.row.first_seen_at,
      feedCategories: [],
      anchorSimilarities: item.anchorSimilarities,
      avoidSimilarity: item.avoidSimilarity,
      bestAnchorId: item.bestAnchorId,
      category: item.category,
      sourceRankInRun: rankInRun.get(item.row.id) ?? 1,
      sourceUniqueness: uniqueness.get(item.row.source_id) ?? 0.5,
      isRedundantInCluster: clusterTop !== undefined && clusterTop > item.provisional,
      nearestNeighbourSimilarity: nearest.get(item.row.id) ?? 0,
      sourceItemsSeen: itemCounts.get(item.row.source_id) ?? 0,
      semanticAvailable: item.vector !== null && anchorVectors.length > 0,
      discoverySignal,
    };

    results.push({ item, result: computeFreeScore(input, source, config, now) });
  }

  // --- Pass 5: banding, budget and audit sampling --------------------------
  results.sort((a, b) => b.result.free_score - a.result.free_score);

  const fr = config.free.free_ranking;
  let lunaBudget = fr.luna_budget_per_run;
  // Audit rates come from the active mode, not the ranking config: calibration
  // deliberately samples far more heavily than steady state, and that is a
  // spend decision rather than a ranking one.
  let auditBudget = config.mode.audit_max_per_run.free_to_luna;
  const ts = Date.now();

  db.transaction(() => {
    for (const { item, result } of results) {
      stats.scored += 1;
      stats.byBand[result.band] += 1;

      db.run(
        `INSERT INTO free_score_components (
            item_id, source_quality_prior, category_prior, keyword_interest_score,
            semantic_interest_score, freshness_score, editorial_type_score,
            discovery_signal, source_uniqueness_score, source_volume_penalty, redundancy_penalty,
            clickbait_penalty, negative_interest_penalty, free_score, band,
            editorial_type, content_type, best_anchor_id, anchor_distance,
            source_rank_in_run, semantic_provider, config_version, config_hash, created_at)
         VALUES (:id, :sq, :cp, :kw, :sem, :fresh, :ed, :discovery, :uniq, :vol, :redun, :click,
                 :neg, :score, :band, :etype, :ctype, :anchor, :dist, :rank, :prov,
                 :cver, :chash, :ts)
         ON CONFLICT(item_id) DO UPDATE SET
            source_quality_prior = excluded.source_quality_prior,
            category_prior = excluded.category_prior,
            keyword_interest_score = excluded.keyword_interest_score,
            semantic_interest_score = excluded.semantic_interest_score,
            freshness_score = excluded.freshness_score,
            editorial_type_score = excluded.editorial_type_score,
            discovery_signal = excluded.discovery_signal,
            source_uniqueness_score = excluded.source_uniqueness_score,
            source_volume_penalty = excluded.source_volume_penalty,
            redundancy_penalty = excluded.redundancy_penalty,
            clickbait_penalty = excluded.clickbait_penalty,
            negative_interest_penalty = excluded.negative_interest_penalty,
            free_score = excluded.free_score, band = excluded.band,
            editorial_type = excluded.editorial_type, content_type = excluded.content_type,
            best_anchor_id = excluded.best_anchor_id, anchor_distance = excluded.anchor_distance,
            source_rank_in_run = excluded.source_rank_in_run,
            semantic_provider = excluded.semantic_provider,
            config_version = excluded.config_version, config_hash = excluded.config_hash,
            created_at = excluded.created_at`,
        {
          id: item.row.id,
          sq: result.source_quality_prior,
          cp: result.category_prior,
          kw: result.keyword_interest_score,
          sem: result.semantic_interest_score,
          fresh: result.freshness_score,
          ed: result.editorial_type_score,
          discovery: result.discovery_signal,
          uniq: result.source_uniqueness_score,
          vol: result.source_volume_penalty,
          redun: result.redundancy_penalty,
          click: result.clickbait_penalty,
          neg: result.negative_interest_penalty,
          score: result.free_score,
          band: result.band,
          etype: result.editorialType,
          ctype: result.contentType,
          anchor: item.bestAnchorId,
          dist: result.anchorDistance,
          rank: item.row.id ? (rankInRun.get(item.row.id) ?? 1) : 1,
          prov: options.semanticProvider,
          cver: config.free.version,
          chash: config.hashes.ranking,
          ts,
        },
      );

      // Band A always gets a Luna call; band B while the budget lasts.
      let selected = false;
      let reason: string;
      if (result.band === 'A' && lunaBudget > 0) {
        selected = true;
        lunaBudget -= 1;
        reason = `band A (free_score ${result.free_score.toFixed(3)})`;
      } else if (result.band === 'B' && lunaBudget > 0) {
        selected = true;
        lunaBudget -= 1;
        reason = `band B within budget (free_score ${result.free_score.toFixed(3)})`;
      } else if (result.band === 'A' || result.band === 'B') {
        reason = `band ${result.band} but the run's Luna budget was spent`;
      } else {
        reason = `band ${result.band} (free_score ${result.free_score.toFixed(3)})`;
      }

      // Audit sampling: keep a slice of rejects so false negatives are measured
      // rather than assumed. Deterministic per item, so a rerun samples the same
      // items instead of quietly widening the audit.
      let auditSelected = false;
      if (!selected && auditBudget > 0) {
        // Band C is the population that nearly qualified, so it carries the
        // mode's full rate; band D is sampled far more thinly because almost
        // nothing there is a real miss and the calls are not free.
        const modeRate = config.mode.free_reject_audit_rate;
        const rate =
          result.band === 'C'
            ? modeRate
            : result.band === 'D'
              ? modeRate * (fr.audit.band_d_sample_rate / Math.max(fr.audit.band_c_sample_rate, 1e-6))
              : 0;
        if (rate > 0 && random(`free-audit:${item.row.id}`) < rate) {
          auditSelected = true;
          auditBudget -= 1;
          stats.auditSelected += 1;
          // Everything needed to answer "what kinds of good things are we
          // throwing away?" is captured now, while it is known. Recovering the
          // source, length or interest score of a reject afterwards is far
          // harder than writing it down here.
          db.run(
            `INSERT INTO audit_samples (item_id, boundary, normal_decision, audit_selected,
                                        audit_stage, audit_reason, band, free_score, sample_rate,
                                        source_id, semantic_interest, is_serendipity, content_type,
                                        word_count, source_prior, created_at)
             VALUES (:id, 'free_to_luna', :decision, 1, 'free_reject', :auditReason, :band, :score,
                     :rate, :source, :semantic, :serendipity, :contentType, :words, :prior, :ts)
             ON CONFLICT(item_id, boundary) DO UPDATE SET
               normal_decision = excluded.normal_decision, band = excluded.band,
               free_score = excluded.free_score, sample_rate = excluded.sample_rate,
               audit_stage = excluded.audit_stage, audit_reason = excluded.audit_reason,
               source_id = excluded.source_id, semantic_interest = excluded.semantic_interest,
               is_serendipity = excluded.is_serendipity, content_type = excluded.content_type,
               word_count = excluded.word_count, source_prior = excluded.source_prior`,
            {
              id: item.row.id,
              decision: `reject: ${reason}`,
              auditReason: `band ${result.band} sampled at ${(rate * 100).toFixed(1)}% (${config.modeName} mode)`,
              band: result.band,
              score: result.free_score,
              rate,
              source: item.row.source_id,
              semantic: result.semantic_interest_score,
              // Far from the interest anchors is exactly what Serendipity feeds
              // on, so a reject out there is the most interesting kind of miss.
              serendipity: result.anchorDistance >= 0.5 ? 1 : 0,
              contentType: result.contentType,
              words: null,
              prior: result.source_quality_prior,
              ts,
            },
          );
        }
      }

      if (selected || auditSelected) {
        stats.selectedForLuna += 1;
        setStatus(
          db,
          item.row.id,
          'free_ranked',
          auditSelected ? `${reason}; selected as a free-stage audit sample` : reason,
        );
      } else {
        stats.rejected += 1;
        setStatus(db, item.row.id, 'rejected_free', reason);
      }
    }
  });

  log.info(
    `free ranker: ${stats.scored} scored ` +
      `(A ${stats.byBand.A} / B ${stats.byBand.B} / C ${stats.byBand.C} / D ${stats.byBand.D}), ` +
      `${stats.selectedForLuna} to Luna incl. ${stats.auditSelected} audit`,
  );
  return stats;
}
