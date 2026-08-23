import { describe, it, expect } from 'vitest';
import { matchFeedbackEntry, recordManualFeedback, type MatchCandidate } from '../src/feedback/reeder.js';
import { recordOpen, openCount } from '../src/feedback/opens.js';
import { collectSignals, applyLearning, shouldExplore } from '../src/learn/index.js';
import { routeAndPublish } from '../src/route/index.js';
import { testDb, seedItem, seedDeepEvaluation } from './helpers.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();

const candidates: MatchCandidate[] = [
  {
    id: 'abc123def456',
    title: 'A persistent-memory pattern for agents',
    canonical_url: 'https://simonwillison.net/2026/agents-memory',
    original_url: 'https://simonwillison.net/2026/agents-memory',
  },
  {
    id: 'xyz789ghi012',
    title: 'How the Dutch railway timetable is computed',
    canonical_url: 'https://worksinprogress.news/timetable',
    original_url: 'https://worksinprogress.news/timetable',
  },
];

describe('matchFeedbackEntry', () => {
  it('reads the item id straight out of our tracked link', () => {
    const result = matchFeedbackEntry(
      { title: 'anything at all', link: 'https://sift.example/open/abc123def456?feed=ai_product' },
      candidates,
    );
    expect(result).toEqual({ itemId: 'abc123def456', matchedBy: 'tracked_link' });
  });

  it('matches on the publisher URL, ignoring tracking parameters', () => {
    const result = matchFeedbackEntry(
      { title: 'different title', link: 'http://www.simonwillison.net/2026/agents-memory/?utm_source=reeder' },
      candidates,
    );
    expect(result).toEqual({ itemId: 'abc123def456', matchedBy: 'url' });
  });

  it('falls back to a strong title match', () => {
    const result = matchFeedbackEntry(
      { title: 'How the Dutch railway timetable is computed', link: null },
      candidates,
    );
    expect(result).toEqual({ itemId: 'xyz789ghi012', matchedBy: 'title' });
  });

  it('refuses a weak title match rather than risk mislabelling', () => {
    // Attaching "not for me" to the wrong article would be worse than losing
    // the signal entirely.
    const result = matchFeedbackEntry({ title: 'Something about agents', link: null }, candidates);
    expect(result.itemId).toBeNull();
  });

  it('returns no match for genuinely unknown entries', () => {
    const result = matchFeedbackEntry(
      { title: 'An article we never published', link: 'https://elsewhere.example/x' },
      candidates,
    );
    expect(result).toEqual({ itemId: null, matchedBy: null });
  });

  it('ignores a tracked link whose id we do not know', () => {
    const result = matchFeedbackEntry({ title: 'x', link: 'https://sift.example/open/unknownid1234' }, candidates);
    expect(result.itemId).toBeNull();
  });
});

describe('open events', () => {
  it('records an open once per day per item', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'A physics result' });
    recordOpen(db, config, id, 'essential', 'https://example.com/a');
    recordOpen(db, config, id, 'essential', 'https://example.com/a');
    expect(openCount(db, id)).toBe(1);
    db.close();
  });

  it('stores nothing beyond the item, feed, url and time', () => {
    const { db, config } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'A physics result' });
    recordOpen(db, config, id, 'essential', 'https://example.com/a');
    const row = db.get<Record<string, unknown>>(`SELECT * FROM open_events WHERE item_id = :id`, { id });
    expect(Object.keys(row ?? {}).sort()).toEqual(['feed_id', 'id', 'item_id', 'opened_at', 'original_url']);
    db.close();
  });
});

