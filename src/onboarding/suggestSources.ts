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
type Lane = (typeof LANES)[number];
const ROLES = ['direct_follow', 'selective', 'discovery_only', 'wildcard'] as const;
type Role = (typeof ROLES)[number];

const nearest = <T extends string>(allowed: readonly T[], fallback: T) => (value: unknown): T => {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.find((option) => option === raw)
    ?? allowed.find((option) => raw.startsWith(option) || option.startsWith(raw))
    ?? fallback;
};
const asRole = nearest(ROLES, 'selective');
const asDisposition = nearest(['known_favorite', 'recommended', 'exploratory', 'avoid'] as const, 'exploratory');

const unit = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

export interface LaneVerdict {
  lane: Lane;
  fit: number;
  role: Role;
  reason: string;
}

export interface ProposedSource {
  name: string;
  domain: string;
  homepageUrl: string;
  sourceType: string;
  lanes: LaneVerdict[];
  contentAreas: string[];
  caveats: string[];
  incrementalValue: string;
  expectedYield: string;
  disposition: 'known_favorite' | 'recommended' | 'exploratory' | 'avoid';
  basis: string[];
  confidence: number;
}

/**
 * Parse one candidate from the v2 shape.
 *
 * v2 scores each lane separately — a wire can be a strong `briefing` fit and a
 * weak `feeds` one — so `lanes` is an object of verdicts rather than a list of
 * names, and `role` lives inside each lane rather than at the top. A lane the
 * model set to null, or filled with nonsense, is simply not assigned.
 */
function parseCandidate(raw: unknown): ProposedSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = String(record.name ?? '').trim();
  if (!name) return null;

  const homepageUrl = String(record.homepage_url ?? '').trim();
  // The prompt asks for a bare hostname, but a model that ignores that must not
  // produce a candidate Sift then fails to fetch.
  let domain = String(record.domain ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
  if (!domain && homepageUrl) domain = hostOf(homepageUrl)?.replace(/^www\./, '') ?? '';
  if (!domain) return null;

  const laneRecord = (record.lanes ?? {}) as Record<string, unknown>;
  const lanes: LaneVerdict[] = [];
  for (const lane of LANES) {
    const verdict = laneRecord[lane];
    if (!verdict || typeof verdict !== 'object') continue;
    const entry = verdict as Record<string, unknown>;
    lanes.push({
      lane,
      fit: unit(entry.fit, 0.5),
      role: asRole(entry.role),
      reason: String(entry.reason ?? '').trim(),
    });
  }
  // "Every candidate must qualify for at least one lane." Enforced here so the
  // rule holds whether or not the model followed it.
  if (lanes.length === 0) return null;

  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];

  return {
    name,
    domain,
    homepageUrl,
    sourceType: String(record.source_type ?? 'publication').trim().toLowerCase(),
    lanes: lanes.sort((a, b) => b.fit - a.fit),
    contentAreas: list(record.content_areas),
    caveats: list(record.caveats),
    incrementalValue: String(record.incremental_value ?? '').trim(),
    expectedYield: String(record.expected_yield ?? '').trim(),
    disposition: asDisposition(record.disposition),
    basis: list(record.basis),
    confidence: unit(record.confidence, 0.5),
  };
}

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

type StoredCandidate = z.output<typeof sourceCandidateSchema>;

/**
 * Fold new proposals into the stored list.
 *
 * A re-proposal replaces the stored one rather than being skipped. A later run
 * has more evidence — more observed domains, a newer prompt — and the first
 * version of this kept whichever verdict arrived first, so re-running with the
 * lane-aware v2 prompt left three sources still carrying v1's single-lane
 * guesses.
 */
export function mergeCandidates(
  previous: StoredCandidate[],
  incoming: StoredCandidate[],
): { merged: StoredCandidate[]; refreshed: number } {
  const key = (candidate: { name: string; domain: string }) =>
    `${candidate.name.trim().toLowerCase()}|${candidate.domain.trim().toLowerCase()}`;
  const byKey = new Map(previous.map((candidate) => [key(candidate), candidate]));
  let refreshed = 0;
  for (const candidate of incoming) {
    if (byKey.has(key(candidate))) refreshed += 1;
    byKey.set(key(candidate), candidate);
  }
  return { merged: [...byKey.values()], refreshed };
}

/** Exposed for tests: parsing model output is where this breaks in practice. */
export function parseCandidatesForTest(raw: string): ProposedSource[] {
  const envelope = parseModelJson(raw, z.object({ candidates: z.array(z.unknown()).default([]) }));
  if (!envelope.ok) return [];
  return envelope.value!.candidates
    .map(parseCandidate)
    .filter((candidate): candidate is ProposedSource => candidate !== null);
}

