import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { AiClient, SpendLimitError } from '../ai/client.js';
import { ingestAll } from '../ingest/index.js';
import { hardFilterPending } from '../filter/hardFilter.js';
import { embedMany, embedAnchors, itemEmbeddingText } from '../embed/index.js';
import { resolveSemanticProvider, providerModelKey } from '../embed/provider.js';
import { runFreeRanker } from '../rank/runFreeRanker.js';
import { refreshSourceStatistics } from '../rank/sourceStats.js';
import { refreshAttentionEstimates } from '../rank/attention.js';
import { runCheapTriage } from '../ai/cheapTriage.js';
import { clusterRecentItems, limitClusterMembers } from '../cluster/index.js';
import { allocateTerra } from '../rank/terraAllocation.js';
import { extractForItems } from '../extract/index.js';
import { evaluateArticleAccess } from '../extract/access.js';
import { runDeepEvaluation } from '../ai/deepEval.js';
import { pendingBatchItemIds } from '../ai/batch.js';
import { publishEditions } from '../rank/publishEdition.js';
import { resolveAlternateFormats, suppressDuplicateEpisodes } from '../alternate/index.js';
import { resolveAuditSamples } from './audit.js';
import { recordStageCost } from './costs.js';
import { startJob, setStatus } from './journal.js';
import { logger } from '../util/log.js';
import { withLock } from '../util/lock.js';
import { runClassics } from '../classics/index.js';

const log = logger('pipeline');

/**
 * The funnel, in order:
 *
 *   1 Aggregation      FREE       "what was published?"
 *   2 Rule filtering   FREE       "what is obviously not worth considering?"
 *   3 Free scoring     FREE       "what deserves computational attention?"
 *   4 Luna             CHEAP      "what plausibly deserves human attention?"
 *   5 Terra            EXPENSIVE  "what genuinely deserves human attention?"
 *   6 Final ranking    FREE       "what combination creates the best edition?"
 *   7 Generated feeds
 *
 * Each stage spends more per item than the last, and each only sees what earned
 * the right to be there. Every stage is independently rerunnable and driven by
 * item status, so a crash halfway through costs time and nothing else.
 */

export interface PipelineOptions {
  sourceIds?: string[];
  skipIngest?: boolean;
  skipPublish?: boolean;
  maxDeep?: number;
  now?: number;
}

export interface PipelineResult {
  aggregate?: Record<string, number>;
  rules?: Record<string, unknown>;
  semantic?: Record<string, unknown>;
  free?: Record<string, unknown>;
  cluster?: Record<string, number>;
  luna?: Record<string, unknown>;
  extract?: Record<string, number>;
  terra?: Record<string, unknown>;
  edition?: Record<string, unknown>;
  alternate?: Record<string, unknown>;
  classics?: Record<string, unknown>;
  sourceStats?: Record<string, number>;
  budget?: Record<string, unknown>;
  allocation?: Record<string, unknown>;
  spendUsd: number;
}

/**
 * Guarded here rather than at each entry point, so every caller is covered:
 * the dashboard button, the scheduler, `npm run pipeline`, and cron. Two runs
 * against one database would both pay for the same Terra evaluations.
 */
export async function runPipeline(
  db: Db,
  config: AppConfig,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  return withLock(config.env.dbPath, 'pipeline', () => runPipelineLocked(db, config, opts));
}

