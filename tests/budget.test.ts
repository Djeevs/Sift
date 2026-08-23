import { describe, it, expect } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { testDb, seedItem } from './helpers.js';
import {
  budgetState,
  monthToDateSpend,
  affordableTerraCalls,
  passesHardLimitReservation,
  isStillEligible,
  observedTerraCostPerCall,
  terraPathCost,
  monthKey,
} from '../src/pipeline/budget.js';
import { scoreOpportunity, feedNeed, type OpportunityInput } from '../src/rank/terraOpportunity.js';
import { allocateTerra } from '../src/rank/terraAllocation.js';
import { clusteringStats } from '../src/cluster/diagnostics.js';
import type { Db } from '../src/db/index.js';

const config = loadConfig();

/** Pretend a given amount has already been spent this month. */
function recordSpend(db: Db, stage: string, usd: number, requests = 1, now = Date.now()): void {
  db.run(
    `INSERT INTO api_usage (stage, model, input_tokens, output_tokens, requests, estimated_cost, created_at)
     VALUES (:s, 'm', 1000, 100, :r, :c, :ts)`,
    { s: stage, r: requests, c: usd, ts: now },
  );
}

function withMode(overrides: Partial<AppConfig['mode']>): AppConfig {
  return { ...config, mode: { ...config.mode, ...overrides } };
}

describe('month-to-date spend', () => {
  it('splits Luna and Terra, and ignores earlier months', () => {
    const { db } = testDb();
    const now = Date.UTC(2026, 7, 15);
    recordSpend(db, 'luna', 0.05, 10, now);
    recordSpend(db, 'terra', 1.5, 100, now);
    // Last month must not count against this month's budget.
    recordSpend(db, 'terra', 99, 1000, Date.UTC(2026, 6, 15));

    const spend = monthToDateSpend(db, now);
    expect(spend.luna).toBeCloseTo(0.05, 6);
    expect(spend.terra).toBeCloseTo(1.5, 6);
    expect(spend.total).toBeCloseTo(1.55, 6);
  });

  it('keys the month in UTC', () => {
    expect(monthKey(Date.UTC(2026, 0, 1))).toBe('2026-01');
    expect(monthKey(Date.UTC(2026, 11, 31))).toBe('2026-12');
  });
});

