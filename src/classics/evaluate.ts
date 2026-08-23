import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { Db } from '../db/index.js';
import { AiClient, SpendLimitError } from '../ai/client.js';
import { scoreSchema, parseModelJson } from '../ai/json.js';
import { loadPrompt, render, tasteVars, untrustedDataBlock } from '../ai/prompts.js';
import { extractForItems, extractFromHtml } from '../extract/index.js';
import { explicitFreeAccess } from '../extract/access.js';
import { classifyArticleLanguage } from '../filter/language.js';
import { structuralExcerpt } from '../util/text.js';
import { mapPool } from '../util/pool.js';
import { hostOf } from '../util/url.js';
import { DAY_MS } from '../util/time.js';
import { logger } from '../util/log.js';

const log = logger('classics-evaluate');

const classicsResultSchema = z.object({
  analysis: scoreSchema,
  storytelling: scoreSchema,
  authorial_voice: scoreSchema,
  entertainment: scoreSchema,
  obsessive_expertise: scoreSchema,
  rabbit_hole: scoreSchema,
  critique: scoreSchema,
  humor: scoreSchema,
  enduring_value: scoreSchema,
  personal_interest: scoreSchema,
  historical_quality: scoreSchema,
  homework: scoreSchema,
  datedness: scoreSchema,
  ragebait: scoreSchema,
  predicted_read: scoreSchema,
  predicted_payoff: scoreSchema,
  category: z.string().default('other'),
  pleasure_class: z.string().trim().max(100).default('deep dive'),
  why_picked: z.string().trim().max(600),
  enduring_reason: z.string().trim().max(600),
});

type ClassicsResult = z.output<typeof classicsResultSchema>;

interface CandidateRow {
  item_id: string;
  title: string;
  canonical_url: string;
  author: string | null;
  publication_time: number | null;
  source_name: string;
  original_author: string | null;
  original_published_at: number | null;
  best_discovery_source: string;
  discovery_sources_json: string;
  historical_signal: number;
  hn_points: number;
  hn_comments: number;
  hn_submissions: number;
  status: string;
  body_text: string | null;
  body_chars: number | null;
  extraction_method: string | null;
  structured_data: string | null;
  extracted_title: string | null;
  extracted_author: string | null;
  extracted_published_at: number | null;
  site_name: string | null;
  lead_image_url: string | null;
}

export interface EligibilityStats {
  attempted: number;
  eligible: number;
  rejectedAccess: number;
  rejectedLanguage: number;
  rejectedDuplicate: number;
}

export interface EvaluationStats {
  considered: number;
  evaluated: number;
  failed: number;
  spendUsd: number;
}

function rowsFor(db: Db, where: string): CandidateRow[] {
  return db.all<CandidateRow>(
    `SELECT cc.item_id, fi.title, fi.canonical_url, fi.author, fi.publication_time,
            cc.source_name, cc.original_author, cc.original_published_at,
            cc.best_discovery_source, cc.discovery_sources_json, cc.historical_signal,
            cc.hn_points, cc.hn_comments, cc.hn_submissions, cc.status,
            ac.body_text, ac.body_chars, ac.extraction_method, ac.structured_data,
            ac.title AS extracted_title, ac.author AS extracted_author,
            ac.published_at AS extracted_published_at, ac.site_name, ac.lead_image_url
     FROM classics_candidates cc
     JOIN feed_items fi ON fi.id = cc.item_id
     LEFT JOIN article_content ac ON ac.item_id = cc.item_id
     WHERE fi.canonical_url IS NOT NULL AND (${where})
     ORDER BY cc.historical_signal DESC, cc.first_discovered_at ASC`,
  );
}

function canonicalPreviouslySeen(db: Db, itemId: string, canonicalUrl: string): boolean {
  return !!db.get(
    `SELECT 1 FROM feed_items fi
     WHERE fi.canonical_url = :url
       AND fi.id <> :item
       AND (
         EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = fi.id)
         OR EXISTS (SELECT 1 FROM open_events o WHERE o.item_id = fi.id)
       )
     LIMIT 1`,
    { item: itemId, url: canonicalUrl },
  );
}

