/**
 * Choose who Terra sees, under a budget.
 *
 * Selection used to be `ORDER BY triage_score DESC LIMIT 60`: the highest Luna
 * scores, up to a fixed count, regardless of what the money situation was or
 * whether another item in that category would improve anything.
 *
 * Now it is an allocation problem. Each candidate gets a deterministic
 * opportunity score, the budget decides how strict the bar is and how many calls
 * are affordable, and items that miss out keep their state so a later run can
 * reconsider them. Nothing is rejected for want of budget -- that was the P0 bug
 * this pipeline already learned once.
 */
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import {
  budgetState,
  affordableTerraCalls,
  passesHardLimitReservation,
  isStillEligible,
  type BudgetState,
} from '../pipeline/budget.js';
import { feedNeed, scoreOpportunity, type OpportunityInput, type OpportunityResult } from './terraOpportunity.js';
import { logger } from '../util/log.js';

const log = logger('terra-alloc');

export interface AllocationOutcome {
  selected: string[];
  /** Not selected this run, and why. These keep their status and come back. */
  deferred: Array<{ id: string; reason: string; opportunity: number }>;
  /** Aged out by content type; no longer worth reconsidering. */
  expired: Array<{ id: string; reason: string }>;
  budget: BudgetState;
  affordable: number;
  affordableReason: string;
  scored: OpportunityResult[];
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function loadCandidates(db: Db, config: AppConfig, ids: string[]): OpportunityInput[] {
  if (ids.length === 0) return [];
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const rows = db.all<{
    item_id: string;
    source_id: string;
    free_score: number;
    triage_score: number;
    luna_action: string | null;
    interest_match: number;
    novelty: number;
    junk_probability: number;
    categories_json: string | null;
    cluster_id: string | null;
    perspective_distance: number;
    serendipity_candidate: number;
    published_at: number | null;
  }>(
    `SELECT fi.id AS item_id, fi.source_id,
            COALESCE(f.free_score, 0) AS free_score,
            COALESCE(ce.triage_score, 0) AS triage_score,
            ce.action AS luna_action,
            COALESCE(ce.interest_match, 0) AS interest_match,
            COALESCE(ce.novelty_likelihood, 0) AS novelty,
            COALESCE(ce.junk_probability, 0) AS junk_probability,
            ce.categories_json,
            fi.cluster_id,
            COALESCE(m.perspective_distance, 1) AS perspective_distance,
            COALESCE(ce.serendipity_candidate, 0) AS serendipity_candidate,
            COALESCE(fi.publication_time, fi.first_seen_at) AS published_at
     FROM feed_items fi
     LEFT JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN free_score_components f ON f.item_id = fi.id
     LEFT JOIN story_cluster_members m ON m.item_id = fi.id AND m.cluster_id = fi.cluster_id
     WHERE fi.id IN (${ids.map((_, i) => `:id${i}`).join(',')})`,
    params,
  );

  const priors = new Map(config.sources.map((s) => [s.id, s.quality_prior]));
  // Content type comes from the source definition; it decides how long a
  // deferred item stays worth reconsidering.
  const contentTypes = new Map(config.sources.map((s) => [s.id, s.hard_rules?.content_type ?? null]));
  return rows.map((r) => {
    let categories: string[] = [];
    try {
      const parsed = JSON.parse(r.categories_json ?? '[]');
      if (Array.isArray(parsed)) categories = parsed.filter((c): c is string => typeof c === 'string');
    } catch { /* a malformed list just means no category hint */ }

    return {
      item_id: r.item_id,
      source_id: r.source_id,
      free_score: r.free_score,
      triage_score: r.triage_score,
      luna_action: r.luna_action,
      interest_match: r.interest_match,
      novelty: r.novelty,
      junk_probability: r.junk_probability,
      quality_prior: priors.get(r.source_id) ?? 0.5,
      categories,
      cluster_id: r.cluster_id,
      perspective_distance: r.perspective_distance,
      // Luna already judges this directly; no need to re-derive it.
      serendipity_potential: r.serendipity_candidate
        ? Math.max(0.5, r.novelty)
        : Math.min(1, r.novelty * (1 - r.interest_match) * 2),
      content_type: contentTypes.get(r.source_id) ?? null,
      published_at: r.published_at,
    };
  });
}

export function allocateTerra(
  db: Db,
  config: AppConfig,
  candidateIds: string[],
  opts: { configuredBudget: number; auditIds?: Set<string>; jobId?: string; now?: number } = {
    configuredBudget: 60,
  },
): AllocationOutcome {
  const now = opts.now ?? Date.now();
  const state = budgetState(db, config, now);
  const { calls: affordable, reason: affordableReason } = affordableTerraCalls(
    db,
    config,
    state,
    opts.configuredBudget,
  );

  const candidates = loadCandidates(db, config, candidateIds);
  const need = feedNeed(db, config, dayKey(now));
  const auditIds = opts.auditIds ?? new Set<string>();

  // Audits get a protected slice of the run so budget pressure cannot silently
  // switch off the only measurement of what the funnel discards.
  const auditReserve = Math.max(
    auditIds.size > 0 ? 1 : 0,
    Math.round(affordable * config.budget.calibration_share),
  );

  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  // Score everything first, then take greedily. Saturation penalties depend on
  // what has already been taken, so scores are recomputed as the run fills up.
  const remaining = [...candidates];
  const selected: string[] = [];
  const deferred: AllocationOutcome['deferred'] = [];
  const expired: AllocationOutcome['expired'] = [];
  const scored: OpportunityResult[] = [];

  // Anything too old to matter leaves the queue for good.
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const c = remaining[i]!;
    if (auditIds.has(c.item_id)) continue;
    if (!isStillEligible(config, c.content_type, c.published_at, now)) {
      expired.push({
        id: c.item_id,
        reason: `aged out as ${c.content_type ?? 'default'} content without reaching Terra`,
      });
      remaining.splice(i, 1);
    }
  }

