/**
 * Turning an assistant's source suggestion into a source Sift actually reads.
 *
 * This is the last step of the idea the onboarding dossier exists for: the
 * reader's personal assistant already knows which writers and publications suit
 * them, and Sift should be able to follow those without the reader hand-writing
 * YAML. Until this existed, `source_candidates` could only nudge the quality
 * prior of a source the reader had already configured by hand — so a suggestion
 * for someone they did not already follow did nothing at all.
 *
 * Three properties are deliberate:
 *
 *   Nothing is adopted without an explicit approval. The assistant proposes, the
 *   reader confirms, Sift writes. `sources.yaml` itself is never touched.
 *
 *   Adopted sources go in a separate additive file. Profile config files are
 *   whole-file overrides, so writing into a profile copy of `sources.yaml` would
 *   freeze that reader's list and silently withhold later changes to the shared
 *   one.
 *
 *   Resolved values are written out explicitly. Retuning the adoption table in
 *   `sources.yaml` must not silently re-rate sources a reader already accepted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { sourcesOverlayFileSchema, type AppConfig } from '../config/index.js';
import { atomicWrite } from './index.js';
import type { SourceDiscoveryResult } from './sourceDiscovery.js';

export interface AdoptableSource {
  /** Stable id derived from the candidate, unique within the reader's list. */
  id: string;
  name: string;
  feedUrl: string;
  feedTitle: string | null;
  domain: string;
  disposition: 'known_favorite' | 'recommended' | 'exploratory' | 'avoid';
  role: 'direct_follow' | 'selective' | 'discovery_only' | 'wildcard';
  reason: string;
  /** Lanes this source will serve once adopted. */
  lanes: Array<'feeds' | 'briefing' | 'classics'>;
  caveats: string[];
  sampleTitles: string[];
  qualityPrior: number;
  volumeBudget: number;
  /** Already present in this reader's configuration. */
  alreadyConfigured: boolean;
}

/** Source ids are `[a-z0-9_]+`; derive one that cannot collide with a slug. */
export function sourceIdFor(name: string, domain: string): string {
  const base = (domain || name)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .replace(/\.[a-z]{2,}$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'source';
}

/**
 * Which discovered candidates the reader could reasonably adopt.
 *
 * `avoid` candidates are never offered: the assistant is warning against them,
 * and an approval screen that lists them invites a misclick with no upside.
 * Candidates whose feed could not be validated are excluded too — Sift will not
 * invent a feed URL.
 */
export function adoptableSources(
  results: SourceDiscoveryResult[],
  config: AppConfig,
): AdoptableSource[] {
  const configured = new Set(config.sources.map((source) => source.id));
  const configuredHosts = new Set(
    config.sources.map((source) => {
      try {
        return new URL(source.feed_url).hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        return '';
      }
    }).filter(Boolean),
  );
  const adoption = config.adoption;
  const out: AdoptableSource[] = [];

  for (const result of results) {
    if (result.status !== 'validated' || result.feeds.length === 0) continue;
    const candidate = result.candidate;
    if (candidate.disposition === 'avoid') continue;
    const feed = result.feeds[0]!;
    const domain = candidate.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
    const id = sourceIdFor(candidate.name, domain);
    const role = candidate.role ?? 'direct_follow';
    let feedHost = '';
    try {
      feedHost = new URL(feed.feed_url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue; // A feed URL that will not parse cannot become a source.
    }
    out.push({
      id,
      name: candidate.name,
      feedUrl: feed.feed_url,
      feedTitle: feed.title,
      domain,
      disposition: candidate.disposition,
      role,
      reason: candidate.reason,
      // The model assigns lanes per source; fall back to the file default for
      // candidates that predate the field.
      lanes: candidate.lanes ?? config.sourcesDefaults.lanes,
      caveats: candidate.caveats ?? [],
      sampleTitles: feed.sample_titles.slice(0, 3),
      qualityPrior: adoption.quality_prior[candidate.disposition] ?? 0.5,
      volumeBudget: adoption.volume_budget[role] ?? 0.5,
      alreadyConfigured: configured.has(id) || configuredHosts.has(feedHost),
    });
  }
  return out;
}

export interface AdoptionOutcome {
  added: string[];
  skipped: Array<{ id: string; reason: string }>;
  path: string;
}

/**
 * Append approved sources to the reader's additive overlay.
 *
 * Re-runnable: adopting the same source twice is a no-op rather than an error,
 * because the reader has no way to know what a previous session already took.
 */
export function adoptSources(
  profileDir: string,
  config: AppConfig,
  chosen: AdoptableSource[],
): AdoptionOutcome {
  const path = resolve(profileDir, 'sources.added.yaml');
  // Parsed once, and validated: a hand-edited file must not silently corrupt
  // the list. The entries are then held loosely because they are only ever
  // serialised straight back to YAML, never used as SourceConfig here.
  const raw = existsSync(path) ? parseYaml(readFileSync(path, 'utf8')) : null;
  const existing = raw ? sourcesOverlayFileSchema.parse(raw) : { version: 1, sources: [] };
  const entries: Array<Record<string, unknown>> =
    (raw as { sources?: Array<Record<string, unknown>> } | null)?.sources ?? [];

  const taken = new Set([
    ...config.sources.map((source) => source.id),
    ...existing.sources.map((source) => source.id),
  ]);
  const added: string[] = [];
  const skipped: AdoptionOutcome['skipped'] = [];

  for (const source of chosen) {
    if (taken.has(source.id)) {
      skipped.push({ id: source.id, reason: 'already in this reader’s sources' });
      continue;
    }
    taken.add(source.id);
    added.push(source.id);
    entries.push({
      id: source.id,
      name: source.name,
      feed_url: source.feedUrl,
      // Written out rather than derived at load time, so retuning the adoption
      // table never re-rates a source the reader already accepted.
      lanes: source.lanes,
      quality_prior: source.qualityPrior,
      volume_budget: source.volumeBudget,
    });
  }

  if (added.length > 0) {
    atomicWrite(path, `${[
      '# Sources this reader adopted from their assistant’s suggestions.',
      '# Merged on top of config/sources.yaml; that file is never modified.',
      '# Safe to edit or delete by hand — removing an entry stops Sift reading it.',
      stringifyYaml({ version: 1, sources: entries }),
    ].join('\n')}`);
  }
  return { added, skipped, path };
}
