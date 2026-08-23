import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sourceCategories } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { AiClient } from '../ai/client.js';
import { loadPrompt, render, tasteVars, feedVars, untrustedDataBlock, type LoadedPrompt } from './prompts.js';
import { parseModelJson, scoreSchema, looseStringArray } from './json.js';
import { submitBatch, awaitBatch, shouldUseBatch, pendingBatches, type BatchRequest } from './batch.js';
import { clusterContext } from '../cluster/index.js';
import { getVector, getVectors, matchAnchors } from '../embed/index.js';
import { setStatus, recordError, markItemError } from '../pipeline/journal.js';
import { mapPool } from '../util/pool.js';
import { structuralExcerpt } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('deep');

export const deepResultSchema = z.object({
  personal_interest: scoreSchema.default(0),
  intellectual_depth: scoreSchema.default(0),
  novelty: scoreSchema.default(0),
  practical_usefulness: scoreSchema.default(0),
  entertainment: scoreSchema.default(0),
  storytelling: scoreSchema.default(0),
  authorial_voice: scoreSchema.default(0),
  critique: scoreSchema.default(0),
  humor: scoreSchema.default(0),
  obsessive_expertise: scoreSchema.default(0),
  rabbit_hole: scoreSchema.default(0),
  delight: scoreSchema.default(0),
  headline_sufficiency: scoreSchema.default(0),
  source_quality: scoreSchema.default(0),
  argument_quality: scoreSchema.default(0),
  serendipity: scoreSchema.default(0),
  ragebait: scoreSchema.default(0),
  duplicate_information: scoreSchema.default(0),
  expected_attention_value: scoreSchema.default(0),
  category: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v ? String(v).toLowerCase().replace(/[\s-]+/g, '_') : null)),
  recommended_feeds: looseStringArray,
  why_it_surfaced: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v ? String(v).trim().slice(0, 600) : null)),
  estimated_reading_minutes: z
    .union([z.number(), z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }),
});

export type DeepResult = z.output<typeof deepResultSchema>;

export interface DeepCandidate {
  id: string;
  source_id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  canonical_url: string | null;
  rss_summary: string | null;
  publication_time: number | null;
  cluster_id: string | null;
  gist: string | null;
  cheap_categories: string;
  is_audit_sample: number;
  body_text: string | null;
  body_chars: number | null;
  reading_minutes: number | null;
  extraction_method: string | null;
  item_kind?: string;
  raw_feed_metadata?: string | null;
}

