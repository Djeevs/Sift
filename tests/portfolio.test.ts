import { describe, it, expect } from 'vitest';
import {
  buildEdition,
  emptyLedger,
  marginalValue,
  sourceDiminishing,
  topicDiminishing,
  clusterDiminishing,
  correlationPenalty,
  type Candidate,
} from '../src/rank/portfolio.js';
import { estimateAttention } from '../src/rank/attention.js';
import { funnelReport, costPerOutcome } from '../src/pipeline/costs.js';
import { auditReport } from '../src/pipeline/audit.js';
import { publishEditions } from '../src/rank/publishEdition.js';
import { recomputeSourceUniqueness, recomputeSourceOverlap } from '../src/rank/sourceStats.js';
import { loadConfig } from '../src/config/index.js';
import type { DeepScores } from '../src/route/score.js';
import type { OverlapPair } from '../src/rank/sourceStats.js';
import { testDb, seedItem, seedDeepEvaluation } from './helpers.js';

const config = loadConfig();
const games = config.feeds.find((f) => f.id === 'games')!;
const essential = config.feeds.find((f) => f.id === 'essential')!;
const serendipity = config.feeds.find((f) => f.id === 'serendipity')!;

function scores(overrides: Partial<DeepScores> = {}): DeepScores {
  return {
    personal_interest: 0.9,
    intellectual_depth: 0.9,
    novelty: 0.85,
    practical_usefulness: 0.6,
    entertainment: 0.7,
    source_quality: 0.85,
    serendipity: 0.2,
    ragebait: 0.02,
    duplicate_information: 0.05,
    expected_attention_value: 0.9,
    anchor_distance: 0.4,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    itemId: 'i1',
    sourceId: 'aftermath',
    clusterId: null,
    category: 'games',
    scores: scores(),
    recommendedFeeds: [],
    minutes: 8,
    qualityPrior: 0.7,
    learnedSourceValue: 0,
    exploration: false,
    why: 'because',
    ...overrides,
  };
}

const noOverlaps = new Map<string, OverlapPair[]>();
const weightOne = () => 1;

// ---------------------------------------------------------------------------

describe('diminishing returns', () => {
  it('decays each further item from the same source', () => {
    const values = [0, 1, 2, 3, 4].map((n) => sourceDiminishing(n, games, config));
    expect(values[0]).toBe(1);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeLessThan(values[i - 1]!);
    }
    // Never zero: an exceptional later item can still win a slot.
    expect(values[4]!).toBeGreaterThan(0);
  });

  it('lets a feed override the global source curve', () => {
    // Essential is stricter about breadth than the global default.
    expect(essential.diversity.source_decay).toBeTruthy();
    expect(sourceDiminishing(1, essential, config)).toBeLessThan(sourceDiminishing(1, games, config));
  });

  it('decays repeated topics', () => {
    expect(topicDiminishing(0, config)).toBe(1);
    expect(topicDiminishing(3, config)).toBeLessThan(topicDiminishing(1, config));
  });

  it('decays a second item from the same story much harder than a second topic', () => {
    // Compared at full duplication: a pure recap.
    expect(clusterDiminishing(1, games, config, 1)).toBeLessThan(topicDiminishing(1, config));
  });

  it('scales the cluster penalty by how duplicative the item actually is', () => {
    // A recap is penalised hard; a genuinely different take barely at all. A flat
    // penalty would push every second take under the feed's min_score.
    const recap = clusterDiminishing(1, games, config, 0.9);
    const differentTake = clusterDiminishing(1, games, config, 0.05);
    expect(recap).toBeLessThan(differentTake);
    expect(differentTake).toBeGreaterThan(0.9);
  });
});

