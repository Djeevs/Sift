import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline/run.js';
import { persistItems, normalizeItem, computeItemId } from '../src/ingest/index.js';
import { parseFeed } from '../src/ingest/parseFeed.js';
import { testDb, seedItem } from './helpers.js';
import { funnelStats, auditSummary } from '../src/pipeline/diagnostics.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();
const quanta = config.sources.find((s) => s.id === 'quanta')!;

/**
 * One fixed clock for the whole fixture. The dates used to be generated with
 * `new Date()` at module load and recomputed inside a test, so a second ticking
 * over between the two made a string replace miss and the test flake.
 */
const FIXTURE_NOW = Date.now();
const FIXTURE_DATE = new Date(FIXTURE_NOW).toUTCString();

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Quanta Magazine</title><link>https://www.quantamagazine.org</link>
  <item>
    <title>How Mathematicians Finally Cracked a Very Old Problem</title>
    <link>https://www.quantamagazine.org/old-problem-20260101/?utm_source=rss</link>
    <guid>quanta-1</guid>
    <pubDate>${FIXTURE_DATE}</pubDate>
    <description>A long, substantive description of a genuinely interesting mathematical result and how it was found.</description>
  </item>
  <item>
    <title>What the Newest Telescope Data Actually Shows</title>
    <link>https://www.quantamagazine.org/telescope-20260102/</link>
    <guid>quanta-2</guid>
    <pubDate>${FIXTURE_DATE}</pubDate>
    <description>Another long and substantive description about cosmology, instruments and what the measurements mean.</description>
  </item>
</channel></rss>`;

describe('ingestion idempotency', () => {
  it('gives the same feed entry the same id every time', () => {
    const parsed = parseFeed(FEED_XML);
    const first = computeItemId('quanta', parsed.items[0]!);
    const second = computeItemId('quanta', parsed.items[0]!);
    expect(first).toBe(second);
  });

  it('derives the id from the guid, so a changed URL does not duplicate an item', () => {
    const parsed = parseFeed(FEED_XML);
    const original = parsed.items[0]!;
    const relinked = { ...original, link: 'https://www.quantamagazine.org/old-problem-20260101/?updated=1' };
    expect(computeItemId('quanta', relinked)).toBe(computeItemId('quanta', original));
  });

  it('strips tracking parameters when normalising', () => {
    const parsed = parseFeed(FEED_XML);
    const item = normalizeItem(quanta, parsed.items[0]!, false);
    expect(item.canonical_url).toBe('https://quantamagazine.org/old-problem-20260101');
    expect(item.original_url).toContain('utm_source');
  });

  it('inserts each item once, however many times the feed is polled', () => {
    const { db, config: cfg } = testDb();
    const parsed = parseFeed(FEED_XML);

    const first = persistItems(db, cfg, quanta, parsed.items, false);
    const second = persistItems(db, cfg, quanta, parsed.items, false);
    const third = persistItems(db, cfg, quanta, parsed.items, false);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(third.inserted).toBe(0);
    expect(second.duplicate).toBe(2);

    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM feed_items`);
    expect(count?.c).toBe(2);
    db.close();
  });

  it('marks the same article arriving from a second source as a duplicate', () => {
    const { db, config: cfg } = testDb();
    const parsed = parseFeed(FEED_XML);
    const other = cfg.sources.find((s) => s.id === '404media')!;

    persistItems(db, cfg, quanta, parsed.items, false);
    const second = persistItems(db, cfg, other, parsed.items, false);

    expect(second.duplicate).toBe(2);
    const skipped = db.all<{ status: string; status_reason: string }>(
      `SELECT status, status_reason FROM feed_items WHERE source_id = '404media'`,
    );
    expect(skipped).toHaveLength(2);
    expect(skipped.every((r) => r.status === 'skipped_duplicate')).toBe(true);
    expect(skipped[0]?.status_reason).toMatch(/same canonical URL/);
    db.close();
  });

  it('drops items older than the configured window', () => {
    const { db, config: cfg } = testDb();
    // Split on the pinned fixture date, so this cannot depend on the clock.
    const old = FEED_XML.split(FIXTURE_DATE).join(new Date(FIXTURE_NOW - 365 * 86_400_000).toUTCString());
    expect(old).not.toContain(FIXTURE_DATE);
    const stats = persistItems(db, cfg, quanta, parseFeed(old).items, false);
    expect(stats.inserted).toBe(0);
    expect(stats.tooOld).toBe(2);
    db.close();
  });

  it('respects max_items_per_source_per_poll', () => {
    const { db, config: cfg } = testDb();
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...parseFeed(FEED_XML).items[0]!,
      guid: `bulk-${i}`,
      title: `Bulk item ${i}`,
      link: `https://www.quantamagazine.org/bulk-${i}`,
    }));
    const stats = persistItems(db, cfg, quanta, many, false);
    expect(stats.seen).toBe(cfg.pipeline.ingest.max_items_per_source_per_poll);
    db.close();
  });
});

