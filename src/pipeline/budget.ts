/**
 * Month-to-date spend, and what the pipeline gives up as it runs out.
 *
 * Terra is ~98% of this system's cost, so "budget" here means, almost entirely,
 * how many deep evaluations get bought and which ones. Two rules shape the
 * design:
 *
 *   Degrade, do not stop. Approaching the limit raises the bar for a Terra call
 *   rather than halting the pipeline. The feed keeps working, more selectively.
 *
 *   Never discard an item for want of budget. Items that miss the cut keep their
 *   state and are reconsidered on a later run, until they age out by content
 *   type. Running out of money must not corrupt the funnel, which is exactly
 *   what the earlier Terra-budget bug did.
 *
 * Prices come from models.yaml via the existing cost accounting. Nothing here
 * knows what a token costs.
 */
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';

export interface BudgetState {
  monthKey: string;
  spentUsd: number;
  lunaUsd: number;
  terraUsd: number;
  targetUsd: number;
  hardLimitUsd: number;
  /** Spend so far divided by the month's target. Can exceed 1. */
  fractionOfTarget: number;
  remainingToTargetUsd: number;
  remainingToHardLimitUsd: number;
  /** Minimum opportunity score an item must clear right now. */
  minOpportunity: number;
  /** Human-readable degradation stage, e.g. "approaching target". */
  stage: string;
  /** At the hard limit only reserved categories still buy a Terra call. */
  hardLimitReached: boolean;
  reservedFor: string[];
  /** Projected month-end spend from the run rate so far. */
  projectedMonthEndUsd: number;
  daysElapsed: number;
  daysInMonth: number;
}

