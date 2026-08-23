import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { DAY_MS } from '../util/time.js';

/**
 * Per-stage funnel and cost accounting.
 *
 * api_usage records individual model calls; this rolls a run up per stage so the
 * funnel can be read end to end, and so cost can be expressed in the units that
 * actually matter: cost per surfaced item, per opened item, per item the reader
 * explicitly liked.
 *
 * These numbers are exposed, not optimised against. Optimising a recommender
 * directly on cost-per-open is how you end up with a cheap engagement machine.
 */

export type Stage = 'aggregate' | 'rules' | 'free' | 'luna' | 'terra' | 'final';

export function recordStageCost(
  db: Db,
  jobId: string,
  stage: Stage,
  input: { itemsIn?: number; itemsOut?: number; model?: string; durationMs?: number },
): void {
  // Token and dollar figures come from api_usage for this job and stage, so they
  // stay consistent with the ledger rather than being counted twice.
  const usage = db.get<{
    calls: number;
    input_tokens: number;
    cached: number;
    output_tokens: number;
    cost: number;
  }>(
    `SELECT COALESCE(SUM(requests), 0) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(cached_input_tokens), 0) AS cached,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(estimated_cost), 0) AS cost
     FROM api_usage
     WHERE job_id = :job AND stage = :apiStage`,
    { job: jobId, apiStage: stage === 'luna' ? 'cheap' : stage === 'terra' ? 'deep' : stage },
  );

  db.run(
    `INSERT INTO pipeline_costs (job_id, stage, items_in, items_out, api_calls, input_tokens,
                                 cached_input_tokens, output_tokens, estimated_cost, duration_ms, created_at)
     VALUES (:job, :stage, :in, :out, :calls, :inTok, :cached, :outTok, :cost, :ms, :ts)
     ON CONFLICT(job_id, stage) DO UPDATE SET
       items_in = excluded.items_in, items_out = excluded.items_out,
       api_calls = excluded.api_calls, input_tokens = excluded.input_tokens,
       cached_input_tokens = excluded.cached_input_tokens,
       output_tokens = excluded.output_tokens, estimated_cost = excluded.estimated_cost,
       duration_ms = excluded.duration_ms`,
    {
      job: jobId,
      stage,
      in: input.itemsIn ?? 0,
      out: input.itemsOut ?? 0,
      calls: usage?.calls ?? 0,
      inTok: usage?.input_tokens ?? 0,
      cached: usage?.cached ?? 0,
      outTok: usage?.output_tokens ?? 0,
      cost: usage?.cost ?? 0,
      ms: input.durationMs ?? 0,
      ts: Date.now(),
    },
  );
}

export interface FunnelStage {
  stage: string;
  label: string;
  items: number;
  /** Share of the previous stage that survived. */
  survivalRate: number | null;
  cost: number;
  apiCalls: number;
}

/**
 * The funnel as a table, over a configurable window. Mirrors the seven stages so
 * the shape of the real funnel can be compared against the design target.
 */