function paywallMarker(text: string): boolean {
  return /(?:this post is for paid subscribers|subscribe (?:now )?to continue|continue reading (?:with|by|after) (?:a )?(?:paid )?subscription|unlock (?:the )?(?:full )?(?:article|post)|already a paid subscriber|members only|subscriber-only)/i.test(
    text,
  );
}

function updateCandidateStatus(db: Db, itemId: string, status: string, reason: string | null): void {
  db.run(
    `UPDATE classics_candidates SET status = :status, rejection_reason = :reason, updated_at = :now
     WHERE item_id = :item`,
    { item: itemId, status, reason, now: Date.now() },
  );
}

function prefetchSelection(rows: CandidateRow[], limit: number): CandidateRow[] {
  const perDomain = new Map<string, number>();
  const perYear = new Map<number, number>();
  const selected: CandidateRow[] = [];
  const pools = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const pool = pools.get(row.best_discovery_source) ?? [];
    pool.push(row);
    pools.set(row.best_discovery_source, pool);
  }
  const order = ['hn_archive', 'longreads_archive', ...[...pools.keys()].filter((key) => key !== 'hn_archive' && key !== 'longreads_archive')];
  // Two HN candidates for every editorial/archive candidate keeps HN useful
  // without recreating its programming/startup monoculture.
  const cycle = ['hn_archive', 'hn_archive', 'longreads_archive', ...order.filter((key) => !['hn_archive', 'longreads_archive'].includes(key))];
  const cursors = new Map<string, number>();
  let misses = 0;
  let cycleIndex = 0;
  while (selected.length < limit && misses < Math.max(4, cycle.length * 3)) {
    const key = cycle[cycleIndex % cycle.length] ?? 'hn_archive';
    cycleIndex += 1;
    const pool = pools.get(key) ?? [];
    let cursor = cursors.get(key) ?? 0;
    let picked = false;
    while (cursor < pool.length) {
      const row = pool[cursor++]!;
      const domain = hostOf(row.canonical_url) ?? row.source_name;
      const published = row.original_published_at ?? row.extracted_published_at ?? row.publication_time;
      const year = published ? new Date(published).getUTCFullYear() : 0;
      if ((perDomain.get(domain) ?? 0) >= 4 || (perYear.get(year) ?? 0) >= 10) continue;
      selected.push(row);
      perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
      perYear.set(year, (perYear.get(year) ?? 0) + 1);
      picked = true;
      break;
    }
    cursors.set(key, cursor);
    misses = picked ? 0 : misses + 1;
  }
  return selected;
}