export function monthKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(now: number): number {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Spend recorded this calendar month, split by the roles that matter. */
export function monthToDateSpend(
  db: Db,
  now = Date.now(),
): { total: number; luna: number; terra: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const rows = db.all<{ stage: string; cost: number }>(
    `SELECT stage, SUM(estimated_cost) AS cost FROM api_usage WHERE created_at >= :start GROUP BY stage`,
    { start },
  );
  let total = 0, luna = 0, terra = 0;
  for (const r of rows) {
    const c = r.cost ?? 0;
    total += c;
    if (r.stage === 'luna' || r.stage === 'cheap' || r.stage === 'triage') luna += c;
    if (r.stage === 'terra' || r.stage === 'deep') terra += c;
  }
  return { total, luna, terra };
}

export function budgetState(db: Db, config: AppConfig, now = Date.now()): BudgetState {
  const spend = monthToDateSpend(db, now);
  const target = config.mode.monthly_target_usd;
  const hardLimit = config.mode.monthly_hard_limit_usd;
  const fraction = target > 0 ? spend.total / target : 0;

  // Highest degradation stage whose trigger has been passed.
  const stages = [...config.budget.degradation].sort(
    (a, b) => a.at_fraction_of_target - b.at_fraction_of_target,
  );
  let active = stages[0]!;
  for (const s of stages) if (fraction >= s.at_fraction_of_target) active = s;

  const day = new Date(now).getUTCDate();
  const total = daysInMonth(now);

  return {
    monthKey: monthKey(now),
    spentUsd: spend.total,
    lunaUsd: spend.luna,
    terraUsd: spend.terra,
    targetUsd: target,
    hardLimitUsd: hardLimit,
    fractionOfTarget: fraction,
    remainingToTargetUsd: Math.max(0, target - spend.total),
    remainingToHardLimitUsd: Math.max(0, hardLimit - spend.total),
    minOpportunity: active.min_opportunity,
    stage: active.label,
    hardLimitReached: spend.total >= hardLimit,
    reservedFor: config.budget.hard_limit_reserved_for,
    projectedMonthEndUsd: day > 0 ? (spend.total / day) * total : spend.total,
    daysElapsed: day,
    daysInMonth: total,
  };
}

/**
 * How many Terra calls this run can afford, from the money left before the hard
 * limit and the observed cost of a call.
 */
export function affordableTerraCalls(
  db: Db,
  config: AppConfig,
  state: BudgetState,
  configuredBudget: number,
): { calls: number; reason: string } {
  if (state.hardLimitReached) {
    return { calls: 0, reason: `hard limit $${state.hardLimitUsd} reached for ${state.monthKey}` };
  }

  const perCall = observedTerraCostPerCall(db, config);
  // Spread what is left over the days remaining, so a single backlog run cannot
  // consume the whole month in one afternoon.
  const daysLeft = Math.max(1, state.daysInMonth - state.daysElapsed + 1);
  const dailyAllowance = state.remainingToHardLimitUsd / daysLeft;
  const affordable = perCall > 0 ? Math.floor(dailyAllowance / perCall) : configuredBudget;

  if (affordable >= configuredBudget) {
    return { calls: configuredBudget, reason: 'within budget' };
  }
  return {
    calls: Math.max(0, affordable),
    reason:
      `budget-limited: $${dailyAllowance.toFixed(3)} available today ` +
      `at ~$${perCall.toFixed(4)}/call (${state.stage})`,
  };
}

/**
 * Average cost of a Terra call, measured rather than assumed. Falls back to the
 * configured prices and a typical token count before any calls exist.
 */
export function observedTerraCostPerCall(db: Db, config: AppConfig): number {
  const row = db.get<{ cost: number; calls: number }>(
    `SELECT SUM(estimated_cost) AS cost, SUM(requests) AS calls
     FROM api_usage WHERE stage IN ('terra', 'deep')`,
    {},
  );
  if (row && row.calls > 0 && row.cost > 0) return row.cost / row.calls;

  const deep = config.models.models.deep;
  const assumedInput = 3_000;
  const assumedOutput = 350;
  return (
    (assumedInput / 1e6) * deep.cost_per_1m_input + (assumedOutput / 1e6) * deep.cost_per_1m_output
  );
}

/**
 * At the hard limit, only a few categories still justify a call. Everything else
 * waits for the next window -- it is deferred, never rejected.
 */
export function passesHardLimitReservation(
  state: BudgetState,
  flags: { essentialCandidate: boolean; serendipity: boolean; audit: boolean },
): boolean {
  if (!state.hardLimitReached) return true;
  const reserved = new Set(state.reservedFor);
  if (reserved.has('essential_candidate') && flags.essentialCandidate) return true;
  if (reserved.has('serendipity') && flags.serendipity) return true;
  if (reserved.has('audit') && flags.audit) return true;
  return false;
}

/**
 * Has a deferred item aged out of usefulness? Breaking news is worthless a week
 * later; an essay is not. This is what stops the deferred queue growing forever.
 */
export function isStillEligible(
  config: AppConfig,
  contentType: string | null,
  publishedAt: number | null,
  now = Date.now(),
): boolean {
  if (!publishedAt) return true;
  const limits = config.budget.requeue_max_age_hours;
  const maxHours = limits[contentType ?? 'default'] ?? limits.default ?? 336;
  return (now - publishedAt) / 3_600_000 <= maxHours;
}

export interface PathCost {
  syncUncached: number;
  syncCached: number;
  batch: number;
  cheapest: 'sync_cached' | 'batch';
  advantagePercent: number;
  note: string;
}

/**
 * Is a Terra call cheaper synchronously with prompt caching, or through the batch
 * API? Both discounts are real but they do not compose -- the batch API does not
 * apply prompt caching -- so this is a genuine either/or.
 *
 * Measured at the observed token shape (~3,500 input, ~2,500 of it the cacheable
 * prompt prefix), batch wins: its flat 50% beats caching's effective 44%, because
 * the cacheable prefix is only about 70% of the input and cached tokens still
 * cost a tenth of full price. Batch is therefore kept, and no routing layer was
 * built for a saving that does not exist.
 *
 * The conclusion depends entirely on the prefix share, which changes if the
 * prompt grows or articles get shorter. This function exists so that stays
 * checkable rather than becoming folklore -- `npm run costs` prints it.
 */
export function terraPathCost(db: Db, config: AppConfig): PathCost {
  const deep = config.models.models.deep;
  const M = 1e6;

  const observed = db.get<{ i: number; o: number; n: number }>(
    `SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(requests) AS n
     FROM api_usage WHERE stage IN ('terra', 'deep')`,
    {},
  );
  const calls = observed?.n ?? 0;
  const inputTokens = calls > 0 ? (observed!.i ?? 0) / calls : 3_500;
  const outputTokens = calls > 0 ? (observed!.o ?? 0) / calls : 300;

  // The cacheable portion is the rendered prompt prefix, which is identical on
  // every call. Approximated from characters at ~3.9 chars/token.
  const prefixTokens = Math.min(inputTokens, 2_512);
  const cachedPrice = deep.cost_per_1m_cached_input ?? deep.cost_per_1m_input;

  const output = (outputTokens * deep.cost_per_1m_output) / M;
  const syncUncached = (inputTokens * deep.cost_per_1m_input) / M + output;
  const syncCached =
    ((inputTokens - prefixTokens) * deep.cost_per_1m_input + prefixTokens * cachedPrice) / M + output;
  const batch = syncUncached * 0.5;

  const cheapest = syncCached <= batch ? 'sync_cached' : 'batch';
  const advantage = Math.abs(1 - Math.min(syncCached, batch) / Math.max(syncCached, batch)) * 100;

  return {
    syncUncached,
    syncCached,
    batch,
    cheapest,
    advantagePercent: advantage,
    note:
      `at ${Math.round(inputTokens)} input tokens/call (${Math.round(prefixTokens)} cacheable), ` +
      `${cheapest === 'batch' ? 'batch' : 'sync+cache'} is ${advantage.toFixed(1)}% cheaper` +
      (calls === 0 ? ' [estimated; no calls recorded yet]' : ''),
  };
}
