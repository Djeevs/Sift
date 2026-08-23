import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import type { AiClient } from '../ai/client.js';
import type { SemanticProvider } from './provider.js';
import { sha256 } from '../util/hash.js';
import { truncate, collapseWhitespace } from '../util/text.js';
import { chunk } from '../util/pool.js';
import { logger } from '../util/log.js';

const log = logger('embed');

/**
 * Embeddings are stored as raw float32 blobs in SQLite and compared in JS.
 * At personal scale (tens of thousands of vectors) a brute-force cosine scan
 * takes single-digit milliseconds, which is far cheaper in complexity terms
 * than running a vector database for one user.
 */

export type OwnerType = 'item' | 'anchor' | 'avoid_anchor' | 'podcast_episode';

export function toBlob(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // The stored buffer may not be 4-byte aligned; copy defensively.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The compact representation we embed for an item (§8). */
export function itemEmbeddingText(
  item: { title: string; subtitle: string | null; rss_summary: string | null },
  sourceName: string,
  config: AppConfig,
): string {
  const parts: string[] = [];
  if (config.free.free_ranking.semantic.include_source_name) parts.push(sourceName);
  parts.push(item.title);
  if (item.subtitle) parts.push(item.subtitle);
  if (item.rss_summary) parts.push(item.rss_summary);
  return truncate(collapseWhitespace(parts.filter(Boolean).join('\n')), config.free.free_ranking.semantic.max_chars);
}

export interface StoredVector {
  ownerId: string;
  vector: Float32Array;
}

export function getVector(db: Db, ownerType: OwnerType, ownerId: string, model: string): Float32Array | null {
  const row = db.get<{ vector: Uint8Array }>(
    `SELECT vector FROM embeddings WHERE owner_type = :t AND owner_id = :id AND model = :m`,
    { t: ownerType, id: ownerId, m: model },
  );
  return row ? fromBlob(row.vector) : null;
}

export function getVectors(db: Db, ownerType: OwnerType, model: string, ownerIds?: string[]): StoredVector[] {
  if (ownerIds && ownerIds.length === 0) return [];
  const rows = ownerIds
    ? db.all<{ owner_id: string; vector: Uint8Array }>(
        `SELECT owner_id, vector FROM embeddings
         WHERE owner_type = :t AND model = :m AND owner_id IN (${ownerIds.map((_, i) => `:id${i}`).join(',')})`,
        { t: ownerType, m: model, ...Object.fromEntries(ownerIds.map((id, i) => [`id${i}`, id])) },
      )
    : db.all<{ owner_id: string; vector: Uint8Array }>(
        `SELECT owner_id, vector FROM embeddings WHERE owner_type = :t AND model = :m`,
        { t: ownerType, m: model },
      );
  return rows.map((r) => ({ ownerId: r.owner_id, vector: fromBlob(r.vector) }));
}

function storeVector(
  db: Db,
  ownerType: OwnerType,
  ownerId: string,
  model: string,
  vector: number[],
  inputHash: string,
): void {
  db.run(
    `INSERT INTO embeddings (owner_type, owner_id, model, dimensions, vector, input_hash, created_at)
     VALUES (:t, :id, :m, :dim, :vec, :hash, :ts)
     ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET
       vector = excluded.vector, dimensions = excluded.dimensions,
       input_hash = excluded.input_hash, created_at = excluded.created_at`,
    {
      t: ownerType,
      id: ownerId,
      m: model,
      dim: vector.length,
      vec: toBlob(vector),
      hash: inputHash,
      ts: Date.now(),
    },
  );
}

/**
 * Embed a set of (id, text) pairs, skipping anything whose text is unchanged.
 * This is what makes reruns free rather than merely idempotent.
 */
export async function embedMany(
  db: Db,
  ai: AiClient,
  config: AppConfig,
  ownerType: OwnerType,
  entries: Array<{ id: string; text: string }>,
  /**
   * The model key vectors are stored under. Must be the *resolved provider's* key,
   * not ai.modelFor('embedding'): when the provider falls back to `hash` those two
   * differ, and writing under one while reading under the other silently produces
   * a pipeline with no semantic signal at all.
   */
  modelKey?: string,
  provider?: SemanticProvider,
): Promise<{ embedded: number; skipped: number; failed: number }> {
  const model = modelKey ?? ai.modelFor('embedding');
  const stats = { embedded: 0, skipped: 0, failed: 0 };
  if (entries.length === 0) return stats;

  const pending: Array<{ id: string; text: string; hash: string }> = [];
  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) {
      stats.skipped += 1;
      continue;
    }
    const hash = sha256(`${model}|${text}`).slice(0, 16);
    const existing = db.get<{ input_hash: string }>(
      `SELECT input_hash FROM embeddings WHERE owner_type = :t AND owner_id = :id AND model = :m`,
      { t: ownerType, id: entry.id, m: model },
    );
    if (existing?.input_hash === hash) {
      stats.skipped += 1;
      continue;
    }
    pending.push({ id: entry.id, text, hash });
  }

  if (pending.length === 0) return stats;

  // A provider that cannot call an API (hash, or openai in a dry run) still
  // produces vectors, so clustering and near-duplicate detection keep working.
  if (!provider && ai.dryRun) {
    for (const p of pending) {
      const dimensions = config.models.models.embeddings.dimensions ?? 1536;
      storeVector(db, ownerType, p.id, model, deterministicVector(p.text, dimensions), p.hash);
      stats.embedded += 1;
    }
    log.debug(`dry run: stored ${stats.embedded} deterministic vectors`);
    return stats;
  }

  for (const batch of chunk(pending, config.models.models.embeddings.batch_size)) {
    try {
      const vectors = provider
        ? (await provider.embed(batch.map((b) => b.text))).map((v) => v ?? undefined)
        : (await ai.embed(batch.map((b) => b.text))).vectors;
      db.transaction(() => {
        batch.forEach((entry, i) => {
          const vec = vectors[i];
          if (!vec) {
            stats.failed += 1;
            return;
          }
          storeVector(db, ownerType, entry.id, model, vec, entry.hash);
          stats.embedded += 1;
        });
      });
    } catch (err) {
      stats.failed += batch.length;
      log.error(`embedding batch of ${batch.length} failed`, err);
    }
  }

  log.info(`embeddings: ${stats.embedded} new, ${stats.skipped} unchanged, ${stats.failed} failed`);
  return stats;
}

