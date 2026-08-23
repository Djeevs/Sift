import { describe, it, expect } from 'vitest';
import { routeAndPublish } from '../src/route/index.js';
import { testDb, seedItem, seedDeepEvaluation } from './helpers.js';
import { dayKey } from '../src/util/time.js';

const EXCELLENT = {
  personal_interest: 0.95,
  intellectual_depth: 0.95,
  novelty: 0.9,
  practical_usefulness: 0.85,
  entertainment: 0.8,
  source_quality: 0.9,
  expected_attention_value: 0.95,
  ragebait: 0.01,
  duplicate_information: 0.02,
};

describe('routeAndPublish', () => {
  it('publishes a strong item and records why', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'simon_willison', title: 'A persistent-memory pattern for agents' });
    seedDeepEvaluation(db, id, { ...EXCELLENT, category: 'ai_product', why: 'Explains a new memory pattern.' });

    const stats = routeAndPublish(db, config);
    expect(stats.published).toBeGreaterThan(0);

    const rows = db.all<{ feed_id: string; why_it_surfaced: string }>(
      `SELECT feed_id, why_it_surfaced FROM published_feed_items WHERE item_id = :id`,
      { id },
    );
    expect(rows.map((r) => r.feed_id)).toContain('ai_product');
    expect(rows[0]?.why_it_surfaced).toBe('Explains a new memory pattern.');
    db.close();
  });

  it('does not republish on a second run (idempotent)', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'How error correction really works' });
    seedDeepEvaluation(db, id, { ...EXCELLENT, category: 'ideas_science' });

    const first = routeAndPublish(db, config);
    const second = routeAndPublish(db, config);
    expect(first.published).toBeGreaterThan(0);
    expect(second.published).toBe(0);

    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, { id });
    expect(count?.c).toBe(first.published);
    db.close();
  });

  it('records a routing decision for every feed, published or not', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'A modest result' });
    seedDeepEvaluation(db, id, { category: 'ideas_science', expected_attention_value: 0.3, intellectual_depth: 0.3 });

    routeAndPublish(db, config);
    const decisions = db.all<{ feed_id: string; reason: string }>(
      `SELECT feed_id, reason FROM final_ranking_decisions WHERE item_id = :id`,
      { id },
    );
    // One row per feed that considered the item, each with a reason.
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => d.reason.length > 0)).toBe(true);
    db.close();
  });

  it('applies diminishing returns to one source rather than a hard cap', () => {
    // The old router capped a source at N per feed per day, which threw away an
    // excellent Nth+1 item for nothing. Now each further item from the same
    // source competes at a discount, and the hard cap is only a safety valve.
    const { db, config } = testDb();
    const hardCap = config.final.final_ranking.source_diminishing.hard_cap_per_feed_per_day;

    for (let i = 0; i < 12; i += 1) {
      const id = seedItem(db, { sourceId: 'critical_distance', title: `A distinct piece of games criticism ${i}` });
      seedDeepEvaluation(db, id, { ...EXCELLENT, category: 'games' });
    }

    routeAndPublish(db, config);
    const count =
      db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM published_feed_items p JOIN feed_items fi ON fi.id = p.item_id
         WHERE p.feed_id = 'games' AND fi.source_id = 'critical_distance'`,
      )?.c ?? 0;

    // Bounded by the safety valve, and by the decay curve pushing later items
    // under the feed's min_score before that.
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(hardCap);

    // The decay must actually be recorded, not just implied by the count.
    const penalties = db.all<{ source_penalty: number }>(
      `SELECT source_penalty FROM final_ranking_decisions
       WHERE feed_id = 'games' AND published = 1 ORDER BY selection_order`,
    );
    expect(penalties.length).toBeGreaterThan(1);
    expect(penalties[1]!.source_penalty).toBeLessThan(penalties[0]!.source_penalty);
    db.close();
  });

  it('respects the daily cap per feed', () => {
    const { db, config } = testDb();
    const essential = config.feeds.find((f) => f.id === 'essential')!;
    const sources = ['quanta', 'simon_willison', 'aftermath', 'longreads', 'noema', 'aeon', 'tedium', 'kottke'];

    for (let i = 0; i < essential.daily_cap + 6; i += 1) {
      const id = seedItem(db, {
        sourceId: sources[i % sources.length]!,
        title: `An outstanding article number ${i} about something specific`,
      });
      seedDeepEvaluation(db, id, { ...EXCELLENT, category: i % 2 ? 'ideas_science' : 'culture' });
    }

    routeAndPublish(db, config);
    const count = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM published_feed_items WHERE feed_id = 'essential' AND day_key = :d`,
      { d: dayKey(Date.now()) },
    );
    expect(count?.c).toBeLessThanOrEqual(essential.daily_cap);
    db.close();
  });

  it('never publishes an item to more than max_feeds_per_item feeds', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'simon_willison', title: 'An exceptional cross-cutting essay' });
    seedDeepEvaluation(db, id, {
      ...EXCELLENT,
      category: 'ai_product',
      recommendedFeeds: ['essential', 'ai_product', 'ideas_science', 'culture'],
    });

    routeAndPublish(db, config);
    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, { id });
    expect(count?.c).toBeLessThanOrEqual(config.final.final_ranking.max_feeds_per_item);
    db.close();
  });

  it('blocks ragebait even when every other score is high', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'citation_needed', title: 'Everyone is furious about this and you should be too' });
    seedDeepEvaluation(db, id, { ...EXCELLENT, ragebait: 0.9, category: 'ai_product' });

    routeAndPublish(db, config);
    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, { id });
    expect(count?.c).toBe(0);

    const decision = db.get<{ reason: string }>(
      `SELECT reason FROM final_ranking_decisions WHERE item_id = :id AND feed_id = 'essential'`,
      { id },
    );
    expect(decision?.reason).toMatch(/ragebait/);
    db.close();
  });

  it('keeps a second, genuinely different take on the same story', () => {
    const { db, config } = testDb();
    const clusterId = 'cluster-x';
    db.run(`INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at) VALUES (:id, 2, :ts, :ts)`, {
      id: clusterId,
      ts: Date.now(),
    });

    const announcement = seedItem(db, { sourceId: 'simon_willison', title: 'Company ships a new model', clusterId });
    const critique = seedItem(db, { sourceId: 'ai_snake_oil', title: 'Why that benchmark claim does not hold', clusterId });
    seedDeepEvaluation(db, announcement, { ...EXCELLENT, category: 'ai_product' });
    // Different information, not a recap: low duplicate_information.
    seedDeepEvaluation(db, critique, { ...EXCELLENT, category: 'ai_product', duplicate_information: 0.1 });

    routeAndPublish(db, config);
    const published = db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT item_id) AS c FROM published_feed_items p
       JOIN feed_items fi ON fi.id = p.item_id WHERE fi.cluster_id = :c`,
      { c: clusterId },
    );
    expect(published?.c).toBe(2);
    db.close();
  });

  it('drops a duplicate recap of a story already covered', () => {
    const { db, config } = testDb();
    const clusterId = 'cluster-y';
    db.run(`INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at) VALUES (:id, 2, :ts, :ts)`, {
      id: clusterId,
      ts: Date.now(),
    });

    const original = seedItem(db, { sourceId: 'simon_willison', title: 'The primary analysis', clusterId });
    seedDeepEvaluation(db, original, { ...EXCELLENT, category: 'ai_product' });
    routeAndPublish(db, config);

    const recap = seedItem(db, { sourceId: 'rock_paper_shotgun', title: 'A recap of the primary analysis', clusterId });
    // High duplicate_information: adds nothing the reader has not already seen.
    seedDeepEvaluation(db, recap, { ...EXCELLENT, category: 'ai_product', duplicate_information: 0.9 });
    routeAndPublish(db, config);

    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, {
      id: recap,
    });
    expect(count?.c).toBe(0);
    const decision = db.get<{ reason: string }>(
      `SELECT reason FROM final_ranking_decisions WHERE item_id = :id AND feed_id = 'ai_product'`,
      { id: recap },
    );
    expect(decision?.reason ?? '').toMatch(/duplicate|cluster|story|marginal|full/i);
    db.close();
  });

  it('routes an off-interest but excellent item into serendipity only', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'lowtech_magazine', title: 'The lost craft of Japanese well digging' });
    seedDeepEvaluation(db, id, {
      personal_interest: 0.15,
      intellectual_depth: 0.9,
      novelty: 0.95,
      practical_usefulness: 0.1,
      entertainment: 0.85,
      source_quality: 0.85,
      serendipity: 0.95,
      ragebait: 0.0,
      duplicate_information: 0.0,
      expected_attention_value: 0.8,
      anchor_distance: 0.85,
      category: 'other',
    });

    routeAndPublish(db, config);
    const feeds = db.all<{ feed_id: string }>(`SELECT feed_id FROM published_feed_items WHERE item_id = :id`, { id });
    expect(feeds.map((f) => f.feed_id)).toContain('serendipity');
    db.close();
  });

  it('will not put a shallow oddity into serendipity', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'stereogum', title: 'A very strange but empty listicle' });
    seedDeepEvaluation(db, id, {
      personal_interest: 0.05,
      intellectual_depth: 0.1,
      novelty: 0.9,
      practical_usefulness: 0.05,
      entertainment: 0.15,
      source_quality: 0.2,
      serendipity: 0.9,
      ragebait: 0.1,
      duplicate_information: 0.1,
      expected_attention_value: 0.15,
      anchor_distance: 0.95,
      category: 'other',
    });

    routeAndPublish(db, config);
    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, { id });
    expect(count?.c).toBe(0);
    db.close();
  });

  it('does not publish items from non-publishable (podcast) sources', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'pod_99pi', title: 'Episode 500: A door', isPodcast: true });
    seedDeepEvaluation(db, id, { ...EXCELLENT, category: 'culture' });

    routeAndPublish(db, config);
    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, { id });
    expect(count?.c).toBe(0);
    db.close();
  });
});