describe('correlated sources', () => {
  const overlaps = new Map<string, OverlapPair[]>([
    ['404media', [{ partner: 'rock_paper_shotgun', overlap: 0.8, shared: 20 }]],
  ]);

  it('discounts a source whose usual partner already contributed', () => {
    const ledger = emptyLedger('games');
    ledger.perSource.set('rock_paper_shotgun', 1);
    const { multiplier, note } = correlationPenalty(
      candidate({ sourceId: '404media' }),
      ledger,
      overlaps,
      config,
    );
    expect(multiplier).toBeLessThan(1);
    expect(note).toMatch(/correlated with rock_paper_shotgun/);
  });

  it('does nothing when the partner has not contributed', () => {
    const ledger = emptyLedger('games');
    const { multiplier } = correlationPenalty(candidate({ sourceId: '404media' }), ledger, overlaps, config);
    expect(multiplier).toBe(1);
  });

  it('is capped so correlation cannot dominate the score', () => {
    const ledger = emptyLedger('games');
    ledger.perSource.set('rock_paper_shotgun', 20);
    const { multiplier } = correlationPenalty(candidate({ sourceId: '404media' }), ledger, overlaps, config);
    expect(multiplier).toBeGreaterThanOrEqual(1 - config.final.final_ranking.correlation.max_penalty);
  });
});

describe('marginal value', () => {
  it('falls as the edition fills with the same source', () => {
    const ledger = emptyLedger('games');
    const first = marginalValue(candidate(), games, ledger, noOverlaps, config, 1).adjustments.finalScore;
    ledger.perSource.set('aftermath', 2);
    const third = marginalValue(candidate(), games, ledger, noOverlaps, config, 1).adjustments.finalScore;
    expect(third).toBeLessThan(first);
  });

  it('weights Terra far above the source prior', () => {
    // Source quality already bought the Terra call; Terra has now read the piece.
    const strongSourceWeakItem = marginalValue(
      candidate({ qualityPrior: 0.95, scores: scores({ expected_attention_value: 0.5, personal_interest: 0.5 }) }),
      games,
      emptyLedger('games'),
      noOverlaps,
      config,
      1,
    ).adjustments.finalScore;
    const weakSourceStrongItem = marginalValue(
      candidate({ qualityPrior: 0.3, scores: scores({ expected_attention_value: 0.95, personal_interest: 0.95 }) }),
      games,
      emptyLedger('games'),
      noOverlaps,
      config,
      1,
    ).adjustments.finalScore;
    expect(weakSourceStrongItem).toBeGreaterThan(strongSourceWeakItem);
  });

  it('reports every adjustment that moved the score', () => {
    const ledger = emptyLedger('games');
    ledger.perSource.set('aftermath', 1);
    ledger.perCategory.set('games', 1);
    const { adjustments } = marginalValue(candidate(), games, ledger, noOverlaps, config, 1);
    expect(adjustments.sourcePenalty).toBeLessThan(1);
    expect(adjustments.topicPenalty).toBeLessThan(1);
    expect(adjustments.notes.length).toBeGreaterThan(0);
  });

  it('marks an ineligible item ineligible with a reason', () => {
    const rage = marginalValue(
      candidate({ scores: scores({ ragebait: 0.9 }) }),
      games,
      emptyLedger('games'),
      noOverlaps,
      config,
      1,
    );
    expect(rage.eligible).toBe(false);
    expect(rage.reason).toMatch(/ragebait/);
  });
});