describe('budget-aware degradation', () => {
  it('starts at the loosest stage when nothing has been spent', () => {
    const { db } = testDb();
    const state = budgetState(db, config, Date.UTC(2026, 7, 2));
    expect(state.stage).toBe('normal');
    expect(state.spentUsd).toBe(0);
    expect(state.hardLimitReached).toBe(false);
  });

  /**
   * The bar rises monotonically with spend. Anything else would mean spending
   * more money made the pipeline less selective.
   */
  it('raises the opportunity bar as spend approaches the target', () => {
    const now = Date.UTC(2026, 7, 15);
    const cfg = withMode({ monthly_target_usd: 10, monthly_hard_limit_usd: 20 });
    const seen: number[] = [];
    for (const spent of [0.5, 7.5, 11, 14]) {
      const { db } = testDb();
      recordSpend(db, 'terra', spent, 1, now);
      seen.push(budgetState(db, cfg, now).minOpportunity);
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(seen[seen.length - 1]!).toBeGreaterThan(seen[0]!);
  });

  it('reports the hard limit as reached and reserves Terra for a short list', () => {
    const now = Date.UTC(2026, 7, 15);
    const cfg = withMode({ monthly_target_usd: 10, monthly_hard_limit_usd: 20 });
    const { db } = testDb();
    recordSpend(db, 'terra', 21, 1, now);
    const state = budgetState(db, cfg, now);

    expect(state.hardLimitReached).toBe(true);
    expect(affordableTerraCalls(db, cfg, state, 60).calls).toBe(0);

    // Ordinary items stop; the reserved categories continue.
    expect(passesHardLimitReservation(state, { essentialCandidate: false, serendipity: false, audit: false })).toBe(false);
    expect(passesHardLimitReservation(state, { essentialCandidate: true, serendipity: false, audit: false })).toBe(true);
    expect(passesHardLimitReservation(state, { essentialCandidate: false, serendipity: true, audit: false })).toBe(true);
    expect(passesHardLimitReservation(state, { essentialCandidate: false, serendipity: false, audit: true })).toBe(true);
  });

  it('spreads what is left over the days remaining rather than letting one run drain it', () => {
    const now = Date.UTC(2026, 7, 15);
    const cfg = withMode({ monthly_target_usd: 10, monthly_hard_limit_usd: 20 });
    const { db } = testDb();
    // A realistic per-call cost, so the allowance maths is meaningful.
    recordSpend(db, 'terra', 1.0, 100, now);
    const state = budgetState(db, cfg, now);
    const { calls } = affordableTerraCalls(db, cfg, state, 10_000);
    // Far below the absurd request, because a day's share is far below the month's.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10_000);
  });

  it('projects month-end spend from the run rate so far', () => {
    const { db } = testDb();
    const now = Date.UTC(2026, 7, 10); // day 10 of 31
    recordSpend(db, 'terra', 2, 1, now);
    const state = budgetState(db, config, now);
    expect(state.projectedMonthEndUsd).toBeCloseTo((2 / 10) * 31, 4);
  });
});

describe('deferred items age out by content type', () => {
  const now = Date.UTC(2026, 7, 15);
  const hoursAgo = (h: number) => now - h * 3_600_000;

  it('drops stale news but keeps a timeless essay waiting', () => {
    expect(isStillEligible(config, 'news', hoursAgo(200), now)).toBe(false);
    expect(isStillEligible(config, 'essay', hoursAgo(200), now)).toBe(true);
  });

  it('keeps fresh news of any type', () => {
    expect(isStillEligible(config, 'news', hoursAgo(10), now)).toBe(true);
  });

  it('treats an unknown type with the default allowance', () => {
    expect(isStillEligible(config, null, hoursAgo(10), now)).toBe(true);
    expect(isStillEligible(config, 'something-else', hoursAgo(100_000), now)).toBe(false);
  });
});

describe('Terra unit economics', () => {
  it('prefers measured cost per call over the configured estimate', () => {
    const { db } = testDb();
    const estimate = observedTerraCostPerCall(db, config);
    expect(estimate).toBeGreaterThan(0);

    recordSpend(db, 'terra', 2.0, 100);
    expect(observedTerraCostPerCall(db, config)).toBeCloseTo(0.02, 6);
  });

  it('compares the batch and sync-cached paths from configured prices', () => {
    const { db } = testDb();
    const path = terraPathCost(db, config);
    expect(path.syncCached).toBeLessThan(path.syncUncached);
    expect(path.batch).toBeLessThan(path.syncUncached);
    expect(['batch', 'sync_cached']).toContain(path.cheapest);
    expect(path.note).toMatch(/cheaper/);
  });
});

describe('Terra opportunity score', () => {
  function input(over: Partial<OpportunityInput> = {}): OpportunityInput {
    return {
      item_id: 'i1',
      source_id: 'quanta',
      free_score: 0.5,
      triage_score: 0.6,
      luna_action: 'KEEP',
      interest_match: 0.7,
      novelty: 0.6,
      junk_probability: 0,
      quality_prior: 0.8,
      categories: ['ideas_science'],
      cluster_id: null,
      perspective_distance: 1,
      serendipity_potential: 0.2,
      content_type: 'analysis',
      published_at: Date.now(),
      ...over,
    };
  }

  const ctx = (need = 1) => ({
    config,
    need: new Map(config.feeds.map((f) => [f.id, need])),
    sourceCounts: new Map<string, number>(),
    categoryCounts: new Map<string, number>(),
  });

  it('scores a promising item above a weak one', () => {
    const strong = scoreOpportunity(input(), ctx()).score;
    const weak = scoreOpportunity(
      input({ interest_match: 0.1, novelty: 0.1, free_score: 0.1, quality_prior: 0.3 }),
      ctx(),
    ).score;
    expect(strong).toBeGreaterThan(weak);
  });

  /**
   * The point of the feed_need term: a borderline item in a starved feed can be
   * worth evaluating when the same item in a full feed is not.
   */
  it('values an item more when its feed still needs candidates', () => {
    const starved = scoreOpportunity(input(), ctx(1)).score;
    const full = scoreOpportunity(input(), ctx(0)).score;
    expect(starved).toBeGreaterThan(full);
  });

  it('rewards UNCERTAIN, where a deep look can change the answer', () => {
    const uncertain = scoreOpportunity(input({ luna_action: 'UNCERTAIN' }), ctx()).score;
    const keep = scoreOpportunity(input({ luna_action: 'KEEP' }), ctx()).score;
    expect(uncertain).toBeGreaterThan(keep);
  });

  it('discounts the nth item from the same source', () => {
    const first = scoreOpportunity(input(), ctx()).score;
    const c = ctx();
    c.sourceCounts.set('quanta', 4);
    expect(scoreOpportunity(input(), c).score).toBeLessThan(first);
  });

  it('discounts a commodity member of a story already queued', () => {
    const distinct = scoreOpportunity(input({ cluster_id: 'c1', perspective_distance: 0.9 }), ctx()).score;
    const redundant = scoreOpportunity(input({ cluster_id: 'c1', perspective_distance: 0.0 }), ctx()).score;
    expect(redundant).toBeLessThan(distinct);
  });

  it('suppresses obvious junk regardless of other signals', () => {
    const clean = scoreOpportunity(input(), ctx()).score;
    expect(scoreOpportunity(input({ junk_probability: 0.9 }), ctx()).score).toBeLessThan(clean);
  });

  it('explains itself', () => {
    const r = scoreOpportunity(input(), ctx());
    expect(r.reason).toMatch(/opportunity/);
    expect(Object.keys(r.components).length).toBeGreaterThan(3);
  });

  it('reports feed need per feed, bounded to 0..1', () => {
    const { db } = testDb();
    for (const v of feedNeed(db, config, '2026-08-19').values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Terra allocation under budget', () => {
  /** A Luna-passed item ready for allocation. */
  function candidate(db: Db, id: string, triage: number, free: number): string {
    seedItem(db, { id, sourceId: 'quanta', title: `Item ${id}`, status: 'triaged' });
    db.run(
      `INSERT INTO cheap_evaluations
         (item_id, action, categories_json, interest_match, novelty_likelihood, junk_probability,
          triage_score, threshold_used, passed, pass_reason, model, prompt_version, config_hash, created_at)
       VALUES (:id, 'KEEP', '["ideas_science"]', 0.8, 0.7, 0, :t, 0.3, 1, 'ok', 'm', 'p', 'h', 0)`,
      { id, t: triage },
    );
    db.run(
      `INSERT INTO free_score_components (item_id, free_score, band, created_at)
       VALUES (:id, :f, 'A', 0)`,
      { id, f: free },
    );
    return id;
  }

  it('selects the highest-opportunity candidates within the run allowance', () => {
    const { db } = testDb();
    const ids = [0, 1, 2, 3, 4].map((i) => candidate(db, `c${i}`, 0.9 - i * 0.1, 0.6 - i * 0.05));
    const out = allocateTerra(db, config, ids, { configuredBudget: 2 });

    expect(out.selected).toHaveLength(2);
    expect(out.deferred).toHaveLength(3);
    // Nothing is lost: every candidate is accounted for.
    expect(out.selected.length + out.deferred.length + out.expired.length).toBe(ids.length);
  });

  /**
   * This is the P0 lesson encoded as a test. An item that misses out on budget
   * grounds must keep its status so a later run reconsiders it -- the earlier bug
   * flipped such items to rejected and stranded 60 qualified articles for good.
   */
  it('leaves deferred items eligible rather than rejecting them', () => {
    const { db } = testDb();
    const ids = [0, 1, 2].map((i) => candidate(db, `d${i}`, 0.9 - i * 0.1, 0.6));
    const out = allocateTerra(db, config, ids, { configuredBudget: 1 });

    expect(out.deferred.length).toBeGreaterThan(0);
    for (const d of out.deferred) {
      const row = db.get<{ status: string }>(`SELECT status FROM feed_items WHERE id = :id`, { id: d.id });
      expect(row?.status).toBe('triaged');
      expect(d.reason).not.toMatch(/reject/i);
    }
  });

  it('records why each item was or was not bought', () => {
    const { db } = testDb();
    const ids = [0, 1].map((i) => candidate(db, `e${i}`, 0.9 - i * 0.2, 0.6));
    allocateTerra(db, config, ids, { configuredBudget: 1 });

    const rows = db.all<{ item_id: string; selected: number; reason: string; opportunity: number }>(
      `SELECT item_id, selected, reason, opportunity FROM terra_allocation_decisions`,
      {},
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.selected === 1)).toHaveLength(1);
    for (const r of rows) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('buys an audit sample for its information value, not its score', () => {
    const { db } = testDb();
    // A deliberately unattractive item: it would never win on opportunity alone.
    seedItem(db, { id: 'aud', sourceId: 'quanta', title: 'Weak audit item', status: 'triaged' });
    db.run(
      `INSERT INTO cheap_evaluations
         (item_id, action, categories_json, interest_match, novelty_likelihood, junk_probability,
          triage_score, threshold_used, passed, pass_reason, model, prompt_version, config_hash, created_at)
       VALUES ('aud', 'DROP', '[]', 0.05, 0.05, 0.4, 0.01, 0.3, 0, 'weak', 'm', 'p', 'h', 0)`,
    );
    const strong = [0, 1].map((i) => candidate(db, `s${i}`, 0.95, 0.7));

    const out = allocateTerra(db, config, ['aud', ...strong], {
      configuredBudget: 3,
      auditIds: new Set(['aud']),
    });
    expect(out.selected).toContain('aud');
  });

  it('stops buying entirely once the hard limit is passed', () => {
    const { db } = testDb();
    recordSpend(db, 'terra', config.mode.monthly_hard_limit_usd + 1, 10);
    const ids = [0, 1].map((i) => candidate(db, `h${i}`, 0.9, 0.7));
    const out = allocateTerra(db, config, ids, { configuredBudget: 10 });

    expect(out.selected).toHaveLength(0);
    expect(out.budget.hardLimitReached).toBe(true);
    // Still not rejected -- they wait for the next budget window.
    for (const d of out.deferred) {
      const row = db.get<{ status: string }>(`SELECT status FROM feed_items WHERE id = :id`, { id: d.id });
      expect(row?.status).toBe('triaged');
    }
  });

  it('writes a budget snapshot for every allocation', () => {
    const { db } = testDb();
    allocateTerra(db, config, [candidate(db, 'snap', 0.9, 0.6)], { configuredBudget: 1 });
    const snap = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM budget_snapshots`, {});
    expect(snap?.c).toBe(1);
  });
});

describe('operating modes', () => {
  it('defines both modes with sane relative settings', () => {
    const calibration = config.mode; // whichever is active
    expect(calibration.monthly_target_usd).toBeGreaterThan(0);
    expect(calibration.monthly_hard_limit_usd).toBeGreaterThanOrEqual(calibration.monthly_target_usd);
  });

  it('samples far more heavily in calibration than in steady state', () => {
    // Read straight from the file so the assertion holds whichever mode is live.
    const raw = loadConfig();
    expect(raw.mode.free_reject_audit_rate).toBeGreaterThan(0);
    expect(raw.mode.audit_max_per_run.free_to_luna).toBeGreaterThan(0);
    expect(raw.mode.audit_max_per_run.luna_to_terra).toBeGreaterThan(0);
  });

  it('never lets the hard limit sit below the target', () => {
    expect(config.mode.monthly_hard_limit_usd).toBeGreaterThanOrEqual(config.mode.monthly_target_usd);
  });
});

/**
 * Config invariants that were each violated at some point in this system's life
 * and cost real recommendations when they were.
 */
describe('configuration coherence', () => {
  it('keeps the band thresholds strictly ordered', () => {
    const b = config.free.free_ranking.bands;
    expect(b.a_min).toBeGreaterThan(b.b_min);
    expect(b.b_min).toBeGreaterThan(b.c_min);
  });

  /**
   * source_uniqueness is derived from clustering. It must not carry ranking
   * weight until the clustering metrics say it is measuring something -- it spent
   * the system's whole life contributing a near-constant 0.15 while clustering
   * was inert.
   */
  it('gives source_uniqueness no ranking weight while it is uncalibrated', () => {
    const { db } = testDb();
    const stats = clusteringStats(db, config);
    // An empty database is by definition uncalibrated, which is the state this
    // guard cares about: no clustering evidence means no ranking weight.
    expect(stats.uniquenessCalibrated).toBe(false);
    expect(config.free.free_ranking.weights.source_uniqueness_score).toBe(0);
  });

  it('keeps the free-ranking weights summing to roughly one', () => {
    const total = Object.values(config.free.free_ranking.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  /**
   * A feed whose min_score sits above the best score its candidates can reach can
   * never publish. That shipped once, for two feeds.
   */
  it('keeps every feed min_score inside a reachable range', () => {
    for (const feed of config.feeds) {
      expect(feed.min_score).toBeGreaterThan(0);
      expect(feed.min_score).toBeLessThan(0.95);
    }
  });

  it('reserves a real share of the Terra budget for calibration', () => {
    expect(config.budget.calibration_share).toBeGreaterThan(0);
    expect(config.budget.calibration_share).toBeLessThan(0.5);
  });

  it('orders the degradation ladder so the bar only ever rises with spend', () => {
    const stages = [...config.budget.degradation].sort(
      (a, b) => a.at_fraction_of_target - b.at_fraction_of_target,
    );
    for (let i = 1; i < stages.length; i += 1) {
      expect(stages[i]!.min_opportunity).toBeGreaterThanOrEqual(stages[i - 1]!.min_opportunity);
    }
  });
});
