import { initDb, type Db } from '../src/db/index.js';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { syncSources } from '../src/ingest/index.js';
import { stableId } from '../src/util/hash.js';
import { canonicalizeUrl } from '../src/util/url.js';
import { deterministicVector, toBlob } from '../src/embed/index.js';

/** An in-memory database with the real schema and the real config. */
export function testDb(): { db: Db; config: AppConfig } {
  const config = loadConfig();
  const db = initDb(':memory:');
  syncSources(db, config);
  return { db, config };
}

export interface SeedItem {
  id?: string;
  sourceId: string;
  title: string;
  url?: string;
  summary?: string;
  publishedAt?: number;
  isPodcast?: boolean;
  enclosureUrl?: string;
  enclosureType?: string;
  durationMinutes?: number;
  status?: string;
  clusterId?: string | null;
  images?: Array<{ url: string; alt?: string | null; caption?: string | null }>;
  itemKind?: 'article' | 'product';
}

export function seedItem(db: Db, item: SeedItem): string {
  const id = item.id ?? stableId('test', item.sourceId, item.title);
  const url = item.url ?? `https://example.com/${encodeURIComponent(item.title.slice(0, 40))}`;
  const ts = Date.now();
  db.run(
    `INSERT INTO feed_items (id, source_id, guid, original_url, canonical_url, title, rss_summary, language,
                             publication_time, feed_categories_json, enclosure_url, enclosure_type,
                             duration_minutes, feed_images_json, item_kind, is_podcast, first_seen_at, status, status_updated_at, cluster_id)
     VALUES (:id, :src, :id, :url, :canon, :title, :summary, 'en', :pub, '[]', :enc, :encType, :dur,
             :images, :kind, :podcast, :ts, :status, :ts, :cluster)
     ON CONFLICT(id) DO NOTHING`,
    {
      id,
      src: item.sourceId,
      url,
      canon: canonicalizeUrl(url),
      title: item.title,
      summary: item.summary ?? 'An English summary with enough detail for deterministic article language eligibility checks.',
      pub: item.publishedAt ?? ts,
      enc: item.enclosureUrl ?? null,
      encType: item.enclosureType ?? null,
      dur: item.durationMinutes ?? null,
      images: JSON.stringify(item.images ?? []),
      kind: item.itemKind ?? 'article',
      podcast: item.isPodcast ? 1 : 0,
      ts,
      status: item.status ?? 'embedded',
      cluster: item.clusterId ?? null,
    },
  );
  return id;
}

/** Give an item a deterministic embedding derived from text. */
export function seedVector(db: Db, itemId: string, text: string, model: string, dimensions = 256): void {
  const vector = deterministicVector(text, dimensions);
  db.run(
    `INSERT INTO embeddings (owner_type, owner_id, model, dimensions, vector, input_hash, created_at)
     VALUES ('item', :id, :m, :dim, :vec, :hash, :ts)
     ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET vector = excluded.vector`,
    { id: itemId, m: model, dim: dimensions, vec: toBlob(vector), hash: 'test', ts: Date.now() },
  );
}

export interface SeedDeepScores {
  personal_interest?: number;
  intellectual_depth?: number;
  novelty?: number;
  practical_usefulness?: number;
  entertainment?: number;
  storytelling?: number;
  authorial_voice?: number;
  critique?: number;
  humor?: number;
  obsessive_expertise?: number;
  rabbit_hole?: number;
  delight?: number;
  headline_sufficiency?: number;
  source_quality?: number;
  serendipity?: number;
  ragebait?: number;
  duplicate_information?: number;
  expected_attention_value?: number;
  anchor_distance?: number;
  category?: string;
  recommendedFeeds?: string[];
  why?: string;
}

export function seedDeepEvaluation(db: Db, itemId: string, scores: SeedDeepScores = {}): void {
  db.run(
    `INSERT INTO deep_evaluations (item_id, personal_interest, intellectual_depth, novelty,
        practical_usefulness, entertainment, storytelling, authorial_voice, critique, humor,
        obsessive_expertise, rabbit_hole, delight, headline_sufficiency, source_quality, serendipity, ragebait,
        duplicate_information, expected_attention_value, category, recommended_feeds_json,
        why_it_surfaced, anchor_distance, model, prompt_version, config_hash, created_at)
     VALUES (:id, :pi, :depth, :novelty, :useful, :fun, :story, :voice, :critique, :humor,
             :expertise, :rabbit, :delight, :headline, :quality, :ser, :rage, :dup, :eav,
             :cat, :feeds, :why, :dist, 'test-model', 'test-prompt', 'test-hash', :ts)
     ON CONFLICT(item_id) DO UPDATE SET expected_attention_value = excluded.expected_attention_value`,
    {
      id: itemId,
      pi: scores.personal_interest ?? 0.8,
      depth: scores.intellectual_depth ?? 0.8,
      novelty: scores.novelty ?? 0.8,
      useful: scores.practical_usefulness ?? 0.6,
      fun: scores.entertainment ?? 0.6,
      story: scores.storytelling ?? 0.65,
      voice: scores.authorial_voice ?? 0.65,
      critique: scores.critique ?? 0.55,
      humor: scores.humor ?? 0.35,
      expertise: scores.obsessive_expertise ?? 0.65,
      rabbit: scores.rabbit_hole ?? 0.6,
      delight: scores.delight ?? 0.65,
      headline: scores.headline_sufficiency ?? 0.1,
      quality: scores.source_quality ?? 0.8,
      ser: scores.serendipity ?? 0.2,
      rage: scores.ragebait ?? 0.02,
      dup: scores.duplicate_information ?? 0.05,
      eav: scores.expected_attention_value ?? 0.85,
      cat: scores.category ?? 'ai_product',
      feeds: JSON.stringify(scores.recommendedFeeds ?? []),
      why: scores.why ?? 'Explains a specific mechanism with concrete consequences.',
      dist: scores.anchor_distance ?? 0.4,
      ts: Date.now(),
    },
  );
}

export function seedCheapEvaluation(
  db: Db,
  itemId: string,
  opts: { passed?: boolean; score?: number; gist?: string; audit?: boolean } = {},
): void {
  db.run(
    `INSERT INTO cheap_evaluations (item_id, action, categories_json, interest_match, novelty_likelihood,
        junk_probability, gist, triage_score, threshold_used, passed, is_audit_sample,
        model, prompt_version, config_hash, created_at)
     VALUES (:id, 'KEEP', '["ai_product"]', 0.8, 0.7, 0.05, :gist, :score, 0.5, :passed, :audit,
             'test-model', 'test-prompt', 'test-hash', :ts)
     ON CONFLICT(item_id) DO UPDATE SET passed = excluded.passed`,
    {
      id: itemId,
      gist: opts.gist ?? null,
      score: opts.score ?? 0.8,
      passed: opts.passed === false ? 0 : 1,
      audit: opts.audit ? 1 : 0,
      ts: Date.now(),
    },
  );
}