  let auditsTaken = 0;
  while (remaining.length > 0 && selected.length < affordable) {
    const ranked = remaining
      .map((c) => ({
        c,
        r: scoreOpportunity(c, { config, need, sourceCounts, categoryCounts }),
      }))
      .sort((a, b) => b.r.score - a.r.score);

    const isAuditSlotFree = auditsTaken < auditReserve;
    // Prefer an audit sample while the reserve is unspent: those observations are
    // the point of the reserve.
    const pick =
      (isAuditSlotFree ? ranked.find((x) => auditIds.has(x.c.item_id)) : undefined) ?? ranked[0]!;

    const isAudit = auditIds.has(pick.c.item_id);
    const meetsBar = pick.r.score >= state.minOpportunity;
    const reservationOk = passesHardLimitReservation(state, {
      essentialCandidate: pick.r.essential_candidate,
      serendipity: pick.r.serendipity,
      audit: isAudit,
    });

    // An audit sample is bought for its information value, not its score.
    if (!isAudit && (!meetsBar || !reservationOk)) {
      // Everything below the bar is below it: nothing further can qualify, since
      // the list is sorted and saturation only pushes scores down.
      for (const x of ranked) {
        if (auditIds.has(x.c.item_id)) continue;
        deferred.push({
          id: x.c.item_id,
          opportunity: x.r.score,
          reason: !reservationOk
            ? `hard limit reached; reserved for ${state.reservedFor.join('/')}`
            : `opportunity ${x.r.score.toFixed(3)} below ${state.minOpportunity.toFixed(2)} (${state.stage})`,
        });
        scored.push(x.r);
      }
      remaining.length = 0;
      break;
    }

    selected.push(pick.c.item_id);
    scored.push(pick.r);
    if (isAudit) auditsTaken += 1;
    sourceCounts.set(pick.c.source_id, (sourceCounts.get(pick.c.source_id) ?? 0) + 1);
    for (const cat of pick.c.categories) {
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
    remaining.splice(remaining.indexOf(pick.c), 1);
  }

  // Whatever is left over simply did not fit in this run's allowance.
  for (const c of remaining) {
    const r = scoreOpportunity(c, { config, need, sourceCounts, categoryCounts });
    deferred.push({
      id: c.item_id,
      opportunity: r.score,
      reason: `run allowance of ${affordable} Terra calls spent (${affordableReason})`,
    });
    scored.push(r);
  }

  recordAllocation(db, { state, scored, selected, deferred, auditIds, jobId: opts.jobId, now });

  log.info(
    `Terra allocation: ${selected.length} selected of ${candidates.length} candidates ` +
    `(${auditsTaken} audits), ${deferred.length} deferred, ${expired.length} expired. ` +
    `budget ${state.stage}: $${state.spentUsd.toFixed(3)} of $${state.targetUsd} ` +
    `(min opportunity ${state.minOpportunity.toFixed(2)})`,
  );

  return {
    selected,
    deferred,
    expired,
    budget: state,
    affordable,
    affordableReason,
    scored,
  };
}

function recordAllocation(
  db: Db,
  args: {
    state: BudgetState;
    scored: OpportunityResult[];
    selected: string[];
    deferred: AllocationOutcome['deferred'];
    auditIds: Set<string>;
    jobId?: string;
    now: number;
  },
): void {
  const chosen = new Set(args.selected);
  const reasons = new Map(args.deferred.map((d) => [d.id, d.reason]));

  db.transaction(() => {
    for (const r of args.scored) {
      db.run(
        `INSERT INTO terra_allocation_decisions
           (item_id, job_id, opportunity, components_json, feed_need, min_opportunity,
            budget_stage, selected, reason, is_audit, created_at)
         VALUES (:id, :job, :opp, :comp, :need, :min, :stage, :sel, :reason, :audit, :ts)
         ON CONFLICT(item_id, created_at) DO NOTHING`,
        {
          id: r.item_id,
          job: args.jobId ?? null,
          opp: r.score,
          comp: JSON.stringify(r.components),
          need: r.feed_need,
          min: args.state.minOpportunity,
          stage: args.state.stage,
          sel: chosen.has(r.item_id) ? 1 : 0,
          reason: chosen.has(r.item_id) ? r.reason : (reasons.get(r.item_id) ?? r.reason),
          audit: args.auditIds.has(r.item_id) ? 1 : 0,
          ts: args.now,
        },
      );
    }

    db.run(
      `INSERT INTO budget_snapshots
         (month_key, job_id, spent_usd, luna_usd, terra_usd, target_usd, hard_limit_usd,
          projected_usd, stage, mode, created_at)
       VALUES (:m, :job, :spent, :luna, :terra, :target, :limit, :proj, :stage, :mode, :ts)
       ON CONFLICT(month_key, created_at) DO NOTHING`,
      {
        m: args.state.monthKey,
        job: args.jobId ?? null,
        spent: args.state.spentUsd,
        luna: args.state.lunaUsd,
        terra: args.state.terraUsd,
        target: args.state.targetUsd,
        limit: args.state.hardLimitUsd,
        proj: args.state.projectedMonthEndUsd,
        stage: args.state.stage,
        mode: args.state.stage,
        ts: args.now,
      },
    );
  });
}