export interface SuggestionResult {
  /** The model's full verdict, for display. */
  proposals: ProposedSource[];
  /** The same sources, projected onto the shape the rest of Sift stores. */
  candidates: Array<z.output<typeof sourceCandidateSchema>>;
  merged: number;
  skippedExisting: number;
  usedObserved: number;
  spendUsd: number;
}

/**
 * Project a v2 verdict onto the candidate shape the rest of Sift reads.
 *
 * v2 scores each lane separately, which the stored source cannot express: a
 * `sources.yaml` entry has one `volume_budget`, not one per lane. The role of
 * the best-fitting lane wins, because that is the lane the source is really
 * being added for, and the per-lane reasoning is preserved in the text rather
 * than silently dropped.
 */
function toStoredCandidate(proposal: ProposedSource): z.output<typeof sourceCandidateSchema> {
  const best = proposal.lanes[0]!;
  const reason = [
    proposal.incrementalValue,
    ...proposal.lanes.map((lane) => `${lane.lane}: ${lane.reason}`),
  ].filter(Boolean).join(' ');
  return {
    name: proposal.name,
    domain: proposal.domain,
    disposition: proposal.disposition,
    role: best.role,
    lanes: proposal.lanes.map((lane) => lane.lane),
    content_areas: proposal.contentAreas,
    // Expected yield is a caveat in everything but name: it is what the reader
    // needs to know about how much filtering this source will require.
    caveats: [...proposal.caveats, ...(proposal.expectedYield ? [`expected yield: ${proposal.expectedYield}`] : [])],
    reason: reason || `${proposal.name} (${proposal.sourceType})`,
    // The stored enum predates v2's richer list; observed evidence is the only
    // distinction the downstream prior actually uses.
    basis: proposal.basis.includes('observed_domains') ? 'observed' : 'inferred',
    confidence: proposal.confidence,
  };
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
  const prompt = loadPrompt(config, config.suggestion.prompt);

  const existing = config.sources.map((source) => {
    const host = hostOf(source.feed_url)?.replace(/^www\./, '') ?? '';
    return `- ${source.name}${host ? ` (${host})` : ''}`;
  });
  const observed = db ? observedDomains(db) : [];

  const system = render(prompt.body, {
    ...tasteVars(config.taste),
    EXISTING_SOURCES: existing.join('\n') || '(none yet)',
    // Hostnames harvested from fetched pages, so they are delimited as
    // untrusted even though Sift derived the list itself.
    OBSERVED_DOMAINS: observed.length > 0
      ? untrustedDataBlock('observed domains', observed
          .map((entry) => `- ${entry.domain}: ${entry.items} articles, median score ${entry.medianScore.toFixed(2)}`)
          .join('\n'))
      : '(no reading history yet — propose from the reader profile alone)',
    MAX_CANDIDATES: String(max),
  });

  const before = ai.spentUsd;
  const completion = await ai.complete(
    'deep',
    [
      { role: 'system', content: system },
      { role: 'user', content: 'Propose sources for this reader now.' },
    ],
    // A list of publications with reasons is far longer than the
    // single-article verdict models.yaml sizes the default for.
    { jsonMode: true, maxTokens: config.suggestion.max_output_tokens },
  );

  const envelope = parseModelJson(completion.text, z.object({ candidates: z.array(z.unknown()).default([]) }));
  if (!envelope.ok) {
    // Include what came back: truncation and refusal look identical otherwise.
    const sample = completion.text.trim().slice(-200) || '(empty response)';
    throw new Error(
      `Could not read the model's source suggestions: ${envelope.error}. ` +
      `It ended with: …${sample}. If it looks cut off, raise suggestion.max_output_tokens in sources.yaml.`,
    );
  }
  // Each candidate is parsed on its own, so one malformed entry costs one
  // proposal rather than the whole reply.
  const proposed = envelope.value!.candidates
    .map(parseCandidate)
    .filter((candidate): candidate is ProposedSource => candidate !== null);

  // Never re-propose something already configured; the model is told not to,
  // and this makes it true regardless.
  const known = new Set<string>();
  for (const source of config.sources) {
    const host = hostOf(source.feed_url)?.replace(/^www\./, '');
    if (host) known.add(host);
    known.add(source.name.trim().toLowerCase());
  }

  const fresh = proposed.filter((candidate) =>
    !known.has(candidate.domain) && !known.has(candidate.name.trim().toLowerCase()));
  const skippedExisting = proposed.length - fresh.length;

  const stored = fresh.map(toStoredCandidate);

  const path = resolve(profileDir, 'source-candidates.json');
  const previous = readCandidates(path);
  const { merged, refreshed } = mergeCandidates(previous, stored);

  atomicWrite(path, `${JSON.stringify({ version: 1, candidates: merged }, null, 2)}\n`);
  log.info(`proposed ${fresh.length} source(s); ${refreshed} replaced an earlier proposal; ${skippedExisting} were already followed`);

  return {
    proposals: fresh,
    candidates: stored,
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