export function buildDeepUserMessage(
  candidate: DeepCandidate,
  sourceName: string,
  siblings: Array<{ title: string; source_id: string; gist: string | null; published: number }>,
  config: AppConfig,
): string {
  const lines: string[] = [];
  lines.push(`Source: ${sourceName}`);
  if (candidate.item_kind === 'product') lines.push('Item type: product discovery card');
  if (candidate.author) lines.push(`Author: ${candidate.author}`);
  lines.push(`Title: ${candidate.title}`);
  if (candidate.subtitle) lines.push(`Subtitle: ${candidate.subtitle}`);
  if (candidate.publication_time) {
    lines.push(`Published: ${new Date(candidate.publication_time).toISOString().slice(0, 10)}`);
  }
  if (candidate.canonical_url) lines.push(`URL: ${candidate.canonical_url}`);

  if (candidate.raw_feed_metadata) {
    try {
      const metadata = JSON.parse(candidate.raw_feed_metadata) as Record<string, unknown>;
      if (metadata.discovery_source === 'hacker_news') {
        lines.push(
          `Hacker News discovery signal: ${Number(metadata.hn_points ?? 0)} points, ` +
            `${Number(metadata.hn_comment_count ?? 0)} comments, ${Number(metadata.hn_age_hours ?? 0)} hours old.`,
        );
        if (typeof metadata.discussion_url === 'string') lines.push(`HN discussion: ${metadata.discussion_url}`);
      }
    } catch {
      // Metadata is advisory; malformed JSON should never block an evaluation.
    }
  }

  const suggested = safeParseArray(candidate.cheap_categories);
  if (suggested.length) lines.push(`Suggested category: ${suggested.join(', ')}`);

  if (siblings.length) {
    lines.push('');
    lines.push('Other coverage of this same story:');
    for (const s of siblings) {
      lines.push(
        `- ${s.source_id}: ${s.title}${s.gist ? ` — ${s.gist}` : ''}${s.published ? ' [already shown to the reader]' : ''}`,
      );
    }
  }

  lines.push('');
  const body = candidate.body_text?.trim();
  const words = body ? body.split(/\s+/).length : 0;
  if (body && body.length > 200) {
    // Length is stated explicitly because it changes what the scores can mean.
    // Without it, a 141-word link-blog quote post was scoring intellectual_depth
    // 0.78 -- the model was rating the idea being quoted rather than the artefact
    // the reader would actually open.
    lines.push(`Article length: ~${words} words.`);
    const excerpt = structuralExcerpt(body, config.pipeline.extraction.max_chars_for_model);
    lines.push(
      candidate.extraction_method === 'readability'
        ? excerpt.excerpted
          ? '--- Article text (opening and closing; the middle is omitted for length) ---'
          : '--- Article text ---'
        : '--- Article text (RSS content only; the full page was not available) ---',
    );
    lines.push(excerpt.text);
    if (excerpt.excerpted) {
      // Said explicitly, because the length-aware guidance in the prompt would
      // otherwise read an excerpt as a short piece and mark it down for it.
      lines.push('');
      lines.push(
        `(This is an excerpt of a ~${words}-word article; ${excerpt.omittedChars} characters ` +
        `from the middle are not shown. Judge it as the long piece it is.)`,
      );
    }
  } else {
    lines.push('--- Only the RSS summary is available for this item ---');
    lines.push(candidate.rss_summary ?? '(no summary)');
    lines.push('');
    lines.push(
      'Judge it on what is here. Do not penalise it merely for being short: the ' +
        'full text could not be fetched. If you cannot tell whether it is good, ' +
        'score expected_attention_value in the middle rather than low.',
    );
  }

  return untrustedDataBlock('article', lines.join('\n'));
}

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface DeepStats {
  evaluated: number;
  failed: number;
  auditSamples: number;
  usedFullText: number;
  mode: 'sync' | 'batch' | 'dry_run';
}

function loadCandidates(db: Db, itemIds: string[]): DeepCandidate[] {
  if (itemIds.length === 0) return [];
  return db.all<DeepCandidate>(
    `SELECT fi.id, fi.source_id, fi.title, fi.subtitle, fi.author, fi.canonical_url, fi.rss_summary,
            fi.publication_time, fi.cluster_id, ce.gist, ce.categories_json AS cheap_categories,
            ce.is_audit_sample, ac.body_text, ac.body_chars, ac.reading_minutes, ac.extraction_method,
            fi.item_kind, fi.raw_feed_metadata
     FROM feed_items fi
     LEFT JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN article_content ac ON ac.item_id = fi.id
     WHERE fi.id IN (${itemIds.map((_, i) => `:id${i}`).join(',')})`,
    Object.fromEntries(itemIds.map((id, i) => [`id${i}`, id])),
  );
}

