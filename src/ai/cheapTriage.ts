import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sourceCategories } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { AiClient } from '../ai/client.js';
import { loadPrompt, render, tasteVars, feedVars, untrustedDataBlock } from './prompts.js';
import { parseModelJson, scoreSchema, looseBool, looseStringArray } from './json.js';
import { getVector, getVectors, matchAnchors, type AnchorMatch } from '../embed/index.js';
import type { Band } from '../rank/freeScore.js';
import { hashUnit } from '../rank/runFreeRanker.js';
import { learnedSourceValues } from '../rank/sourceStats.js';
import { setStatus, recordError } from '../pipeline/journal.js';
import { mapPool } from '../util/pool.js';
import { truncate } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('triage');

export const cheapResultSchema = z.object({
  action: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const s = String(v ?? '').trim().toUpperCase();
      if (s === 'KEEP' || s === 'DROP' || s === 'UNCERTAIN') return s;
      // An unrecognised action must never silently become DROP.
      return 'UNCERTAIN';
    }),
  categories: looseStringArray,
  interest_match: scoreSchema.default(0),
  novelty_likelihood: scoreSchema.default(0),
  junk_probability: scoreSchema.default(0),
  needs_full_article: looseBool.default(false),
  serendipity_candidate: looseBool.default(false),
  gist: z.union([z.string(), z.null(), z.undefined()]).transform((v) => (v ? String(v).slice(0, 200) : null)),
});

export type CheapResult = z.output<typeof cheapResultSchema>;

export interface TriageItem {
  id: string;
  source_id: string;
  title: string;
  subtitle: string | null;
  rss_summary: string | null;
  canonical_url: string | null;
  publication_time: number | null;
  feed_categories_json: string;
  /** From stage 3, so the gate can weigh it rather than re-derive it. */
  free_score: number;
  band: Band;
  quality_prior: number;
  is_free_audit: number;
  source_items_seen: number;
}

/**
 * Stage 4 gate: the deterministic decision over Luna's advice.
 *
 * Luna answers "does this plausibly deserve human attention?" -- and that answer
 * is one input among several. The gate combines it with the free score, the source
 * prior and the item's band, because a cheap model looking at a headline is not
 * entitled to decide alone what gets paid for.
 *
 * Source weight is present but already fading: it is worth 0.20 here against 0.45
 * for Luna's own interest_match, and it will be worth 0.08 once Terra has read the
 * article. Heuristics control how much opportunity content gets to request; they
 * must not override article-level judgment.
 *
 * Pure: no database, no clock, so every branch is testable.
 */
export interface GateContext {
  /** Stage 3's score for this item. */
  freeScore: number;
  band: Band;
  /** Source quality prior, exploration-adjusted. */
  qualityPrior: number;
  /** True when the source is under-sampled and holds an exploration claim. */
  exploration: boolean;
  /** Learned category nudge, deliberately small. */
  categoryAdjustment?: number;
  /** Selected as a boundary audit sample: must survive regardless. */
  isAuditSample?: boolean;
}

export interface TriageDecision {
  passed: boolean;
  score: number;
  threshold: number;
  reason: string;
  components: Record<string, number>;
}