export async function verifyClassicEligibility(db: Db, config: AppConfig): Promise<EligibilityStats> {
  const stats: EligibilityStats = {
    attempted: 0,
    eligible: 0,
    rejectedAccess: 0,
    rejectedLanguage: 0,
    rejectedDuplicate: 0,
  };
  const candidates = prefetchSelection(
    rowsFor(db, `cc.status IN ('discovered', 'access_verified') AND NOT EXISTS (
      SELECT 1 FROM classics_evaluations ce WHERE ce.item_id = cc.item_id
    )`),
    config.classics.discovery.prefetch_limit,
  );
  if (candidates.length === 0) return stats;

  await extractForItems(db, config, candidates.map((candidate) => candidate.item_id));
  const refreshed = new Map(rowsFor(db, `cc.item_id IN (${candidates.map((row) => `'${row.item_id}'`).join(',')})`).map((r) => [r.item_id, r]));
  const cutoff = Date.now() - config.classics.discovery.min_age_days * DAY_MS;

  db.transaction(() => {
    for (const original of candidates) {
      stats.attempted += 1;
      const row = refreshed.get(original.item_id) ?? original;
      if (canonicalPreviouslySeen(db, row.item_id, row.canonical_url)) {
        updateCandidateStatus(db, row.item_id, 'rejected_duplicate', 'same article was already surfaced or opened');
        stats.rejectedDuplicate += 1;
        continue;
      }

      const explicit = explicitFreeAccess(row.structured_data);
      const readable = row.extraction_method === 'readability';
      const enoughText = (row.body_chars ?? 0) >= config.classics.eligibility.min_body_chars;
      const markedPaid = explicit === false || paywallMarker(row.body_text ?? '');
      if (
        (config.classics.eligibility.require_readability && !readable) ||
        !enoughText ||
        (config.classics.eligibility.reject_explicitly_paid && markedPaid)
      ) {
        updateCandidateStatus(
          db,
          row.item_id,
          'rejected_access',
          markedPaid ? 'subscriber/paywall marker found' : 'full readable article text unavailable',
        );
        stats.rejectedAccess += 1;
        continue;
      }

      if (config.classics.eligibility.require_english) {
        const language = classifyArticleLanguage([row.extracted_title, row.body_text], null);
        if (language.verdict !== 'english') {
          updateCandidateStatus(db, row.item_id, 'rejected_language', language.reason);
          stats.rejectedLanguage += 1;
          continue;
        }
      }

      const publishedAt = row.extracted_published_at ?? row.original_published_at ?? row.publication_time;
      if (publishedAt && publishedAt > cutoff) {
        updateCandidateStatus(db, row.item_id, 'rejected_too_recent', 'article is not old enough for Classics');
        continue;
      }

      db.run(
        `UPDATE classics_candidates SET
           source_name = COALESCE(NULLIF(:site, ''), source_name),
           original_author = COALESCE(NULLIF(:author, ''), original_author),
           original_published_at = COALESCE(:published, original_published_at),
           status = 'access_verified', rejection_reason = NULL, updated_at = :now
         WHERE item_id = :item`,
        {
          item: row.item_id,
          site: row.site_name,
          author: row.extracted_author,
          published: publishedAt,
          now: Date.now(),
        },
      );
      db.run(
        `UPDATE feed_items SET
           title = COALESCE(NULLIF(:title, ''), title),
           author = COALESCE(NULLIF(:author, ''), author),
           publication_time = COALESCE(:published, publication_time)
         WHERE id = :item`,
        { item: row.item_id, title: row.extracted_title, author: row.extracted_author, published: publishedAt },
      );
      stats.eligible += 1;
    }
  });

  return stats;
}