export async function runDeepEvaluation(
  db: Db,
  ai: AiClient,
  config: AppConfig,
  itemIds: string[],
): Promise<DeepStats> {
  const stats: DeepStats = { evaluated: 0, failed: 0, auditSamples: 0, usedFullText: 0, mode: 'sync' };

  // Collect anything an earlier run left in flight before starting new work.
  const waitMs = config.models.models.deep.batch_collect_wait_seconds * 1000;
  if (!ai.dryRun && ai.supportsBatch('deep')) {
    for (const batch of pendingBatches(db, 'deep')) {
      try {
        log.info(`collecting results from batch ${batch.id} submitted by an earlier run`);
        const outcomes = await awaitBatch(db, ai, config, batch.id, waitMs);
        if (!outcomes) continue; // still running; it stays pending
        const ids = safeParseArray(batch.item_ids_json);
        // Stored against the prompt it was submitted under, not whatever is
        // configured now. Scores from different prompt versions are not
        // comparable, and mislabelling them hides a superseded prompt from the
        // re-scoring pass permanently.
        applyOutcomes(db, ai, config, loadCandidates(db, ids), outcomes, stats, batch.prompt_version, true);
      } catch (err) {
        log.warn(`could not collect batch ${batch.id}`, err);
      }
    }
  }

  if (itemIds.length === 0) return stats;

  const candidates = loadCandidates(db, itemIds);
  const prompt = loadPrompt(config, config.final.terra_gate.prompt);
  const systemPrompt = render(prompt.body, { ...tasteVars(config.taste), ...feedVars(config) });

  if (ai.dryRun) {
    stats.mode = 'dry_run';
    applyOutcomes(
      db,
      ai,
      config,
      candidates,
      candidates.map((c) => ({
        customId: c.id,
        text: JSON.stringify(stubDeepResult(c)),
        inputTokens: 0,
        outputTokens: 0,
      })),
      stats,
      prompt.id,
      false,
    );
    return stats;
  }

  if (shouldUseBatch(config, candidates.length) && ai.supportsBatch('deep')) {
    try {
      stats.mode = 'batch';
      // Built by the same function the sync path uses. Hand-rolling this body
      // once meant every batch request carried `temperature`, which reasoning
      // models reject -- 60 of 60 failed validation, and because the failures
      // land in an error file rather than the output file, the whole batch came
      // back as "zero results" with no error anywhere.
      const requests: BatchRequest[] = candidates.map((candidate) => {
        const body = ai.buildRequestBody(
          'deep',
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessageFor(db, config, candidate) },
          ],
          { jsonMode: true },
        );
        // The model is named at the envelope level by submitBatch.
        const { model: _model, ...rest } = body;
        return { customId: candidate.id, body: rest };
      });
      const batchId = await submitBatch(db, ai, config, 'deep', prompt.id, requests);
      const outcomes = await awaitBatch(db, ai, config, batchId, waitMs);

      // Not ready inside the short window. The run continues and publishes what
      // it already has; the next run collects. Waiting here used to stall
      // publishing, ingestion and the scheduler behind the provider's queue.
      if (!outcomes) {
        log.info(`batch ${batchId} left running; the next run will collect ${candidates.length} evaluations`);
        return stats;
      }

      // A batch that produced nothing usable must fall through to sync rather
      // than being mistaken for "no items were any good".
      const usable = outcomes.filter((o) => !o.error && o.text.trim().length > 0);
      if (usable.length === 0) {
        throw new Error(
          `batch ${batchId} returned no usable results` +
            (outcomes[0]?.error ? `: ${outcomes[0].error}` : ''),
        );
      }

      applyOutcomes(db, ai, config, candidates, outcomes, stats, prompt.id, true);
      return stats;
    } catch (err) {
      // Batch is an optimisation, never a requirement: fall back to sync.
      log.warn('batch submission failed; falling back to synchronous calls', err);
      recordError(db, 'deep', 'batch', err instanceof Error ? err.message : String(err));
      stats.mode = 'sync';
    }
  }

  await mapPool(candidates, config.models.models.deep.max_concurrency, async (candidate) => {
    try {
      const completion = await ai.complete(
        'deep',
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessageFor(db, config, candidate) },
        ],
        // No maxTokens override: models.yaml is the only place the ceiling is
        // set, so the sync and batch paths cannot ask for different limits.
        { temperature: 0.2, jsonMode: true },
      );
      applyOutcomes(
        db,
        ai,
        config,
        [candidate],
        [
          {
            customId: candidate.id,
            text: completion.text,
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
          },
        ],
        stats,
        prompt.id,
        false,
      );
    } catch (err) {
      stats.failed += 1;
      markItemError(db, candidate.id, 'deep_eval', err instanceof Error ? err.message : String(err));
    }
  });

  log.info(`deep evaluation: ${stats.evaluated} scored (${stats.usedFullText} with full text), ${stats.failed} failed`);
  return stats;
}

function userMessageFor(db: Db, config: AppConfig, candidate: DeepCandidate): string {
  const sourceName = config.sources.find((s) => s.id === candidate.source_id)?.name ?? candidate.source_id;
  const siblings = clusterContext(db, candidate.id, candidate.cluster_id);
  return buildDeepUserMessage(candidate, sourceName, siblings, config);
}