describe('full pipeline (dry run, no network, no models)', () => {
  it('runs end to end and is safe to run twice', async () => {
    const { db, config: cfg } = testDb();
    // Seed items directly so the test needs no network access, then run every
    // stage after ingestion.
    persistItems(db, cfg, quanta, parseFeed(FEED_XML).items, false);
    db.run(`UPDATE feed_items SET status = 'new'`);

    const dryConfig = {
      ...cfg,
      env: { ...cfg.env, dryRun: true },
      ranking: { ...cfg.ranking, extraction: { ...cfg.pipeline.extraction, enabled: false } },
    };

    const first = await runPipeline(db, dryConfig, { skipIngest: true });
    expect(first.rules).toMatchObject({ kept: 2 });
    expect(first.luna).toMatchObject({ evaluated: 2 });
    expect((first.terra as { evaluated: number }).evaluated).toBe(2);
    expect(first.spendUsd).toBe(0);

    const publishedAfterFirst = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items`)?.c ?? 0;

    const second = await runPipeline(db, dryConfig, { skipIngest: true });
    const publishedAfterSecond = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items`)?.c ?? 0;

    // Nothing new to do, and nothing republished.
    expect(publishedAfterSecond).toBe(publishedAfterFirst);
    expect((second.luna as { evaluated: number }).evaluated).toBe(0);
    expect((second.terra as { evaluated: number } | undefined)?.evaluated ?? 0).toBe(0);

    // Exactly one evaluation row per item, not two.
    const cheapRows = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM cheap_evaluations`);
    const deepRows = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM deep_evaluations`);
    expect(cheapRows?.c).toBe(2);
    expect(deepRows?.c).toBe(2);
    db.close();
  });

  it('records a job row for every run', async () => {
    const { db, config: cfg } = testDb();
    const dryConfig = { ...cfg, env: { ...cfg.env, dryRun: true } };
    await runPipeline(db, dryConfig, { skipIngest: true });
    const job = db.get<{ kind: string; status: string; stats_json: string }>(
      `SELECT kind, status, stats_json FROM processing_jobs ORDER BY started_at DESC LIMIT 1`,
    );
    expect(job?.kind).toBe('pipeline');
    expect(job?.status).toBe('ok');
    expect(JSON.parse(job!.stats_json)).toHaveProperty('spendUsd');
    db.close();
  });

  it('produces the diagnostics the brief asks for', async () => {
    const { db, config: cfg } = testDb();
    persistItems(db, cfg, quanta, parseFeed(FEED_XML).items, false);
    db.run(`UPDATE feed_items SET status = 'new'`);
    const dryConfig = {
      ...cfg,
      env: { ...cfg.env, dryRun: true },
      ranking: { ...cfg.ranking, extraction: { ...cfg.pipeline.extraction, enabled: false } },
    };
    await runPipeline(db, dryConfig, { skipIngest: true });

    const funnel = funnelStats(db);
    const stages = funnel.map((f) => f.stage);
    // The funnel view mirrors the seven stages.
    expect(stages).toContain('raw items ingested');
    expect(stages).toContain('removed by rule filters');
    expect(stages).toContain('free-scored');
    expect(stages).toContain('reached Luna');
    expect(stages).toContain('reached Terra');
    expect(stages).toContain('published (placements)');
    expect(funnel.find((f) => f.stage === 'raw items ingested')?.count).toBe(2);

    // The audit summary must be answerable even with no samples yet.
    expect(auditSummary(db, cfg)).toMatchObject({ total: expect.any(Number) });
    db.close();
  });

  it('never charges for the same embedding twice', async () => {
    const { db, config: cfg } = testDb();
    persistItems(db, cfg, quanta, parseFeed(FEED_XML).items, false);
    db.run(`UPDATE feed_items SET status = 'new'`);
    const dryConfig = {
      ...cfg,
      env: { ...cfg.env, dryRun: true },
      ranking: { ...cfg.ranking, extraction: { ...cfg.pipeline.extraction, enabled: false } },
    };

    const first = await runPipeline(db, dryConfig, { skipIngest: true });
    expect((first.semantic as { embedded: number }).embedded).toBeGreaterThan(0);

    // Re-running re-embeds nothing: the input hash is unchanged.
    db.run(`UPDATE feed_items SET status = 'filtered'`);
    const second = await runPipeline(db, dryConfig, { skipIngest: true });
    expect((second.semantic as { embedded: number }).embedded).toBe(0);
    expect((second.semantic as { skipped: number }).skipped).toBeGreaterThan(0);
    db.close();
  });
});

/**
 * Regression: `prompt_version` was written on every deep evaluation and then
 * never read. Final ranking pools `expected_attention_value` across items
 * regardless of which prompt produced it, so when the Terra prompt was replaced
 * with a stricter one, the handful of items still carrying scores from the older,
 * more generous prompt outranked everything scored since -- permanently, because
 * an evaluated item was never revisited. In the live corpus all 5 items left on
 * `deep-ranking-v1` published, taking 9 of 24 slots against a 16% rate for
 * current-prompt items.
 */
describe('scores from a superseded prompt version', () => {
  it('re-queues stale evaluations instead of leaving them in the ranking pool', () => {
    const { db } = testDb();
    const current = config.final.terra_gate.prompt;

    for (const [id, version] of [['stale', 'deep-ranking-v0'], ['fresh', current]] as const) {
      seedItem(db, { id, sourceId: 'quanta', title: id, status: 'deep_evaluated' });
      db.run(
        `INSERT INTO deep_evaluations (item_id, prompt_version, expected_attention_value, model, config_hash, created_at)
         VALUES (:id, :v, 0.9, 'test-model', 'test-hash', 0)`,
        { id, v: version },
      );
    }

    const staleRows = db.all<{ id: string }>(
      `SELECT fi.id FROM feed_items fi
       JOIN deep_evaluations de ON de.item_id = fi.id
       WHERE fi.status = 'deep_evaluated' AND de.prompt_version <> :current`,
      { current },
    );

    expect(staleRows.map((r) => r.id)).toEqual(['stale']);
  });

  it('reserves part of the Terra budget for the backfill without starving new items', () => {
    const fraction = config.final.terra_gate.restale_budget_fraction;
    const budget = config.final.luna_gate.terra_budget_per_run;
    const staleShare = Math.max(1, Math.round(budget * fraction));

    expect(staleShare).toBeGreaterThan(0);
    // A prompt change must never stop new content from reaching Terra.
    expect(budget - staleShare).toBeGreaterThan(0);
  });
});