export function funnelReport(db: Db, days = 30): FunnelStage[] {
  const since = Date.now() - days * DAY_MS;
  const one = (sql: string, params: Record<string, unknown> = {}): number =>
    db.get<{ c: number }>(sql, { since, ...params })?.c ?? 0;

  const cost = (stage: string): { cost: number; calls: number } => {
    const row = db.get<{ cost: number; calls: number }>(
      `SELECT COALESCE(SUM(estimated_cost), 0) AS cost, COALESCE(SUM(api_calls), 0) AS calls
       FROM pipeline_costs WHERE stage = :s AND created_at >= :since`,
      { s: stage, since },
    );
    return { cost: row?.cost ?? 0, calls: row?.calls ?? 0 };
  };

  const raw = one(`SELECT COUNT(*) AS c FROM feed_items WHERE first_seen_at >= :since`);
  const afterRules = one(
    `SELECT COUNT(*) AS c FROM rule_filter_evaluations r
     JOIN feed_items fi ON fi.id = r.item_id
     WHERE fi.first_seen_at >= :since AND r.filter_result = 'keep'`,
  );
  const freeScored = one(
    `SELECT COUNT(*) AS c FROM free_score_components f
     JOIN feed_items fi ON fi.id = f.item_id WHERE fi.first_seen_at >= :since`,
  );
  const lunaCalls = one(
    `SELECT COUNT(*) AS c FROM cheap_evaluations ce
     JOIN feed_items fi ON fi.id = ce.item_id WHERE fi.first_seen_at >= :since`,
  );
  const lunaSurvivors = one(
    `SELECT COUNT(*) AS c FROM cheap_evaluations ce
     JOIN feed_items fi ON fi.id = ce.item_id
     WHERE fi.first_seen_at >= :since AND ce.passed = 1`,
  );
  const terraCalls = one(
    `SELECT COUNT(*) AS c FROM deep_evaluations de
     JOIN feed_items fi ON fi.id = de.item_id WHERE fi.first_seen_at >= :since`,
  );
  const terraStrong = one(
    `SELECT COUNT(DISTINCT r.item_id) AS c FROM final_ranking_decisions r
     JOIN feed_items fi ON fi.id = r.item_id
     WHERE fi.first_seen_at >= :since AND r.final_score >= r.threshold`,
  );
  const published = one(
    `SELECT COUNT(DISTINCT item_id) AS c FROM published_feed_items WHERE published_at >= :since`,
  );

  const lunaCost = cost('luna');
  const terraCost = cost('terra');
  const freeCost = cost('free');

  const rows: Array<Omit<FunnelStage, 'survivalRate'>> = [
    { stage: 'aggregate', label: 'raw aggregated', items: raw, cost: 0, apiCalls: 0 },
    { stage: 'rules', label: 'after hard filters', items: afterRules, cost: 0, apiCalls: 0 },
    {
      stage: 'free',
      label: 'free-ranker candidates',
      items: freeScored,
      cost: freeCost.cost,
      apiCalls: freeCost.calls,
    },
    { stage: 'luna', label: 'Luna calls', items: lunaCalls, cost: lunaCost.cost, apiCalls: lunaCost.calls },
    { stage: 'luna_survivors', label: 'Luna survivors', items: lunaSurvivors, cost: 0, apiCalls: 0 },
    { stage: 'terra', label: 'Terra calls', items: terraCalls, cost: terraCost.cost, apiCalls: terraCost.calls },
    { stage: 'terra_strong', label: 'Terra strong candidates', items: terraStrong, cost: 0, apiCalls: 0 },
    { stage: 'published', label: 'published items', items: published, cost: 0, apiCalls: 0 },
  ];

  return rows.map((row, i) => {
    const previous = i > 0 ? rows[i - 1]!.items : null;
    return {
      ...row,
      survivalRate: previous && previous > 0 ? row.items / previous : null,
    };
  });
}

export interface CostPerOutcome {
  totalCost: number;
  lunaCost: number;
  terraCost: number;
  embeddingCost: number;
  surfaced: number;
  opened: number;
  explicitPositive: number;
  costPerSurfaced: number | null;
  costPerOpened: number | null;
  costPerPositive: number | null;
}

/**
 * Cost expressed per outcome. Exposed for inspection only: the moment a system
 * starts minimising cost-per-open, it starts preferring cheap bait.
 */
export function costPerOutcome(db: Db, _config: AppConfig, days = 30): CostPerOutcome {
  const since = Date.now() - days * DAY_MS;
  const byStage = db.all<{ stage: string; cost: number }>(
    `SELECT stage, COALESCE(SUM(estimated_cost), 0) AS cost
     FROM api_usage WHERE created_at >= :since GROUP BY stage`,
    { since },
  );
  const stageCost = (name: string) => byStage.find((s) => s.stage === name)?.cost ?? 0;

  const totalCost = byStage.reduce((s, r) => s + r.cost, 0);
  const surfaced =
    db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT item_id) AS c FROM published_feed_items WHERE published_at >= :since`,
      { since },
    )?.c ?? 0;
  const opened =
    db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT item_id) AS c FROM open_events WHERE opened_at >= :since`,
      { since },
    )?.c ?? 0;
  const positive =
    db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM explicit_feedback
       WHERE created_at >= :since AND signal = 'excellent'`,
      { since },
    )?.c ?? 0;

  return {
    totalCost,
    lunaCost: stageCost('cheap'),
    terraCost: stageCost('deep'),
    embeddingCost: stageCost('embedding'),
    surfaced,
    opened,
    explicitPositive: positive,
    costPerSurfaced: surfaced > 0 ? totalCost / surfaced : null,
    costPerOpened: opened > 0 ? totalCost / opened : null,
    costPerPositive: positive > 0 ? totalCost / positive : null,
  };
}