describe('learning safeguards', () => {
  function published(db: ReturnType<typeof testDb>['db'], config: ReturnType<typeof testDb>['config'], opts: {
    sourceId: string;
    title: string;
    ragebait?: number;
    category?: string;
  }): string {
    const id = seedItem(db, { sourceId: opts.sourceId, title: opts.title });
    seedDeepEvaluation(db, id, {
      personal_interest: 0.9,
      intellectual_depth: 0.9,
      novelty: 0.85,
      expected_attention_value: 0.9,
      ragebait: opts.ragebait ?? 0.02,
      category: opts.category ?? 'ai_product',
    });
    routeAndPublish(db, config);
    return id;
  }

  it('treats an open as a weak positive', () => {
    const { db, config } = testDb();
    const id = published(db, config, { sourceId: 'simon_willison', title: 'A good post about agents' });
    recordOpen(db, config, id, 'ai_product', 'https://example.com/a');

    const signals = collectSignals(db, config);
    const signal = signals.find((s) => s.itemId === id);
    expect(signal?.kinds).toContain('opened');
    expect(signal?.value).toBeCloseTo(config.pipeline.feedback.signal_weights['opened'] ?? 0.15, 5);
    db.close();
  });

  it('lets explicit feedback dominate an open', () => {
    const { db, config } = testDb();
    const id = published(db, config, { sourceId: 'simon_willison', title: 'A very good post about agents' });
    recordOpen(db, config, id, 'ai_product', 'https://example.com/a');
    recordManualFeedback(db, id, 'excellent');

    const signal = collectSignals(db, config).find((s) => s.itemId === id)!;
    expect(signal.value).toBeGreaterThan(0.9);

    const { db: db2, config: config2 } = testDb();
    const id2 = published(db2, config2, { sourceId: 'simon_willison', title: 'A post that missed' });
    recordOpen(db2, config2, id2, 'ai_product', 'https://example.com/b');
    recordManualFeedback(db2, id2, 'not_for_me');
    const negative = collectSignals(db2, config2).find((s) => s.itemId === id2)!;
    expect(negative.value).toBeLessThan(0);
    db.close();
    db2.close();
  });

  it('never learns that ragebait is wanted, however often it is opened', () => {
    const { db, config } = testDb();
    // Ragebait high enough to trip the guard, but published via a feed that
    // tolerates it, so the item genuinely reaches the reader.
    const id = seedItem(db, { sourceId: 'citation_needed', title: 'Everyone is furious about the new rules' });
    seedDeepEvaluation(db, id, {
      personal_interest: 0.9,
      intellectual_depth: 0.6,
      novelty: 0.7,
      expected_attention_value: 0.8,
      ragebait: 0.9,
      category: 'society',
    });
    db.run(
      `INSERT INTO published_feed_items (feed_id, item_id, score, why_it_surfaced, published_at, day_key)
       VALUES ('culture', :id, 0.8, 'x', :ts, '2026-01-01')`,
      { id, ts: Date.now() },
    );
    recordOpen(db, config, id, 'culture', 'https://example.com/rage');

    const signal = collectSignals(db, config).find((s) => s.itemId === id)!;
    expect(signal.kinds).toContain('open_ignored_ragebait');
    expect(signal.kinds).not.toContain('opened');
    expect(signal.value).toBe(0);
    db.close();
  });

  it('does not treat "not opened" as a negative signal', () => {
    const { db, config } = testDb();
    const id = published(db, config, { sourceId: 'quanta', title: 'Something nobody clicked' });
    const signals = collectSignals(db, config);
    // No signal at all is the correct outcome: silence is not disapproval.
    expect(signals.find((s) => s.itemId === id)).toBeUndefined();
    db.close();
  });

  it('will not move a weight without enough evidence', () => {
    const { db, config } = testDb();
    const id = published(db, config, { sourceId: 'simon_willison', title: 'One single data point' });
    recordManualFeedback(db, id, 'excellent');

    const stats = applyLearning(db, config);
    expect(stats.updated).toHaveLength(0);
    expect(stats.skipped.some((s) => s.reason.includes('events'))).toBe(true);
    db.close();
  });

  /**
   * Publish directly, spread over past days. Going through routeAndPublish
   * would hit the per-source daily diversity cap long before there is enough
   * evidence for a learning round, which is correct behaviour but makes it a
   * poor way to build up history in a test.
   */
  function publishedOverTime(
    db: ReturnType<typeof testDb>['db'],
    sourceId: string,
    count: number,
    ragebait = 0.02,
  ): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = seedItem(db, { sourceId, title: `Excellent post number ${i}` });
      seedDeepEvaluation(db, id, { expected_attention_value: 0.9, ragebait, category: 'ai_product' });
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      db.run(
        `INSERT INTO published_feed_items (feed_id, item_id, score, why_it_surfaced, published_at, day_key)
         VALUES ('ai_product', :id, 0.8, 'x', :ts, :day)`,
        { id, ts: Date.now() - i * 86_400_000, day },
      );
      ids.push(id);
    }
    return ids;
  }

  it('nudges a source prior once evidence accumulates, within bounds', () => {
    const { db, config } = testDb();
    const needed = config.pipeline.learning.min_events_before_update;
    for (const id of publishedOverTime(db, 'simon_willison', needed + 2)) {
      recordManualFeedback(db, id, 'excellent');
    }

    applyLearning(db, config);

    // Learned value lives in source_statistics, computed with Bayesian smoothing.
    // sources.yaml priors are never overwritten -- the two are combined at
    // scoring time instead.
    const stored = db.get<{ learned_value: number; explicit_positive: number }>(
      `SELECT learned_value, explicit_positive FROM source_statistics WHERE source_id = 'simon_willison'`,
    );
    expect(stored?.explicit_positive).toBeGreaterThan(0);
    expect(stored?.learned_value).toBeGreaterThan(0);
    expect(stored?.learned_value).toBeLessThanOrEqual(config.pipeline.learning.max_learned_source_value);

    const configured = config.sources.find((x) => x.id === 'simon_willison')!;
    expect(configured.quality_prior).toBe(0.92);
    db.close();
  });

  it('moves slowly: one round cannot swing a prior far', () => {
    const { db, config } = testDb();
    const needed = config.pipeline.learning.min_events_before_update;
    for (const id of publishedOverTime(db, 'simon_willison', needed + 5)) {
      recordManualFeedback(db, id, 'excellent');
    }
    applyLearning(db, config);
    const stored = db.get<{ learned_value: number }>(
      `SELECT learned_value FROM source_statistics WHERE source_id = 'simon_willison'`,
    )!;
    // Smoothing, not a learning rate, is what keeps this slow: with
    // prior_strength pseudo-observations, a perfect record still lands well
    // short of the configured maximum.
    expect(stored.learned_value).toBeGreaterThan(0);
    expect(stored.learned_value).toBeLessThan(config.pipeline.learning.max_learned_source_value);
    db.close();
  });

  it('writes a taste snapshot so changes can be traced', () => {
    const { db, config } = testDb();
    const needed = config.pipeline.learning.min_events_before_update;
    for (const id of publishedOverTime(db, 'simon_willison', needed + 1)) {
      recordManualFeedback(db, id, 'excellent');
    }
    applyLearning(db, config);
    const snapshot = db.get<{ snapshot_json: string; config_hash: string }>(
      `SELECT snapshot_json, config_hash FROM taste_profile_versions ORDER BY created_at DESC LIMIT 1`,
    );
    expect(snapshot?.config_hash).toBeTruthy();
    expect(JSON.parse(snapshot!.snapshot_json)).toHaveProperty('learned');
    db.close();
  });

  it('reserves an exploration budget', () => {
    const fraction = config.pipeline.learning.exploration_fraction;
    expect(fraction).toBeGreaterThan(0);
    expect(shouldExplore(config, () => fraction / 2)).toBe(true);
    expect(shouldExplore(config, () => 0.99)).toBe(false);
  });
});
