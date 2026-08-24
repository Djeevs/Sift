/**
 * Ask the deep model which sources this reader should follow.
 *
 * The onboarding dossier is already almost entirely criteria — interests,
 * rewarding and unrewarding qualities, timeliness, medium fit. Only
 * `source_candidates` names actual publications, and that put the assistant in
 * charge of a decision it is poorly placed to make: it knows the reader, not
 * the shape of Sift's three lanes, and it proposes from memory rather than
 * from anything Sift has observed.
 *
 * So the assistant supplies context and Sift does the choosing. This runs the
 * *deep* model, not the cheap one: it is a handful of calls per reader, ever,
 * and the judgement is closer to Terra's job than Luna's.
 *
 * Two things keep it honest.
 *
 * The model proposes names and domains only, never feed URLs. Everything it
 * returns goes through the same validation the assistant's suggestions do:
 * `discoverProfileSources` fetches the domain and confirms it really publishes
 * a feed, so an invented publication dies there rather than becoming a source.
 *
 * Where Sift has evidence, the model is given it. Hacker News discovery has
 * already surfaced dozens of domains outside the source list, some of which
 * produced articles Terra scored highly for this reader. That is a stronger
 * signal than any model's prior, and the prompt says so.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import type { AiClient } from '../ai/client.js';
import { loadPrompt, render, tasteVars, untrustedDataBlock } from '../ai/prompts.js';
import { parseModelJson } from '../ai/json.js';
import { hostOf } from '../util/url.js';
import { logger } from '../util/log.js';
import { atomicWrite, sourceCandidateSchema } from './index.js';

const log = logger('suggest');

/**
 * A tolerant reading of the model's reply.
 *
 * The stored candidate schema is strict, and rightly so — but applying it
 * directly to model output threw away six good proposals because one said
 * `"observed_fit"` where the enum wanted `"observed"`. Every other model
 * boundary in Sift coerces rather than rejects, for the same reason: a whole
 * response is too much to lose to one unrecognised word.
 */
const LANES = ['feeds', 'briefing', 'classics'] as const;
const nearest = <T extends string>(allowed: readonly T[], fallback: T) =>
  z.unknown().transform((value) => {
    const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return allowed.find((option) => option === raw)
      ?? allowed.find((option) => raw.startsWith(option) || option.startsWith(raw))
      ?? fallback;
  });

const modelCandidateSchema = z.object({
  name: z.unknown().transform((v) => String(v ?? '').trim()),
  domain: z.unknown().transform((v) => String(v ?? '').trim()),
  disposition: nearest(['known_favorite', 'recommended', 'exploratory', 'avoid'] as const, 'exploratory'),
  role: nearest(['direct_follow', 'selective', 'discovery_only', 'wildcard'] as const, 'selective'),
  lanes: z.unknown().transform((value) => {
    const list = (Array.isArray(value) ? value : [])
      .map((entry) => String(entry ?? '').trim().toLowerCase())
      .filter((entry): entry is (typeof LANES)[number] => (LANES as readonly string[]).includes(entry));
    // A source with no usable lane is not a source; fall back to the default.
    return list.length > 0 ? [...new Set(list)] : ['feeds', 'briefing'] as Array<(typeof LANES)[number]>;
  }),
  content_areas: z.unknown().transform((v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])),
  caveats: z.unknown().transform((v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])),
  reason: z.unknown().transform((v) => String(v ?? '').trim()),
  basis: nearest(['explicit', 'observed', 'inferred'] as const, 'inferred'),
  confidence: z.unknown().transform((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  }),
});

const responseSchema = z.object({
  candidates: z.array(modelCandidateSchema).default([]),
});

export interface ObservedDomain {
  domain: string;
  items: number;
  medianScore: number;
}

/**
 * Domains Sift has already watched perform for this reader.
 *
 * Only from discovery sources: an item from a configured source tells you
 * nothing new about whether to configure it. The threshold is deliberately
 * low, because this is evidence to weigh rather than a decision.
 */
export function observedDomains(db: Db, limit = 20): ObservedDomain[] {
  try {
    const rows = db.all<{ url: string; score: number }>(
      `SELECT COALESCE(fi.canonical_url, fi.original_url) AS url, de.expected_attention_value AS score
       FROM deep_evaluations de
       JOIN feed_items fi ON fi.id = de.item_id
       JOIN sources s ON s.id = fi.source_id
       -- Discovery sources only. An item from a source already configured
       -- says nothing about whether to configure it, so it is not evidence for
       -- this question. The sources table records feed_type, not the discovery
       -- block, so linkblog is the marker available here.
       WHERE s.feed_type = 'linkblog'`,
    );
    const byDomain = new Map<string, number[]>();
    for (const row of rows) {
      const host = hostOf(row.url ?? '')?.replace(/^www\./, '');
      if (!host) continue;
      (byDomain.get(host) ?? byDomain.set(host, []).get(host)!).push(row.score);
    }
    return [...byDomain.entries()]
      .map(([domain, scores]) => {
        const sorted = [...scores].sort((a, b) => a - b);
        return { domain, items: scores.length, medianScore: sorted[Math.floor(sorted.length / 2)] ?? 0 };
      })
      // One good article is luck; several is a pattern.
      .filter((entry) => entry.items >= 2)
      .sort((a, b) => b.medianScore - a.medianScore || b.items - a.items)
      .slice(0, limit);
  } catch {
    // Evidence is a bonus. A reader with no database still gets suggestions.
    return [];
  }
}

