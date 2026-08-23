/**
 * Sample real article pairs and label them with the cheap model, producing the
 * fixture that clustering is tuned against.
 *
 * Clustering used to be tuned by moving one threshold and eyeballing the result.
 * That is how it ended up at 0.845, where 5 of 92,644 real pairs matched. This
 * builds a reproducible labelled set instead, stratified across the similarity
 * range so most of the labels sit near the decision boundary rather than in the
 * vast uninteresting tail of unrelated pairs.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { AiClient } from '../ai/client.js';
import { fromBlob, cosine } from '../embed/index.js';
import { parseLooseJson } from '../ai/json.js';
import { logger } from '../util/log.js';
import { loadEnvFile } from './_bootstrap.js';

const log = logger('cluster-pairs');

const LABELS = [
  'SAME_STORY_DUPLICATE',
  'SAME_STORY_DIFFERENT_PERSPECTIVE',
  'RELATED_TOPIC_DIFFERENT_STORY',
  'UNRELATED',
] as const;

/** Similarity bands, and how many pairs to draw from each. */
const STRATA: Array<{ min: number; max: number; take: number }> = [
  { min: 0.80, max: 1.01, take: 20 },
  { min: 0.70, max: 0.80, take: 45 },
  { min: 0.62, max: 0.70, take: 45 },
  { min: 0.55, max: 0.62, take: 35 },
  { min: 0.45, max: 0.55, take: 25 },
  { min: 0.30, max: 0.45, take: 20 },
  { min: 0.00, max: 0.30, take: 15 },
];

const SYSTEM = `You label pairs of news/blog articles for a story-clustering evaluation set.

Given two articles, decide how they relate:

- SAME_STORY_DUPLICATE: the same underlying story or artefact, told in substantially the same way. A syndicated copy, a rewrite, or routine coverage of one event that adds nothing distinct.
- SAME_STORY_DIFFERENT_PERSPECTIVE: the same underlying story or artefact, but one adds a meaningfully different angle -- original analysis, technical depth, criticism, reporting, or a distinct point of view. Someone interested in the story could gain from reading both.
- RELATED_TOPIC_DIFFERENT_STORY: same domain, subject or ongoing theme, but different specific stories or events.
- UNRELATED: no meaningful relationship.

The key line is between the first two: is the second article merely repeating the information, or genuinely adding a perspective?

Respond with JSON only: {"label": "<one of the four>", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const db = initDb(config.env.dbPath);
  const ai = new AiClient(config, db);

  const rows = db.all<{
    id: string; source_id: string; title: string; summary: string | null;
    t: number; vector: Uint8Array;
  }>(
    `SELECT fi.id, fi.source_id, fi.title, fi.rss_summary AS summary,
            COALESCE(fi.publication_time, fi.first_seen_at) AS t, e.vector
     FROM feed_items fi
     JOIN embeddings e ON e.owner_id = fi.id AND e.owner_type = 'item' AND e.model = :model
     WHERE fi.is_podcast = 0 AND fi.title IS NOT NULL`,
    { model: ai.modelFor('embedding') },
  );
  const items = rows.map((r) => ({ ...r, v: fromBlob(r.vector) }));
  log.info(`${items.length} items with embeddings`);

  const windowMs = config.pipeline.clustering.time_window_hours * 3_600_000;
  const pairs: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (Math.abs(items[i]!.t - items[j]!.t) > windowMs) continue;
      pairs.push({ a: i, b: j, sim: cosine(items[i]!.v, items[j]!.v) });
    }
  }
  log.info(`${pairs.length} pairs inside the ${config.pipeline.clustering.time_window_hours}h window`);

  // Deterministic stratified sample: sort inside each band and take evenly
  // spaced entries, so re-running produces the same fixture.
  const selected: Array<{ a: number; b: number; sim: number }> = [];
  for (const s of STRATA) {
    const band = pairs
      .filter((p) => p.sim >= s.min && p.sim < s.max)
      .sort((x, y) => y.sim - x.sim || (items[x.a]!.id < items[y.a]!.id ? -1 : 1));
    if (band.length === 0) continue;
    const step = Math.max(1, Math.floor(band.length / s.take));
    for (let k = 0; k < band.length && selected.length < 1000; k += step) {
      selected.push(band[k]!);
      if (selected.filter((p) => p.sim >= s.min && p.sim < s.max).length >= s.take) break;
    }
    log.info(`band ${s.min}-${s.max}: ${band.length} available, sampled ${Math.min(s.take, band.length)}`);
  }

  log.info(`labelling ${selected.length} pairs with ${ai.modelFor('cheap')}`);
  const out: unknown[] = [];
  const seen = new Set<string>();
  let done = 0;

  for (const p of selected) {
    const A = items[p.a]!;
    const B = items[p.b]!;
    const key = pairKey(A.id, B.id);
    if (seen.has(key)) continue;
    seen.add(key);

    const user = [
      `ARTICLE 1`,
      `Source: ${A.source_id}`,
      `Title: ${A.title}`,
      A.summary ? `Summary: ${A.summary.slice(0, 500)}` : '',
      '',
      `ARTICLE 2`,
      `Source: ${B.source_id}`,
      `Title: ${B.title}`,
      B.summary ? `Summary: ${B.summary.slice(0, 500)}` : '',
    ].filter(Boolean).join('\n');

    let label = 'UNRELATED';
    let confidence = 0;
    let reason = 'labelling failed';
    try {
      const res = await ai.complete('cheap', [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ], { jsonMode: true, maxTokens: 200 });
      const parsed = (parseLooseJson(res.text) ?? {}) as { label?: string; confidence?: number; reason?: string };
      if (parsed.label && (LABELS as readonly string[]).includes(parsed.label)) {
        label = parsed.label;
        confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
        reason = String(parsed.reason ?? '').slice(0, 200);
      }
    } catch (err) {
      log.warn(`pair ${key} failed`, err);
    }

    out.push({
      a: { id: A.id, source: A.source_id, title: A.title, published_at: A.t },
      b: { id: B.id, source: B.source_id, title: B.title, published_at: B.t },
      embedding_similarity: Number(p.sim.toFixed(4)),
      label,
      confidence,
      reason,
    });

    if (++done % 25 === 0) log.info(`  ${done}/${selected.length} (spent $${ai.spentUsd.toFixed(4)})`);
  }

  const path = resolve(process.cwd(), 'tests/fixtures/cluster-pairs.json');
  writeFileSync(path, JSON.stringify({
    generated_from: `${items.length} items, ${pairs.length} in-window pairs`,
    labeller: ai.modelFor('cheap'),
    note: 'Labels are model-generated, not human. Treat as a consistent reference for tuning, not ground truth.',
    pairs: out,
  }, null, 2));

  const counts: Record<string, number> = {};
  for (const o of out as Array<{ label: string }>) counts[o.label] = (counts[o.label] ?? 0) + 1;
  log.info(`wrote ${out.length} labelled pairs to ${path}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) log.info(`  ${k}: ${v}`);
  log.info(`labelling cost $${ai.spentUsd.toFixed(4)}`);
}

main().catch((err) => { log.error('cluster-pairs failed', err); process.exit(1); });