export function scoreTriage(
  result: CheapResult,
  context: GateContext,
  config: AppConfig,
): TriageDecision {
  const gate = config.final.luna_gate;
  const w = gate.weights;

  const components: Record<string, number> = {
    free_score: w.free_score * context.freeScore,
    interest_match: w.interest_match * result.interest_match,
    novelty_likelihood: w.novelty_likelihood * result.novelty_likelihood,
    quality_prior: w.quality_prior * context.qualityPrior,
    junk_probability: w.junk_probability * result.junk_probability,
  };

  // Normalised by the positive weights so the threshold keeps its meaning when
  // the weights are retuned.
  const positiveWeight =
    w.free_score + w.interest_match + w.novelty_likelihood + w.quality_prior;
  const raw =
    components.free_score! +
    components.interest_match! +
    components.novelty_likelihood! +
    components.quality_prior! +
    components.junk_probability!;
  const score = positiveWeight > 0 ? raw / positiveWeight : raw;

  const category = result.categories[0] ?? 'other';
  let threshold = gate.category_thresholds[category] ?? gate.threshold;
  const discounts: string[] = [];
  const d = gate.discounts;

  // Recall-first discounts. A wasted Terra call costs cents; a silent miss is
  // invisible and permanent.
  if (context.qualityPrior >= gate.trusted_quality_prior) {
    threshold -= d.high_quality_source;
    discounts.push('trusted source');
  }
  if (result.action === 'UNCERTAIN') {
    threshold -= d.uncertain;
    discounts.push('UNCERTAIN');
  }
  if (result.needs_full_article) {
    threshold -= d.needs_full_article;
    discounts.push('needs full article');
  }
  if (context.band === 'A') {
    threshold -= d.band_a;
    discounts.push('band A');
  }
  if (context.exploration) {
    threshold -= d.exploration;
    discounts.push('under-sampled source');
  }
  if (context.categoryAdjustment) {
    const adjustment = Math.max(-0.08, Math.min(0.08, context.categoryAdjustment));
    threshold -= adjustment;
    discounts.push(`learned ${category} ${adjustment >= 0 ? '+' : ''}${adjustment.toFixed(3)}`);
  }

  // Serendipity candidates bypass the score entirely: this gate is tuned to
  // established interests, and the Serendipity feed exists to survive it.
  if (result.serendipity_candidate && result.junk_probability <= gate.serendipity_bypass_max_junk) {
    return {
      passed: true,
      score,
      threshold,
      reason: `serendipity candidate (junk ${result.junk_probability.toFixed(2)} <= ${gate.serendipity_bypass_max_junk})`,
      components,
    };
  }

  // Audit sampling is checked before any rejection path: the items Luna dropped
  // are precisely the ones worth auditing. Checking it later would restrict the
  // false-negative measurement to items that were nearly good enough anyway.
  if (context.isAuditSample) {
    return {
      passed: true,
      score,
      threshold,
      reason: 'audit sample of Luna rejects',
      components,
    };
  }

  if (result.action === 'DROP' && score < threshold) {
    return {
      passed: false,
      score,
      threshold,
      reason: `Luna said DROP (score ${score.toFixed(3)} < ${threshold.toFixed(3)})`,
      components,
    };
  }

  const passed = score >= threshold;
  const detail = discounts.length ? ` [-${discounts.join(', -')}]` : '';
  return {
    passed,
    score,
    threshold,
    reason: passed
      ? `score ${score.toFixed(3)} >= ${threshold.toFixed(3)}${detail}`
      : `score ${score.toFixed(3)} < ${threshold.toFixed(3)}${detail}`,
    components,
  };
}

/**
 * Luna's user message. Includes the free-score components so Luna can agree or
 * disagree with the free ranker rather than re-deriving what it already computed.
 */