describe('buildEdition: portfolio construction', () => {
  function many(n: number, overrides: (i: number) => Partial<Candidate> = () => ({})): Candidate[] {
    return Array.from({ length: n }, (_, i) => candidate({ itemId: `i${i}`, ...overrides(i) }));
  }

  it('spreads across sources rather than taking the top N from one', () => {
    const candidates = [
      ...many(5, (i) => ({ itemId: `aft-${i}`, sourceId: 'aftermath' })),
      ...many(3, (i) => ({ itemId: `cd-${i}`, sourceId: 'critical_distance' })),
    ];
    const { selected } = buildEdition(games, candidates, emptyLedger('games'), noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    const sources = new Set(selected.map((s) => candidates.find((c) => c.itemId === s.itemId)!.sourceId));
    expect(selected.length).toBeGreaterThan(1);
    expect(sources.size).toBeGreaterThan(1);
  });

  it('lets an exceptional later item from one source beat a weak new source', () => {
    const candidates = [
      candidate({ itemId: 'a1', sourceId: 'aftermath' }),
      candidate({ itemId: 'a2', sourceId: 'aftermath' }),
      // Fourth from the same source, but outstanding.
      candidate({
        itemId: 'a3',
        sourceId: 'aftermath',
        scores: scores({ expected_attention_value: 1, personal_interest: 1, intellectual_depth: 1 }),
      }),
      // Different source, but barely over the line.
      candidate({
        itemId: 'weak',
        sourceId: 'critical_distance',
        scores: scores({ expected_attention_value: 0.55, personal_interest: 0.5, intellectual_depth: 0.5 }),
      }),
    ];
    const { selected } = buildEdition(games, candidates, emptyLedger('games'), noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    // A hard cap would have excluded a3 outright. Diminishing returns let it compete.
    expect(selected.map((s) => s.itemId)).toContain('a3');
  });

  it('honours the hard cap as a final safety valve', () => {
    const cap = config.final.final_ranking.source_diminishing.hard_cap_per_feed_per_day;
    const candidates = many(20, (i) => ({ itemId: `x${i}`, sourceId: 'aftermath' }));
    const { selected } = buildEdition(games, candidates, emptyLedger('games'), noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    expect(selected.length).toBeLessThanOrEqual(cap);
  });

  it('respects the attention budget in minutes, not just item count', () => {
    // Six 40-minute essays: the item cap would allow more than the minute budget.
    const candidates = many(6, (i) => ({ itemId: `long-${i}`, sourceId: `s${i}`, minutes: 40 }));
    const ledger = emptyLedger('games');
    const { selected, rejected } = buildEdition(games, candidates, ledger, noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    const budget = games.attention.minutes_per_day!;
    const tolerance = config.final.final_ranking.attention.overflow_tolerance_minutes;
    expect(ledger.minutes).toBeLessThanOrEqual(budget + tolerance);
    expect(selected.length).toBeLessThan(candidates.length);
    expect([...rejected.values()].some((r) => /attention budget/.test(r.reason))).toBe(true);
  });

  it('fits more short items than long ones into the same budget', () => {
    const long = buildEdition(
      games,
      many(8, (i) => ({ itemId: `l${i}`, sourceId: `s${i}`, minutes: 30 })),
      emptyLedger('games'),
      noOverlaps,
      config,
      { sourceFeedWeight: weightOne, feedsUsed: new Map() },
    );
    const short = buildEdition(
      games,
      many(8, (i) => ({ itemId: `s${i}`, sourceId: `s${i}`, minutes: 4 })),
      emptyLedger('games'),
      noOverlaps,
      config,
      { sourceFeedWeight: weightOne, feedsUsed: new Map() },
    );
    expect(short.selected.length).toBeGreaterThan(long.selected.length);
  });

  it('does not let one topic fill the edition', () => {
    // Five separately-excellent items on the same topic must not all get through.
    const candidates = many(5, (i) => ({
      itemId: `same-${i}`,
      sourceId: `src-${i}`,
      category: 'games',
    }));
    const ledger = emptyLedger('games');
    buildEdition(games, candidates, ledger, noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    expect(ledger.perCategory.get('games')).toBeLessThanOrEqual(games.diversity.max_per_category_per_day);
  });

  it('takes only one item from a story unless the second adds information', () => {
    const recap = candidate({
      itemId: 'recap',
      sourceId: 'rock_paper_shotgun',
      clusterId: 'c1',
      scores: scores({ duplicate_information: 0.9 }),
    });
    const original = candidate({ itemId: 'original', sourceId: 'aftermath', clusterId: 'c1' });
    const ledger = emptyLedger('games');
    const { selected } = buildEdition(games, [original, recap], ledger, noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    expect(selected.map((s) => s.itemId)).toContain('original');
    expect(selected.map((s) => s.itemId)).not.toContain('recap');
  });

  it('keeps a genuinely different second take on the same story', () => {
    const critique = candidate({
      itemId: 'critique',
      sourceId: 'critical_distance',
      clusterId: 'c1',
      scores: scores({ duplicate_information: 0.05, expected_attention_value: 0.95 }),
    });
    const original = candidate({ itemId: 'original', sourceId: 'aftermath', clusterId: 'c1' });
    const { selected } = buildEdition(games, [original, critique], emptyLedger('games'), noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    expect(selected.length).toBe(2);
  });

  it('is deterministic across identical runs', () => {
    const build = () =>
      buildEdition(
        games,
        many(6, (i) => ({ itemId: `d${i}`, sourceId: `s${i % 3}` })),
        emptyLedger('games'),
        noOverlaps,
        config,
        { sourceFeedWeight: weightOne, feedsUsed: new Map() },
      ).selected.map((s) => s.itemId);
    expect(build()).toEqual(build());
  });

  it('reserves Serendipity\'s protected slots for exploratory items', () => {
    expect(serendipity.protected_slots_per_day).toBeGreaterThan(0);
    const far = candidate({
      itemId: 'far',
      sourceId: 'lowtech_magazine',
      category: 'other',
      scores: scores({
        personal_interest: 0.2,
        serendipity: 0.9,
        anchor_distance: 0.9,
        novelty: 0.9,
        intellectual_depth: 0.9,
        entertainment: 0.8,
        expected_attention_value: 0.8,
      }),
    });
    const { selected } = buildEdition(serendipity, [far], emptyLedger('serendipity'), noOverlaps, config, {
      sourceFeedWeight: weightOne,
      feedsUsed: new Map(),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.explorationSlot).toBe(true);
  });
});

describe('attention estimates', () => {
  it('prefers an extracted word count over everything else', () => {
    const est = estimateAttention({ wordCount: 4600, terraReadingMinutes: 3 }, config);
    expect(est.source).toBe('extracted');
    expect(est.readingMinutes).toBeGreaterThan(15);
  });

  it('falls back through Terra, then the enclosure, then the default', () => {
    expect(estimateAttention({ terraReadingMinutes: 12 }, config).source).toBe('terra');
    expect(estimateAttention({ durationMinutes: 42 }, config).source).toBe('enclosure');
    const fallback = estimateAttention({}, config);
    expect(fallback.source).toBe('default');
    expect(fallback.readingMinutes).toBe(config.final.final_ranking.attention.default_reading_minutes);
  });

  it('treats a long essay as costing much more than a short post', () => {
    const long = estimateAttention({ wordCount: 8000 }, config).readingMinutes;
    const short = estimateAttention({ wordCount: 500 }, config).readingMinutes;
    expect(long).toBeGreaterThan(short * 5);
  });
});

describe('source uniqueness and overlap from cluster history', () => {
  function seedCluster(db: ReturnType<typeof testDb>['db'], id: string, sources: string[]): void {
    db.run(
      `INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at)
       VALUES (:id, :n, :ts, :ts) ON CONFLICT(id) DO NOTHING`,
      { id, n: sources.length, ts: Date.now() },
    );
    sources.forEach((sourceId, i) => {
      const itemId = seedItem(db, { sourceId, title: `${id} take ${i}`, clusterId: id });
      db.run(
        `INSERT INTO story_cluster_members (cluster_id, item_id, similarity, match_reason, joined_at)
         VALUES (:c, :i, 0.9, 'test', :ts) ON CONFLICT(cluster_id, item_id) DO NOTHING`,
        { c: id, i: itemId, ts: Date.now() },
      );
    });
  }

  it('scores a source that always shares a story lower than one that stands alone', () => {
    const { db } = testDb();
    // rps always covers stories alongside someone else; digital_antiquarian never does.
    for (let i = 0; i < 6; i += 1) seedCluster(db, `shared-${i}`, ['rock_paper_shotgun', 'game_developer']);
    for (let i = 0; i < 6; i += 1) seedCluster(db, `solo-${i}`, ['digital_antiquarian']);

    recomputeSourceUniqueness(db);
    const rows = db.all<{ source_id: string; uniqueness: number }>(
      `SELECT source_id, uniqueness FROM source_statistics`,
    );
    const byId = new Map(rows.map((r) => [r.source_id, r.uniqueness]));
    expect(byId.get('digital_antiquarian')!).toBeGreaterThan(byId.get('rock_paper_shotgun')!);
    db.close();
  });

  it('stays near neutral when there is little evidence', () => {
    const { db } = testDb();
    seedCluster(db, 'only', ['quanta']);
    recomputeSourceUniqueness(db);
    const row = db.get<{ uniqueness: number }>(
      `SELECT uniqueness FROM source_statistics WHERE source_id = 'quanta'`,
    );
    // One non-clustered item must not read as "perfectly unique".
    expect(row!.uniqueness).toBeGreaterThan(0.5);
    expect(row!.uniqueness).toBeLessThan(0.62);
    db.close();
  });

  it('records overlap between sources that keep covering the same stories', () => {
    const { db } = testDb();
    for (let i = 0; i < 8; i += 1) seedCluster(db, `pair-${i}`, ['404media', 'rock_paper_shotgun']);
    recomputeSourceOverlap(db);
    const row = db.get<{ overlap: number; shared_clusters: number }>(
      `SELECT overlap, shared_clusters FROM source_overlap_statistics
       WHERE source_a = '404media' AND source_b = 'rock_paper_shotgun'`,
    );
    expect(row?.shared_clusters).toBe(8);
    expect(row?.overlap).toBeCloseTo(1, 5);
    db.close();
  });
});

describe('funnel and cost reporting', () => {
  it('reports the funnel in stage order with survival rates', () => {
    const { db } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'A physics result worth reading' });
    db.run(
      `INSERT INTO rule_filter_evaluations (item_id, filter_result, filter_reason, filter_version, created_at)
       VALUES (:id, 'keep', 'kept', 3, :ts)`,
      { id, ts: Date.now() },
    );
    seedDeepEvaluation(db, id, { category: 'ideas_science' });
    publishEditions(db, config);

    const funnel = funnelReport(db, 30);
    expect(funnel.map((f) => f.stage)).toEqual([
      'aggregate',
      'rules',
      'free',
      'luna',
      'luna_survivors',
      'terra',
      'terra_strong',
      'published',
    ]);
    expect(funnel[0]!.items).toBeGreaterThan(0);
    expect(funnel[0]!.survivalRate).toBeNull();
    expect(funnel[1]!.survivalRate).not.toBeNull();
    db.close();
  });

  it('reports cost per surfaced, opened and explicitly-liked item', () => {
    const { db } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'Another physics result' });
    seedDeepEvaluation(db, id, { category: 'ideas_science' });
    publishEditions(db, config);
    db.run(
      `INSERT INTO api_usage (stage, model, input_tokens, output_tokens, requests, estimated_cost, created_at)
       VALUES ('deep', 'gpt-5.6-terra', 1000, 100, 1, 0.005, :ts)`,
      { ts: Date.now() },
    );

    const cost = costPerOutcome(db, config, 30);
    expect(cost.totalCost).toBeCloseTo(0.005, 6);
    expect(cost.surfaced).toBeGreaterThan(0);
    expect(cost.costPerSurfaced).toBeCloseTo(0.005 / cost.surfaced, 6);
    // No opens yet, so the per-open figure is absent rather than zero or Infinity.
    expect(cost.costPerOpened).toBeNull();
    db.close();
  });

  it('reports an empty audit cleanly before any sampling has happened', () => {
    const { db } = testDb();
    const report = auditReport(db, config);
    expect(report.map((r) => r.boundary)).toEqual(['free_to_luna', 'luna_to_terra']);
    for (const boundary of report) {
      expect(boundary.sampled).toBe(0);
      expect(boundary.falseNegativeRate).toBeNull();
    }
    db.close();
  });
});