function safeSources(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function userMessage(row: CandidateRow, config: AppConfig): string {
  const published = row.original_published_at ?? row.extracted_published_at ?? row.publication_time;
  const excerpt = structuralExcerpt(row.body_text ?? '', config.pipeline.extraction.max_chars_for_model);
  const content = [
    `Title: ${row.extracted_title ?? row.title}`,
    `Source: ${row.site_name ?? row.source_name}`,
    `Author: ${row.extracted_author ?? row.original_author ?? row.author ?? 'unknown'}`,
    `Original publication date: ${published ? new Date(published).toISOString().slice(0, 10) : 'unknown'}`,
    `URL: ${row.canonical_url}`,
    `Discovery sources: ${safeSources(row.discovery_sources_json).join(', ')}`,
    `Historical discovery context: ${row.hn_points} HN points, ${row.hn_comments} comments, ${row.hn_submissions} submissions.`,
    `Article length: ~${Math.round((row.body_chars ?? 0) / 6)} words.`,
    '',
    excerpt.excerpted
      ? '--- Article text (opening and closing; middle omitted for model context) ---'
      : '--- Full article text ---',
    excerpt.text,
    excerpt.excerpted ? `\n(${excerpt.omittedChars} characters omitted from the middle.)` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return untrustedDataBlock('classic article', content);
}

function archivalScore(result: ClassicsResult, historicalSignal: number, config: AppConfig): number {
  const values = result as unknown as Record<string, unknown>;
  const weights = config.classics.ranking.weights;
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    weighted += Number(values[key] ?? 0) * weight;
    totalWeight += weight;
  }
  const predictedSatisfaction = Math.sqrt(result.predicted_read * result.predicted_payoff);
  const execution = totalWeight > 0 ? weighted / totalWeight : predictedSatisfaction;
  const historyWeight = config.classics.ranking.historical_signal_weight;
  // Geometric mean makes a severe weakness in either start probability or
  // payoff visible while still allowing an extraordinary out-of-lane article
  // to win through execution. It is retained as predicted_satisfaction for
  // compatibility with existing reports and learning data.
  let score = (0.50 * predictedSatisfaction + 0.50 * execution) * (1 - historyWeight);
  score += historicalSignal * historyWeight;
  for (const [key, weight] of Object.entries(config.classics.ranking.penalties)) {
    score -= Number(values[key] ?? 0) * weight;
  }
  return Math.max(0, Math.min(1, score));
}

function stubResult(row: CandidateRow): ClassicsResult {
  const long = Math.min(1, (row.body_chars ?? 0) / 20_000);
  return {
    analysis: 0.75,
    storytelling: 0.7,
    authorial_voice: 0.7,
    entertainment: 0.7,
    obsessive_expertise: 0.65 + long * 0.15,
    rabbit_hole: 0.72,
    critique: 0.65,
    humor: 0.35,
    enduring_value: 0.8,
    personal_interest: 0.55,
    historical_quality: row.historical_signal,
    homework: 0.08,
    datedness: 0.05,
    ragebait: 0.02,
    predicted_read: 0.82,
    predicted_payoff: 0.82,
    category: 'wildcard',
    pleasure_class: 'deep dive',
    why_picked: `[dry run] ${row.title}`,
    enduring_reason: 'Long-form archival candidate.',
  };
}

export async function evaluateClassics(
  db: Db,
  config: AppConfig,
  ai: AiClient,
): Promise<EvaluationStats> {
  const beforeSpend = ai.spentUsd;
  const currentPrompt = config.classics.prompt;
  const candidates = prefetchSelection(
    rowsFor(db, `cc.status IN ('access_verified', 'evaluated', 'recommended') AND (
      NOT EXISTS (SELECT 1 FROM classics_evaluations ce WHERE ce.item_id = cc.item_id)
      OR EXISTS (SELECT 1 FROM classics_evaluations ce WHERE ce.item_id = cc.item_id AND ce.prompt_version <> '${currentPrompt}')
    )`),
    config.classics.discovery.model_limit,
  );
  const stats: EvaluationStats = { considered: candidates.length, evaluated: 0, failed: 0, spendUsd: 0 };
  if (candidates.length === 0) return stats;

  const prompt = loadPrompt(config, currentPrompt);
  const system = render(prompt.body, {
    ...tasteVars(config.taste),
    CATEGORIES: config.categories.join(', '),
  });

  await mapPool(candidates, config.models.models.deep.max_concurrency, async (row) => {
    try {
      let result: ClassicsResult;
      let raw: string;
      let inputTokens = 0;
      let outputTokens = 0;
      if (ai.dryRun) {
        result = stubResult(row);
        raw = JSON.stringify(result);
      } else {
        const completion = await ai.complete(
          'deep',
          [
            { role: 'system', content: system },
            { role: 'user', content: userMessage(row, config) },
          ],
          { maxTokens: 950, jsonMode: true, temperature: 0.2 },
        );
        const parsed = parseModelJson(completion.text, classicsResultSchema);
        if (!parsed.ok || !parsed.value) throw new Error(parsed.error ?? 'unparseable Classics response');
        result = parsed.value;
        raw = completion.text;
        inputTokens = completion.usage.inputTokens;
        outputTokens = completion.usage.outputTokens;
      }

      const category = config.categories.includes(result.category) ? result.category : 'other';
      const score = archivalScore(result, row.historical_signal, config);
      db.transaction(() => {
        db.run(
          `INSERT INTO classics_evaluations (
             item_id, analysis, storytelling, authorial_voice, entertainment,
             obsessive_expertise, rabbit_hole, critique, humor, enduring_value,
             personal_interest, historical_quality, homework, datedness, ragebait,
             predicted_read, predicted_payoff, predicted_satisfaction,
             archival_score, category, pleasure_class,
             why_picked, enduring_reason, model, prompt_version, config_hash,
             input_tokens, output_tokens, raw_json, created_at)
           VALUES (:item, :analysis, :story, :voice, :fun, :expertise, :rabbit,
                   :critique, :humor, :enduring, :interest, :history, :homework,
                   :dated, :rage, :predicted_read, :predicted_payoff,
                   :satisfaction, :score, :category, :pleasure,
                   :why, :enduring_reason, :model, :prompt, :hash, :input, :output,
                   :raw, :now)
           ON CONFLICT(item_id) DO UPDATE SET
             analysis=excluded.analysis, storytelling=excluded.storytelling,
             authorial_voice=excluded.authorial_voice, entertainment=excluded.entertainment,
             obsessive_expertise=excluded.obsessive_expertise, rabbit_hole=excluded.rabbit_hole,
             critique=excluded.critique, humor=excluded.humor,
             enduring_value=excluded.enduring_value, personal_interest=excluded.personal_interest,
             historical_quality=excluded.historical_quality, homework=excluded.homework,
             datedness=excluded.datedness, ragebait=excluded.ragebait,
             predicted_read=excluded.predicted_read,
             predicted_payoff=excluded.predicted_payoff,
             predicted_satisfaction=excluded.predicted_satisfaction,
             archival_score=excluded.archival_score, category=excluded.category,
             pleasure_class=excluded.pleasure_class, why_picked=excluded.why_picked,
             enduring_reason=excluded.enduring_reason, model=excluded.model,
             prompt_version=excluded.prompt_version, config_hash=excluded.config_hash,
             input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
             raw_json=excluded.raw_json, created_at=excluded.created_at`,
          {
            item: row.item_id,
            analysis: result.analysis,
            story: result.storytelling,
            voice: result.authorial_voice,
            fun: result.entertainment,
            expertise: result.obsessive_expertise,
            rabbit: result.rabbit_hole,
            critique: result.critique,
            humor: result.humor,
            enduring: result.enduring_value,
            interest: result.personal_interest,
            history: result.historical_quality,
            homework: result.homework,
            dated: result.datedness,
            rage: result.ragebait,
            predicted_read: result.predicted_read,
            predicted_payoff: result.predicted_payoff,
            satisfaction: Math.sqrt(result.predicted_read * result.predicted_payoff),
            score,
            category,
            pleasure: result.pleasure_class,
            why: result.why_picked,
            enduring_reason: result.enduring_reason,
            model: ai.modelFor('deep'),
            prompt: prompt.id,
            hash: config.hashes.classics,
            input: inputTokens,
            output: outputTokens,
            raw: raw.slice(0, 10_000),
            now: Date.now(),
          },
        );
        db.run(
          `UPDATE classics_candidates SET
             status = CASE WHEN status = 'recommended' THEN 'recommended' ELSE 'evaluated' END,
             rejection_reason = NULL, updated_at = :now
           WHERE item_id = :item`,
          { item: row.item_id, now: Date.now() },
        );
      });
      stats.evaluated += 1;
    } catch (error) {
      stats.failed += 1;
      // Budget exhaustion is temporary: keep the verified candidate queued for
      // the next run instead of turning a resource limit into an editorial loss.
      updateCandidateStatus(
        db,
        row.item_id,
        error instanceof SpendLimitError ? 'access_verified' : 'evaluation_failed',
        error instanceof Error ? error.message : String(error),
      );
      log.warn(`classics evaluation failed: ${row.title}`, error);
    }
  });

  stats.spendUsd = ai.spentUsd - beforeSpend;
  return stats;
}

/** HTML inspection helper used by live audits and tests without duplicating extraction semantics. */
export function inspectClassicHtml(html: string, url: string, minBodyChars: number): {
  readable: boolean;
  explicitlyFree: boolean | null;
  english: boolean;
} {
  const article = extractFromHtml(html, url);
  return {
    readable: article.method === 'readability' && article.bodyText.length >= minBodyChars && !paywallMarker(article.bodyText),
    explicitlyFree: explicitFreeAccess(JSON.stringify(article.structuredData)),
    english: classifyArticleLanguage([article.title, article.bodyText], null).verdict === 'english',
  };
}
