/**
 * Measure same-story detection against the labelled pair fixture.
 *
 * This is the feedback loop clustering lacked. Run it after changing any
 * clustering weight or threshold; `--sweep` explores the confidence cut so the
 * choice is made from a curve rather than a guess.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { fromBlob } from '../embed/index.js';
import { sameStorySignals, perspectiveDistance, type SignalInput } from '../cluster/signals.js';
import { loadEnvFile } from './_bootstrap.js';

interface LabelledPair {
  a: { id: string; source: string; title: string; published_at: number };
  b: { id: string; source: string; title: string; published_at: number };
  embedding_similarity: number;
  label: string;
  confidence: number;
  reason: string;
}

function loadInputs(config: AppConfig): Map<string, SignalInput> {
  const db = initDb(config.env.dbPath);
  const rows = db.all<{
    id: string; source_id: string; title: string; canonical_url: string | null;
    rss_summary: string | null; publication_time: number | null; first_seen_at: number;
    gist: string | null; vector: Uint8Array | null;
  }>(
    `SELECT fi.id, fi.source_id, fi.title, fi.canonical_url, fi.rss_summary,
            fi.publication_time, fi.first_seen_at, ce.gist, e.vector
     FROM feed_items fi
     LEFT JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN embeddings e ON e.owner_id = fi.id AND e.owner_type = 'item'`,
    {},
  );
  const map = new Map<string, SignalInput>();
  for (const r of rows) {
    map.set(r.id, { ...r, vector: r.vector ? fromBlob(r.vector) : null });
  }
  return map;
}

function prf(tp: number, fp: number, fn: number): { p: number; r: number; f1: number } {
  const p = tp + fp === 0 ? 0 : tp / (tp + fp);
  const r = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { p, r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r) };
}

function main(): void {
  loadEnvFile();
  const config = loadConfig();
  const path = resolve(process.cwd(), 'tests/fixtures/cluster-pairs.json');
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as { pairs: LabelledPair[]; note?: string };
  const inputs = loadInputs(config);

  const scored = fixture.pairs
    .map((p) => {
      const a = inputs.get(p.a.id);
      const b = inputs.get(p.b.id);
      if (!a || !b) return null;
      const signals = sameStorySignals(a, b, config);
      return { pair: p, signals, perspective: perspectiveDistance(a, b, signals, config) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  console.log(`labelled pairs: ${fixture.pairs.length}, resolvable against the database: ${scored.length}`);
  if (fixture.note) console.log(`note: ${fixture.note}`);

  const isPositive = (label: string): boolean => label.startsWith('SAME_STORY');
  const sweep = process.argv.includes('--sweep');
  const thresholds = sweep
    ? [0.25, 0.30, 0.34, 0.38, 0.40, 0.42, 0.45, 0.48, 0.52, 0.56, 0.60, 0.65]
    : [config.pipeline.clustering.same_story_confidence];

  console.log('\nsame-story detection (SAME_STORY_* treated as positive)');
  console.log('  conf    TP   FP   FN   precision  recall      F1');
  for (const t of thresholds) {
    let tp = 0, fp = 0, fn = 0;
    for (const s of scored) {
      const predicted = s.signals.confidence >= t;
      const actual = isPositive(s.pair.label);
      if (predicted && actual) tp++;
      else if (predicted && !actual) fp++;
      else if (!predicted && actual) fn++;
    }
    const m = prf(tp, fp, fn);
    const mark = t === config.pipeline.clustering.same_story_confidence ? '  <- configured' : '';
    console.log(
      `  ${t.toFixed(2)}  ${String(tp).padStart(4)} ${String(fp).padStart(4)} ${String(fn).padStart(4)}` +
      `      ${m.p.toFixed(3)}   ${m.r.toFixed(3)}   ${m.f1.toFixed(3)}${mark}`,
    );
  }

  // What the false positives actually are matters more than how many. Merging a
  // related-topic pair costs far less than merging two unrelated articles.
  const t = config.pipeline.clustering.same_story_confidence;
  const merged = scored.filter((s) => s.signals.confidence >= t);
  const byLabel: Record<string, number> = {};
  for (const s of merged) byLabel[s.pair.label] = (byLabel[s.pair.label] ?? 0) + 1;
  console.log(`\nwhat gets merged at confidence ${t}:`);
  for (const [k, v] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${v}`);
  }

  // Perspective: of the pairs that are one story, how many are recognised as
  // adding a distinct take? Duplicates should mostly fall below the line and
  // different-perspective pairs mostly above it.
  const distinct = config.pipeline.clustering.perspective.distinct_threshold;
  console.log(`\nperspective separation (distinct_threshold ${distinct}):`);
  for (const label of ['SAME_STORY_DUPLICATE', 'SAME_STORY_DIFFERENT_PERSPECTIVE']) {
    const group = scored.filter((s) => s.pair.label === label && s.signals.confidence >= t);
    if (group.length === 0) { console.log(`  ${label.padEnd(34)} none merged`); continue; }
    const above = group.filter((s) => s.perspective >= distinct).length;
    const avg = group.reduce((sum, s) => sum + s.perspective, 0) / group.length;
    console.log(
      `  ${label.padEnd(34)} merged ${String(group.length).padStart(3)}` +
      `  kept as distinct ${String(above).padStart(3)} (${((100 * above) / group.length).toFixed(0)}%)` +
      `  avg distance ${avg.toFixed(3)}`,
    );
  }

  console.log('\nhighest-confidence merges:');
  for (const s of merged.sort((x, y) => y.signals.confidence - x.signals.confidence).slice(0, 8)) {
    console.log(`  ${s.signals.confidence.toFixed(3)} [${s.pair.label}]`);
    console.log(`     A(${s.pair.a.source}) ${s.pair.a.title.slice(0, 68)}`);
    console.log(`     B(${s.pair.b.source}) ${s.pair.b.title.slice(0, 68)}`);
    console.log(`     ${s.signals.reason}`);
  }

  const worst = scored
    .filter((s) => isPositive(s.pair.label) && s.signals.confidence < t)
    .sort((x, y) => y.signals.confidence - x.signals.confidence);
  if (worst.length > 0) {
    console.log(`\nmissed same-story pairs (${worst.length}), closest first:`);
    for (const s of worst.slice(0, 5)) {
      console.log(`  ${s.signals.confidence.toFixed(3)} [${s.pair.label}] ${s.signals.reason}`);
      console.log(`     A(${s.pair.a.source}) ${s.pair.a.title.slice(0, 68)}`);
      console.log(`     B(${s.pair.b.source}) ${s.pair.b.title.slice(0, 68)}`);
    }
  }
}

main();