/** Persist a set of model outcomes. Shared by the sync, batch and dry-run paths. */
function applyOutcomes(
  db: Db,
  ai: AiClient,
  config: AppConfig,
  candidates: DeepCandidate[],
  outcomes: Array<{ customId: string; text: string; inputTokens: number; outputTokens: number; error?: string }>,
  stats: DeepStats,
  /** The prompt these results were produced under, never the current one. */
  promptVersion: string,
  /**
   * Whether these came through the batch API. Taken as an argument rather than
   * read off stats.mode: collecting an earlier run's batch leaves the mode
   * 'sync', so the usage of every batch collected on a later run was silently
   * recorded as zero.
   */
  viaBatch: boolean,
): void {
  if (outcomes.length === 0) return;
  const model = ai.modelFor('deep');
  const embeddingModel = ai.modelFor('embedding');
  const anchorVectors = getVectors(db, 'anchor', embeddingModel);
  const avoidVectors = getVectors(db, 'avoid_anchor', embeddingModel);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  let batchInput = 0;
  let batchOutput = 0;

  for (const outcome of outcomes) {
    const candidate = byId.get(outcome.customId);
    if (!candidate) continue;

    if (outcome.error) {
      stats.failed += 1;
      markItemError(db, candidate.id, 'deep_eval', outcome.error);
      continue;
    }

    const parsed = parseModelJson(outcome.text, deepResultSchema);
    if (!parsed.ok) {
      stats.failed += 1;
      markItemError(db, candidate.id, 'deep_eval', `unparseable response: ${parsed.error}`);
      recordError(db, candidate.id, 'deep_eval', 'unparseable response', parsed.raw.slice(0, 800));
      continue;
    }
    const result = parsed.value!;

    batchInput += outcome.inputTokens;
    batchOutput += outcome.outputTokens;

    const usedFullText = candidate.extraction_method === 'readability' && (candidate.body_chars ?? 0) > 400;
    const vector = getVector(db, 'item', candidate.id, embeddingModel);
    const anchors = vector
      ? matchAnchors(vector, anchorVectors, avoidVectors)
      : { distance: 0.5, bestAnchorId: null, bestSimilarity: 0, topMeanSimilarity: 0.5, avoidSimilarity: 0 };

    const category = normaliseCategory(
      result.category,
      candidate,
      sourceCategories(config.sources.find((s) => s.id === candidate.source_id)),
      config,
    );
    const recommended = result.recommended_feeds
      .map((f) => f.toLowerCase().replace(/[\s-]+/g, '_'))
      .filter((f) => config.feeds.some((cfg) => cfg.id === f));

    db.transaction(() => {
      db.run(
        `INSERT INTO deep_evaluations (
            item_id, personal_interest, intellectual_depth, novelty, practical_usefulness,
            entertainment, storytelling, authorial_voice, critique, humor, obsessive_expertise,
            rabbit_hole, delight, headline_sufficiency, source_quality, serendipity, ragebait, duplicate_information,
            expected_attention_value, argument_quality, category, recommended_feeds_json, why_it_surfaced,
            estimated_reading_minutes, anchor_distance, content_source, is_audit_sample,
            model, prompt_version, config_hash, input_tokens, output_tokens, raw_json, created_at)
         VALUES (
            :item_id, :pi, :depth, :novelty, :useful, :fun, :story, :voice, :critique, :humor,
            :expertise, :rabbit, :delight, :headline, :quality, :serendipity, :ragebait,
            :dup, :eav, :argq, :category, :feeds, :why, :minutes, :distance, :content_source, :audit,
            :model, :prompt, :hash, :in_tok, :out_tok, :raw, :ts)
         ON CONFLICT(item_id) DO UPDATE SET
            personal_interest = excluded.personal_interest, intellectual_depth = excluded.intellectual_depth,
            novelty = excluded.novelty, practical_usefulness = excluded.practical_usefulness,
            entertainment = excluded.entertainment, source_quality = excluded.source_quality,
            storytelling = excluded.storytelling, authorial_voice = excluded.authorial_voice,
            critique = excluded.critique, humor = excluded.humor,
            obsessive_expertise = excluded.obsessive_expertise, rabbit_hole = excluded.rabbit_hole,
            delight = excluded.delight, headline_sufficiency = excluded.headline_sufficiency,
            serendipity = excluded.serendipity, ragebait = excluded.ragebait,
            duplicate_information = excluded.duplicate_information,
            expected_attention_value = excluded.expected_attention_value,
            argument_quality = excluded.argument_quality, category = excluded.category,
            recommended_feeds_json = excluded.recommended_feeds_json, why_it_surfaced = excluded.why_it_surfaced,
            estimated_reading_minutes = excluded.estimated_reading_minutes,
            anchor_distance = excluded.anchor_distance, content_source = excluded.content_source,
            model = excluded.model, prompt_version = excluded.prompt_version,
            config_hash = excluded.config_hash, raw_json = excluded.raw_json, created_at = excluded.created_at`,
        {
          item_id: candidate.id,
          pi: result.personal_interest,
          depth: result.intellectual_depth,
          novelty: result.novelty,
          useful: result.practical_usefulness,
          fun: result.entertainment,
          story: result.storytelling,
          voice: result.authorial_voice,
          critique: result.critique,
          humor: result.humor,
          expertise: result.obsessive_expertise,
          rabbit: result.rabbit_hole,
          delight: result.delight,
          headline: result.headline_sufficiency,
          quality: result.source_quality,
          serendipity: result.serendipity,
          ragebait: result.ragebait,
          dup: result.duplicate_information,
          eav: result.expected_attention_value,
          argq: result.argument_quality,
          category,
          feeds: JSON.stringify(recommended),
          why: result.why_it_surfaced,
          minutes: result.estimated_reading_minutes ?? candidate.reading_minutes,
          distance: anchors.distance,
          content_source: usedFullText ? 'full_article' : 'rss_only',
          audit: candidate.is_audit_sample ?? 0,
          model,
          prompt: promptVersion,
          hash: `${config.hashes.ranking}`,
          in_tok: outcome.inputTokens,
          out_tok: outcome.outputTokens,
          raw: outcome.text.slice(0, 8000),
          ts: Date.now(),
        },
      );
      setStatus(
        db,
        candidate.id,
        'deep_evaluated',
        `expected_attention_value ${result.expected_attention_value.toFixed(2)}`,
      );
    });

    stats.evaluated += 1;
    if (usedFullText) stats.usedFullText += 1;
    if (candidate.is_audit_sample) stats.auditSamples += 1;
  }

  // Batch usage is not recorded by the client itself, so log it here.
  if (viaBatch && (batchInput > 0 || batchOutput > 0)) {
    ai.recordBatchUsage('deep', { inputTokens: batchInput, outputTokens: batchOutput }, outcomes.length);
  }
}