async function runPipelineLocked(
  db: Db,
  config: AppConfig,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const job = startJob(db, 'pipeline');
  const ai = new AiClient(config, db, job.id);
  const result: PipelineResult = { spendUsd: 0 };
  const now = opts.now ?? Date.now();

  if (ai.dryRun) {
    log.warn('dry run: no model calls will be made (stub scores are used)');
  }

  try {
    // --- 1. Aggregation ----------------------------------------------------
    // Collects content without judging it.
    if (!opts.skipIngest) {
      const stats = await ingestAll(db, config, { sourceIds: opts.sourceIds });
      result.aggregate = { ...stats };
      recordStageCost(db, job.id, 'aggregate', { itemsIn: stats.itemsSeen, itemsOut: stats.itemsNew });
    }

    // --- 2. Rule filtering -------------------------------------------------
    // Deterministic, high-precision, conservative. Records every verdict.
    const rules = hardFilterPending(db, config, now);
    result.rules = { ...rules };
    recordStageCost(db, job.id, 'rules', { itemsIn: rules.examined, itemsOut: rules.kept });

    // --- 3a. Semantic vectors ---------------------------------------------
    // The one part of stage 3 that may cost money. Behind a provider interface,
    // and it degrades to heuristics rather than failing the run.
    const provider = resolveSemanticProvider(config, ai);
    const embeddingModel = providerModelKey(config, provider);
    await embedAnchors(db, ai, config, embeddingModel, provider);

    const sourceNames = new Map(config.sources.map((s) => [s.id, s.name]));
    const toEmbed = db.all<{
      id: string;
      source_id: string;
      title: string;
      subtitle: string | null;
      rss_summary: string | null;
    }>(
      `SELECT id, source_id, title, subtitle, rss_summary FROM feed_items
       WHERE status IN ('filtered', 'new') OR (is_podcast = 1 AND status != 'error')
       ORDER BY first_seen_at DESC LIMIT 2000`,
    );

    const embedStats = await embedMany(
      db,
      ai,
      config,
      'item',
      toEmbed.map((item) => ({
        id: item.id,
        text: itemEmbeddingText(item, sourceNames.get(item.source_id) ?? item.source_id, config),
      })),
      embeddingModel,
      provider,
    );
    result.semantic = { ...embedStats, provider: provider.name };

    // Podcast items exist for alternate-format matching only; they leave the
    // recommendation funnel here rather than being filtered out repeatedly.
    db.run(
      `UPDATE feed_items SET status = 'podcast_indexed', status_updated_at = :ts
       WHERE is_podcast = 1 AND status IN ('new', 'filtered', 'embedded')`,
      { ts: now },
    );

    // --- 3b. Clustering ----------------------------------------------------
    // Before Terra, and before the free score, so redundancy is priced in.
    result.cluster = { ...clusterRecentItems(db, config, embeddingModel) };

    // Uniqueness and overlap are derived from cluster history, so refresh them
    // before the free ranker reads them.
    result.sourceStats = refreshSourceStatistics(db, config);

    // --- 3c. Free scoring --------------------------------------------------
    const free = runFreeRanker(db, config, {
      embeddingModel,
      semanticProvider: provider.name,
      now,
    });
    result.free = { ...free };
    recordStageCost(db, job.id, 'free', { itemsIn: free.scored, itemsOut: free.selectedForLuna });

    // --- 4. Luna -----------------------------------------------------------
    const luna = await runCheapTriage(db, ai, config);
    result.luna = { ...luna };
    recordStageCost(db, job.id, 'luna', {
      itemsIn: luna.evaluated,
      itemsOut: luna.passed,
      model: ai.modelFor('cheap'),
    });

    // --- 5a. Choose who Terra sees ----------------------------------------
    const terraBudget = opts.maxDeep ?? config.final.luna_gate.terra_budget_per_run;

    // Scores are only comparable within one prompt version. A superseded prompt
    // that scored more generously leaves its items permanently outranking
    // everything scored since -- and because an evaluation is never revisited,
    // nothing corrects it. Re-score them first: they already cleared Luna and
    // their article text is already extracted, so they are the cheapest
    // candidates in the queue as well as the ones distorting the ranking.
    const stalePromptVersion = config.final.terra_gate.prompt;
    const staleShare = Math.max(
      1,
      Math.round(terraBudget * config.final.terra_gate.restale_budget_fraction),
    );
    const stale = db.all<{ id: string }>(
      `SELECT fi.id FROM feed_items fi
       JOIN deep_evaluations de ON de.item_id = fi.id
       WHERE fi.status = 'deep_evaluated' AND de.prompt_version <> :current
       ORDER BY de.expected_attention_value DESC
       LIMIT :limit`,
      { current: stalePromptVersion, limit: staleShare },
    );
    if (stale.length > 0) {
      const total = db.all<{ c: number }>(
        `SELECT COUNT(*) AS c FROM feed_items fi
         JOIN deep_evaluations de ON de.item_id = fi.id
         WHERE fi.status = 'deep_evaluated' AND de.prompt_version <> :current`,
        { current: stalePromptVersion },
      )[0]!.c;
      log.info(
        `re-scoring ${stale.length} of ${total} item(s) evaluated under a superseded prompt (current: ${stalePromptVersion})`,
      );
    }

    // Every item that has cleared Luna and is still waiting, not just this
    // run's arrivals: items deferred earlier for want of budget must get another
    // chance, or the deferral becomes the permanent rejection this pipeline
    // already learned not to do.
    const waiting = db.all<{ id: string }>(
      `SELECT fi.id FROM feed_items fi
       JOIN cheap_evaluations ce ON ce.item_id = fi.id
       WHERE fi.status = 'triaged' AND ce.passed = 1
       ORDER BY ce.triage_score DESC`,
    );

    // Items already sitting in an unfinished batch keep their `triaged` status,
    // correctly -- they have not been evaluated yet. Without this they would be
    // selected and submitted a second time, paying twice for the same
    // evaluations. They return to the queue on their own when the batch
    // resolves, so nothing is lost.
    const inFlight = pendingBatchItemIds(db, 'deep');
    const selectable = waiting.filter((w) => !inFlight.has(w.id));
    if (inFlight.size > 0) {
      log.info(`${inFlight.size} item(s) are waiting on a submitted batch and are not re-offered`);
    }

    const auditIds = new Set(
      db
        .all<{ item_id: string }>(
          `SELECT a.item_id FROM audit_samples a
           JOIN feed_items fi ON fi.id = a.item_id
           WHERE a.boundary = 'luna_to_terra' AND a.audit_result IS NULL
             AND fi.status IN ('triaged', 'rejected_luna')`,
        )
        .map((r) => r.item_id),
    );

    const allocation = allocateTerra(db, config, [...stale.map((s) => s.id), ...selectable.map((w) => w.id)], {
      configuredBudget: opts.maxDeep ?? config.final.luna_gate.terra_budget_per_run,
      auditIds,
      jobId: job.id,
    });
    result.budget = { ...allocation.budget };
    result.allocation = {
      candidates: selectable.length + stale.length,
      selected: allocation.selected.length,
      deferred: allocation.deferred.length,
      expired: allocation.expired.length,
      audits: [...auditIds].filter((id) => allocation.selected.includes(id)).length,
      affordable: allocation.affordable,
      affordableReason: allocation.affordableReason,
      minOpportunity: allocation.budget.minOpportunity,
      stage: allocation.budget.stage,
    };

    // Deferred items keep their status on purpose: `triaged` means "eligible for
    // Terra", and that is exactly what they still are.
    for (const e of allocation.expired) setStatus(db, e.id, 'expired_unevaluated', e.reason);

    const passed = allocation.selected.map((id) => ({ id }));

    const { allowed, deferred } = limitClusterMembers(db, config, passed.map((p) => p.id));
    for (const d of deferred) setStatus(db, d.id, 'deferred_cluster', d.reason);
    log.info(`Terra candidates: ${allowed.length} (${deferred.length} deferred by cluster rules)`);

    // --- 5b. Full article extraction --------------------------------------
    if (allowed.length > 0) {
      result.extract = { ...(await extractForItems(db, config, allowed)) };
    }

    // Access eligibility is checked after extraction for discovery inputs whose
    // linked domains are not known in advance. A readable RSS preview is not
    // enough: these items must open to a full article.
    const sourceMapForAccess = new Map(config.sources.map((source) => [source.id, source]));
    const terraEligible = allowed.filter((id) => {
      const row = db.get<{
        source_id: string;
        extraction_method: string | null;
        body_chars: number | null;
        structured_data: string | null;
      }>(
        `SELECT fi.source_id, ac.extraction_method, ac.body_chars, ac.structured_data
         FROM feed_items fi LEFT JOIN article_content ac ON ac.item_id = fi.id
         WHERE fi.id = :id`,
        { id },
      );
      const source = row ? sourceMapForAccess.get(row.source_id) : undefined;
      if (!source) return true;
      const verdict = evaluateArticleAccess(source, row, config.pipeline.extraction.min_extracted_chars);
      if (!verdict.eligible) setStatus(db, id, 'rejected_access', verdict.reason);
      return verdict.eligible;
    });

    // --- 5c. Terra ---------------------------------------------------------
    if (terraEligible.length > 0) {
      const terra = await runDeepEvaluation(db, ai, config, terraEligible);
      result.terra = { ...terra };
      recordStageCost(db, job.id, 'terra', {
        itemsIn: terraEligible.length,
        itemsOut: terra.evaluated,
        model: ai.modelFor('deep'),
      });
      // Attention cost needs the extracted word count and Terra's own estimate.
      // Refreshed across every evaluated item, not just this run's: items scored
      // by an earlier run would otherwise have no estimate and silently fall back
      // to the default, quietly understating each feed's minute budget.
      refreshAttentionEstimates(db, config);
    }

    // --- 6. Final ranking + diversification -------------------------------
    if (!opts.skipPublish) {
      const edition = publishEditions(db, config, now);
      result.edition = { ...edition };
      recordStageCost(db, job.id, 'final', {
        itemsIn: edition.candidates,
        itemsOut: edition.published,
      });

      // Alternate formats for what actually surfaced.
      result.alternate = { ...resolveAlternateFormats(db, config, embeddingModel) };
      const suppressed = suppressDuplicateEpisodes(db);
      if (suppressed > 0) {
        log.info(`suppressed ${suppressed} episodes already surfaced as an article's audio`);
      }
    }

    // Archival discovery is independent of the daily funnel but shares its
    // article store, extraction, feedback and model budget. A source-scoped
    // diagnostic run must not unexpectedly launch a cross-web archive crawl.
    if (!opts.sourceIds) {
      const classics = await runClassics(db, config, ai, { publish: !opts.skipPublish, now });
      result.classics = { ...classics };
    }

    // --- Audit bookkeeping -------------------------------------------------
    // Resolve what the deeper stages concluded about the sampled rejects. This is
    // the false-negative measurement, and it is the point of the sampling.
    resolveAuditSamples(db, config);

    result.spendUsd = ai.spentUsd;
    job.finish({ ...result, spendUsd: Number(ai.spentUsd.toFixed(5)) });
    return result;
  } catch (err) {
    result.spendUsd = ai.spentUsd;
    if (err instanceof SpendLimitError) {
      // Hitting the budget is a normal stop, not a failure: everything done so far
      // is committed and the next run picks up where this one left off.
      log.warn(err.message);
      job.finish({ ...result, stoppedBy: 'spend_limit', spendUsd: Number(ai.spentUsd.toFixed(5)) });
      return result;
    }
    job.fail(err);
    throw err;
  }
}