export interface SuggestionResult {
  candidates: Array<z.output<typeof sourceCandidateSchema>>;
  merged: number;
  skippedExisting: number;
  usedObserved: number;
  spendUsd: number;
}

/**
 * Propose sources, and merge them into the reader's candidate file.
 *
 * Writing into `source-candidates.json` rather than somewhere new means the
 * existing path — validate the feed, then let the reader approve it — applies
 * unchanged. Sift still never adopts a source without being asked.
 */
export async function suggestSources(
  db: Db | null,
  ai: AiClient,
  config: AppConfig,
  profileDir: string,
  options: { maxCandidates?: number } = {},
): Promise<SuggestionResult> {
  const max = options.maxCandidates ?? config.suggestion.max_candidates;
  const prompt = loadPrompt(config, 'source-discovery-v1');

  const existing = config.sources.map((source) => {
    const host = hostOf(source.feed_url)?.replace(/^www\./, '') ?? '';
    return `- ${source.name}${host ? ` (${host})` : ''}`;
  });
  const observed = db ? observedDomains(db) : [];

  const system = render(prompt.body, {
    ...tasteVars(config.taste),
    EXISTING_SOURCES: existing.join('\n') || '(none yet)',
    OBSERVED_DOMAINS: observed.length > 0
      ? observed
          .map((entry) => `- ${entry.domain}: ${entry.items} articles, median score ${entry.medianScore.toFixed(2)}`)
          .join('\n')
      : '(no reading history yet — propose from the reader profile alone)',
    MAX_CANDIDATES: String(max),
  });

  const before = ai.spentUsd;
  const completion = await ai.complete(
    'deep',
    [
      { role: 'system', content: system },
      // Domain names come from fetched pages, so they are untrusted input even
      // though Sift derived the list itself.
      { role: 'user', content: untrustedDataBlock('reader context', 'Propose sources for this reader now.') },
    ],
    // A list of publications with reasons is far longer than the
    // single-article verdict models.yaml sizes the default for.
    { jsonMode: true, maxTokens: config.suggestion.max_output_tokens },
  );

  const parsed = parseModelJson(completion.text, responseSchema);
  if (!parsed.ok) {
    // Include what came back: truncation and refusal look identical otherwise.
    const sample = completion.text.trim().slice(-200) || '(empty response)';
    throw new Error(
      `Could not read the model's source suggestions: ${parsed.error}. ` +
      `It ended with: …${sample}. If it looks cut off, raise suggestion.max_output_tokens in sources.yaml.`,
    );
  }

  // Never re-propose something already configured; the model is told not to,
  // and this makes it true regardless.
  const known = new Set<string>();
  for (const source of config.sources) {
    const host = hostOf(source.feed_url)?.replace(/^www\./, '');
    if (host) known.add(host);
    known.add(source.name.trim().toLowerCase());
  }

  const usable = parsed.value!.candidates.filter((c) => c.name && c.domain && c.reason.length >= 5);
  const fresh = usable.filter((candidate) => {
    const host = candidate.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return !(host && known.has(host)) && !known.has(candidate.name.trim().toLowerCase());
  });
  const skippedExisting = usable.length - fresh.length;

  const path = resolve(profileDir, 'source-candidates.json');
  const previous = readCandidates(path);
  const seen = new Set(previous.map((c) => `${c.name.toLowerCase()}|${c.domain.toLowerCase()}`));
  const merged = [...previous];
  for (const candidate of fresh) {
    const key = `${candidate.name.toLowerCase()}|${candidate.domain.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }

  atomicWrite(path, `${JSON.stringify({ version: 1, candidates: merged }, null, 2)}\n`);
  log.info(`proposed ${fresh.length} source(s); ${skippedExisting} were already followed`);

  return {
    candidates: fresh,
    merged: merged.length,
    skippedExisting,
    usedObserved: observed.length,
    spendUsd: ai.spentUsd - before,
  };
}

function readCandidates(path: string): Array<z.output<typeof sourceCandidateSchema>> {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { candidates?: unknown };
    const result = z.array(sourceCandidateSchema).safeParse(parsed.candidates ?? []);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