function normaliseCategory(
  modelCategory: string | null,
  candidate: DeepCandidate,
  sourceCategories: string[],
  config: AppConfig,
): string {
  if (modelCategory && config.categories.includes(modelCategory)) return modelCategory;
  const cheap = safeParseArray(candidate.cheap_categories).find((c) => config.categories.includes(c));
  if (cheap) return cheap;
  const fromSource = sourceCategories.find((c) => config.categories.includes(c));
  return fromSource ?? 'other';
}

/** Deterministic stand-in used when SIFT_DRY_RUN=1. */
export function stubDeepResult(candidate: { title: string; body_chars: number | null }): DeepResult {
  const size = Math.min(1, (candidate.body_chars ?? 500) / 8000);
  return {
    personal_interest: 0.6,
    intellectual_depth: 0.5 + size * 0.3,
    novelty: 0.55,
    practical_usefulness: 0.4,
    entertainment: 0.5,
    storytelling: 0.5,
    authorial_voice: 0.5,
    critique: 0.4,
    humor: 0.3,
    obsessive_expertise: 0.5,
    rabbit_hole: 0.45,
    delight: 0.5,
    headline_sufficiency: 0.2,
    source_quality: 0.6,
    argument_quality: 0.6,
    serendipity: 0.3,
    ragebait: 0.05,
    duplicate_information: 0.1,
    expected_attention_value: 0.55 + size * 0.2,
    category: null,
    recommended_feeds: [],
    why_it_surfaced: `[dry run] ${candidate.title.slice(0, 120)}`,
    estimated_reading_minutes: null,
  };
}