export function buildUserMessage(
  item: TriageItem,
  sourceName: string,
  sourcePrior: number,
  anchors: AnchorMatch,
  config: AppConfig,
  freeComponents?: Record<string, number> | null,
): string {
  let feedCats: string[] = [];
  try {
    feedCats = JSON.parse(item.feed_categories_json) as string[];
  } catch {
    feedCats = [];
  }

  const lines = [
    `Source: ${sourceName}`,
    `Title: ${item.title}`,
  ];
  if (item.subtitle) lines.push(`Subtitle: ${item.subtitle}`);
  if (item.rss_summary) lines.push(`Summary: ${truncate(item.rss_summary, 900)}`);
  if (feedCats.length) lines.push(`Feed tags: ${feedCats.slice(0, 8).join(', ')}`);
  lines.push(`Source trust prior: ${sourcePrior >= 0.15 ? 'high' : sourcePrior >= 0 ? 'normal' : 'low'}`);
  lines.push(
    `Embedding similarity to the reader's interests: ${anchors.topMeanSimilarity.toFixed(2)}` +
      (anchors.bestAnchorId ? ` (closest: ${anchors.bestAnchorId})` : '') +
      `; similarity to things they avoid: ${anchors.avoidSimilarity.toFixed(2)}`,
  );

  lines.push('');
  lines.push(`Free-ranker verdict: band ${item.band}, score ${item.free_score.toFixed(2)}`);
  if (freeComponents) {
    const parts = Object.entries(freeComponents)
      .filter(([, v]) => typeof v === 'number' && v !== 0)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`);
    if (parts.length) lines.push(`Components: ${parts.join(', ')}`);
  }

  return untrustedDataBlock('feed item', lines.join('\n'));
}

export interface TriageStats {
  evaluated: number;
  passed: number;
  rejected: number;
  auditSamples: number;
  failed: number;
  byAction: Record<string, number>;
}

export async function runCheapTriage(
  db: Db,
  ai: AiClient,
  config: AppConfig,
  opts: { limit?: number } = {},
): Promise<TriageStats> {
  const prompt = loadPrompt(config, config.final.luna_gate.prompt);
  const model = ai.modelFor('cheap');
  const embeddingModel = ai.modelFor('embedding');

  // Stage 3 has already decided who is worth a call, and its score is an input to
  // the gate rather than a filter that ran and was forgotten.
  const items = db.all<TriageItem>(
    `SELECT fi.id, fi.source_id, fi.title, fi.subtitle, fi.rss_summary, fi.canonical_url,
            fi.publication_time, fi.feed_categories_json,
            COALESCE(f.free_score, 0) AS free_score,
            COALESCE(f.band, 'D') AS band,
            COALESCE(f.source_quality_prior, 0.5) AS quality_prior,
            CASE WHEN EXISTS (SELECT 1 FROM audit_samples a
                              WHERE a.item_id = fi.id AND a.boundary = 'free_to_luna')
                 THEN 1 ELSE 0 END AS is_free_audit,
            COALESCE(ss.items_seen, 0) AS source_items_seen
     FROM feed_items fi
     LEFT JOIN free_score_components f ON f.item_id = fi.id
     LEFT JOIN source_statistics ss ON ss.source_id = fi.source_id
     WHERE fi.status = 'free_ranked'
     ORDER BY f.free_score DESC
     LIMIT :limit`,
    { limit: opts.limit ?? 1000 },
  );

  const stats: TriageStats = {
    evaluated: 0,
    passed: 0,
    rejected: 0,
    auditSamples: 0,
    failed: 0,
    byAction: {},
  };
  if (items.length === 0) return stats;

  const anchorVectors = getVectors(db, 'anchor', embeddingModel);
  const avoidVectors = getVectors(db, 'avoid_anchor', embeddingModel);
  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));
  // Learned value comes from source_statistics, the single place it is stored.
  // The configured quality_prior in sources.yaml is never overwritten; the two
  // are added here, at scoring time.
  const learnedPriors = learnedSourceValues(db);
  const learnedCategories = new Map(
    db
      .all<{ key: string; value: number }>(
        `SELECT key, value FROM learned_weights WHERE scope = 'category'`,
      )
      .map((r) => [r.key, r.value]),
  );

  // The full profile, not a truncated one. Counter-intuitively this is both
  // cheaper and better: the system prompt is identical for every item and sits
  // at the front of each request, so the provider serves it from its prompt
  // cache at a discount -- but only if the prefix clears the provider's minimum
  // cacheable length. A trimmed profile fell just under it and cached nothing,
  // paying full price on every item for a worse brief.
  const systemPrompt = render(prompt.body, {
    ...tasteVars(config.taste),
    ...feedVars(config),
  });

  // Components for every item in this batch, so the prompt can show Luna what the
  // free ranker concluded.
  const freeComponents = new Map<string, Record<string, number>>(
    db
      .all<{
        item_id: string;
        source_quality_prior: number;
        semantic_interest_score: number;
        keyword_interest_score: number;
        freshness_score: number;
        editorial_type_score: number;
        source_uniqueness_score: number;
        redundancy_penalty: number;
        clickbait_penalty: number;
      }>(
        `SELECT item_id, source_quality_prior, semantic_interest_score, keyword_interest_score,
                freshness_score, editorial_type_score, source_uniqueness_score,
                redundancy_penalty, clickbait_penalty
         FROM free_score_components`,
      )
      .map((r) => {
        const { item_id, ...rest } = r;
        return [item_id, rest as Record<string, number>];
      }),
  );


  const gate = config.final.luna_gate;
  // Audit rate and volume come from the active mode: calibration buys far more
  // observations than steady state, and that is a spend decision.
  let auditBudget = config.mode.audit_max_per_run.luna_to_terra;

  await mapPool(items, 6, async (item) => {
    const source = sourceMap.get(item.source_id);
    const sourceName = source?.name ?? item.source_id;
    const sourcePrior = (source?.quality_prior ?? 0) + (learnedPriors.get(item.source_id) ?? 0);

    const vector = getVector(db, 'item', item.id, embeddingModel);
    const anchors: AnchorMatch = vector
      ? matchAnchors(vector, anchorVectors, avoidVectors)
      : { bestAnchorId: null, bestSimilarity: 0, topMeanSimilarity: 0, avoidSimilarity: 0, distance: 1 };

    let result: CheapResult;
    let rawJson = '';
    let usage = { inputTokens: 0, outputTokens: 0 };

    if (ai.dryRun) {
      result = stubCheapResult(item, anchors, sourceCategories(source));
      rawJson = JSON.stringify(result);
    } else {
      try {
        const completion = await ai.complete(
          'cheap',
          [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: buildUserMessage(
                item,
                sourceName,
                sourcePrior,
                anchors,
                config,
                freeComponents.get(item.id) ?? null,
              ),
            },
          ],
          { maxTokens: 220, temperature: 0.1, jsonMode: true },
        );
        usage = completion.usage;
        rawJson = completion.text;
        const parsed = parseModelJson(completion.text, cheapResultSchema);
        if (!parsed.ok) {
          // A malformed response must not delete the item: treat it as
          // UNCERTAIN so it gets a chance at deep evaluation.
          log.warn(`unparseable triage response for ${item.id}: ${parsed.error}`);
          recordError(db, item.id, 'cheap_triage', `unparseable response: ${parsed.error}`, parsed.raw.slice(0, 500));
          result = {
            action: 'UNCERTAIN',
            categories: sourceCategories(source),
            interest_match: 0.5,
            novelty_likelihood: 0.5,
            junk_probability: 0.3,
            needs_full_article: true,
            serendipity_candidate: false,
            gist: null,
          };
        } else {
          result = parsed.value!;
        }
      } catch (err) {
        stats.failed += 1;
        recordError(db, item.id, 'cheap_triage', 'model call failed', err instanceof Error ? err.message : String(err));
        log.error(`triage failed for ${item.id}`, err);
        return;
      }
    }

    // Categories are constrained to the configured taxonomy.
    const validCategories = result.categories
      .map((c) => c.toLowerCase().replace(/[\s-]+/g, '_'))
      .filter((c) => config.categories.includes(c));
    if (validCategories.length === 0) {
      const fallback = source?.hard_rules?.force_category ?? sourceCategories(source)[0] ?? 'other';
      validCategories.push(config.categories.includes(fallback) ? fallback : 'other');
    }
    result = { ...result, categories: validCategories };

    const categoryAdjustment = learnedCategories.get(result.categories[0] ?? '') ?? 0;
    const context: GateContext = {
      freeScore: item.free_score,
      band: item.band,
      qualityPrior: sourcePrior,
      exploration:
        item.source_items_seen < config.free.free_ranking.exploration.min_items_for_confidence,
      categoryAdjustment,
    };
    let decision = scoreTriage(result, context, config);

    // Audit sample at the Luna/Terra boundary: a slice of Luna's rejects is sent
    // to Terra anyway, so this stage's false-negative rate is measured rather
    // than assumed. Deterministic per item, so a rerun samples the same items.
    let isAuditSample = false;
    if (
      !decision.passed &&
      auditBudget > 0 &&
      hashUnit(`luna-audit:${item.id}`) < config.mode.luna_reject_audit_rate
    ) {
      auditBudget -= 1;
      isAuditSample = true;
      decision = scoreTriage(result, { ...context, isAuditSample: true }, config);
      stats.auditSamples += 1;
      db.run(
        `INSERT INTO audit_samples (item_id, boundary, normal_decision, audit_selected,
                                    audit_stage, audit_reason, band, free_score, sample_rate,
                                    source_id, category, semantic_interest, is_serendipity, created_at)
         VALUES (:id, 'luna_to_terra', :decision, 1, 'luna_reject', :auditReason, :band, :score,
                 :rate, :source, :category, :semantic, :serendipity, :ts)
         ON CONFLICT(item_id, boundary) DO UPDATE SET
           normal_decision = excluded.normal_decision, sample_rate = excluded.sample_rate,
           audit_stage = excluded.audit_stage, audit_reason = excluded.audit_reason,
           source_id = excluded.source_id, category = excluded.category,
           semantic_interest = excluded.semantic_interest,
           is_serendipity = excluded.is_serendipity`,
        {
          id: item.id,
          decision: `reject: ${decision.reason}`,
          auditReason:
            `Luna ${result.action} sampled at ` +
            `${(config.mode.luna_reject_audit_rate * 100).toFixed(0)}% (${config.modeName} mode)`,
          band: item.band,
          score: item.free_score,
          rate: config.mode.luna_reject_audit_rate,
          source: item.source_id,
          category: result.categories?.[0] ?? null,
          semantic: result.interest_match,
          serendipity: result.serendipity_candidate ? 1 : 0,
          ts: Date.now(),
        },
      );
    }

    // NOTE: the Terra budget is deliberately NOT enforced here.
    //
    // It used to be: an item that passed this gate but arrived after the budget
    // was spent had `passed` flipped to false and was written as `rejected_luna`.
    // That was permanent -- Luna only ever reads `free_ranked` and Terra only
    // reads `triaged`, so nothing reconsidered it. A single backlog run stranded
    // 60 items that had already cleared the quality bar, including serendipity
    // candidates whose whole purpose is to bypass gating.
    //
    // The cap belongs in one place, and the pipeline already has it: Terra
    // selection is `... WHERE status='triaged' AND passed=1 ORDER BY triage_score
    // DESC LIMIT terra_budget_per_run`. Items over the limit simply stay
    // `triaged` and are picked up, highest score first, by the next run.

    db.transaction(() => {
      db.run(
        `INSERT INTO cheap_evaluations (
            item_id, action, categories_json, interest_match, novelty_likelihood, junk_probability,
            needs_full_article, serendipity_candidate, gist, anchor_similarity, best_anchor_id,
            avoid_similarity, triage_score, threshold_used, passed, pass_reason, is_audit_sample,
            free_score_at_gate, band_at_gate, exploration_slot, gate_components_json,
            model, prompt_version, config_hash, input_tokens, output_tokens, raw_json, created_at)
         VALUES (
            :item_id, :action, :cats, :interest, :novelty, :junk, :needs, :serendipity, :gist,
            :anchor_sim, :best_anchor, :avoid_sim, :score, :threshold, :passed, :reason, :audit,
            :free_score, :band, :expl, :gate_components,
            :model, :prompt, :hash, :in_tok, :out_tok, :raw, :ts)
         ON CONFLICT(item_id) DO UPDATE SET
            action = excluded.action, categories_json = excluded.categories_json,
            interest_match = excluded.interest_match, novelty_likelihood = excluded.novelty_likelihood,
            junk_probability = excluded.junk_probability, needs_full_article = excluded.needs_full_article,
            serendipity_candidate = excluded.serendipity_candidate, gist = excluded.gist,
            anchor_similarity = excluded.anchor_similarity, best_anchor_id = excluded.best_anchor_id,
            avoid_similarity = excluded.avoid_similarity, triage_score = excluded.triage_score,
            threshold_used = excluded.threshold_used, passed = excluded.passed,
            pass_reason = excluded.pass_reason, is_audit_sample = excluded.is_audit_sample,
            free_score_at_gate = excluded.free_score_at_gate, band_at_gate = excluded.band_at_gate,
            exploration_slot = excluded.exploration_slot,
            gate_components_json = excluded.gate_components_json,
            model = excluded.model, prompt_version = excluded.prompt_version,
            config_hash = excluded.config_hash, raw_json = excluded.raw_json, created_at = excluded.created_at`,
        {
          item_id: item.id,
          action: result.action,
          cats: JSON.stringify(result.categories),
          interest: result.interest_match,
          novelty: result.novelty_likelihood,
          junk: result.junk_probability,
          needs: result.needs_full_article ? 1 : 0,
          serendipity: result.serendipity_candidate ? 1 : 0,
          gist: result.gist,
          anchor_sim: anchors.topMeanSimilarity,
          best_anchor: anchors.bestAnchorId,
          avoid_sim: anchors.avoidSimilarity,
          score: decision.score,
          threshold: decision.threshold,
          passed: decision.passed ? 1 : 0,
          reason: decision.reason,
          audit: isAuditSample ? 1 : 0,
          free_score: item.free_score,
          band: item.band,
          expl: context.exploration ? 1 : 0,
          gate_components: JSON.stringify(decision.components),
          model,
          prompt: prompt.id,
          hash: `${config.hashes.ranking}`,
          in_tok: usage.inputTokens,
          out_tok: usage.outputTokens,
          raw: rawJson.slice(0, 4000),
          ts: Date.now(),
        },
      );

      setStatus(db, item.id, decision.passed ? 'triaged' : 'rejected_luna', decision.reason);
    });

    stats.evaluated += 1;
    stats.byAction[result.action] = (stats.byAction[result.action] ?? 0) + 1;
    if (decision.passed) stats.passed += 1;
    else stats.rejected += 1;
  });

  log.info(
    `cheap triage: ${stats.passed} passed, ${stats.rejected} rejected, ${stats.auditSamples} audit samples`,
  );
  return stats;
}

/** Deterministic stand-in used when SIFT_DRY_RUN=1. */
export function stubCheapResult(item: TriageItem, anchors: AnchorMatch, sourceCategories: string[]): CheapResult {
  const interest = Math.min(1, anchors.topMeanSimilarity * 1.4);
  return {
    action: interest > 0.3 ? 'KEEP' : 'UNCERTAIN',
    categories: sourceCategories.length ? sourceCategories : ['other'],
    interest_match: interest,
    novelty_likelihood: 0.5,
    junk_probability: Math.min(1, anchors.avoidSimilarity),
    needs_full_article: true,
    serendipity_candidate: anchors.distance > 0.8 && anchors.avoidSimilarity < 0.3,
    gist: item.title.slice(0, 120),
  };
}