/**
 * A stable pseudo-embedding used when SIFT_DRY_RUN=1, so the whole pipeline
 * (clustering, serendipity distance, dedup) can be exercised without an API key.
 */
export function deterministicVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let h = 0;
    for (let i = 0; i < token.length; i += 1) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    vector[h % dimensions]! += 1;
    vector[(h >>> 7) % dimensions]! += 0.5;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/**
 * Embed the interest and avoid anchors from taste-profile.yaml, under the same
 * model key as the items they will be compared against.
 */
export async function embedAnchors(
  db: Db,
  ai: AiClient,
  config: AppConfig,
  modelKey?: string,
  provider?: SemanticProvider,
): Promise<void> {
  await embedMany(
    db,
    ai,
    config,
    'anchor',
    config.taste.interest_anchors.map((a) => ({ id: a.id, text: a.text })),
    modelKey,
    provider,
  );
  await embedMany(
    db,
    ai,
    config,
    'avoid_anchor',
    config.taste.avoid_anchors.map((a) => ({ id: a.id, text: a.text })),
    modelKey,
    provider,
  );
}

export interface AnchorMatch {
  bestAnchorId: string | null;
  bestSimilarity: number;
  /** Mean of the top 3, a steadier signal than the single best match. */
  topMeanSimilarity: number;
  avoidSimilarity: number;
  /** 1 - topMean, the "distance from established interests" serendipity needs. */
  distance: number;
}

export function matchAnchors(
  vector: Float32Array,
  anchors: StoredVector[],
  avoidAnchors: StoredVector[],
): AnchorMatch {
  let bestAnchorId: string | null = null;
  let best = -1;
  const sims: number[] = [];
  for (const anchor of anchors) {
    const sim = cosine(vector, anchor.vector);
    sims.push(sim);
    if (sim > best) {
      best = sim;
      bestAnchorId = anchor.ownerId;
    }
  }
  sims.sort((a, b) => b - a);
  const top = sims.slice(0, 3);
  const topMean = top.length ? top.reduce((s, v) => s + v, 0) / top.length : 0;

  let avoid = 0;
  for (const a of avoidAnchors) avoid = Math.max(avoid, cosine(vector, a.vector));

  return {
    bestAnchorId,
    bestSimilarity: best < 0 ? 0 : best,
    topMeanSimilarity: topMean,
    avoidSimilarity: Math.max(0, avoid),
    distance: Math.max(0, Math.min(1, 1 - topMean)),
  };
}
