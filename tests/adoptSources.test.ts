import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadConfig, PROJECT_ROOT } from '../src/config/index.js';
import { adoptSources, adoptableSources, sourceIdFor } from '../src/onboarding/adoptSources.js';
import type { SourceDiscoveryResult } from '../src/onboarding/sourceDiscovery.js';

function candidate(over: Partial<SourceDiscoveryResult['candidate']> = {}) {
  return {
    // Deliberately fictional: this fixture must not depend on what happens to
    // be in the real sources.yaml. Detection against the live list is asserted
    // separately below.
    name: 'Example Writer',
    domain: 'example-writer.test',
    disposition: 'recommended' as const,
    role: 'direct_follow' as const,
    content_areas: [],
    caveats: ['Some posts are implementation-heavy'],
    reason: 'Strong fit for firsthand experimentation with new AI capabilities.',
    basis: 'inferred' as const,
    confidence: 0.9,
    ...over,
  };
}

function result(over: Partial<SourceDiscoveryResult> = {}): SourceDiscoveryResult {
  return {
    candidate: candidate(),
    status: 'validated',
    feeds: [{ feed_url: 'https://example-writer.test/feed.xml', title: 'Example Writer', item_count: 20, content_type: 'application/atom+xml', sample_titles: ['A note', 'Another note'] }],
    notes: [],
    ...over,
  };
}

function profileDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'sift-adopt-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('adopting assistant-suggested sources', () => {
  const config = loadConfig({ configDir: resolve(PROJECT_ROOT, 'config'), reload: true });

  it('offers a validated candidate the reader does not already follow', () => {
    const items = adoptableSources([result()], config);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('example_writer');
    expect(items[0]!.alreadyConfigured).toBe(false);
    // Role decides how much of the edition it may claim.
    expect(items[0]!.volumeBudget).toBe(config.adoption.volume_budget.direct_follow);
  });

  // The assistant is warning against these; listing them only invites a misclick.
  it('never offers an avoid candidate', () => {
    const items = adoptableSources([result({ candidate: candidate({ disposition: 'avoid' }) })], config);
    expect(items).toHaveLength(0);
  });

  // Sift must not invent a feed URL for a domain it could not validate.
  it('never offers a candidate whose feed could not be validated', () => {
    expect(adoptableSources([result({ status: 'not_found', feeds: [] })], config)).toHaveLength(0);
  });

  // Regression: the first draft of this suite used Simon Willison as a
  // "new" source and failed, because he is already in sources.yaml. That was
  // the host matcher working -- worth asserting deliberately.
  it('recognises a configured source suggested under a different name', () => {
    const items = adoptableSources(
      [result({
        candidate: candidate({ name: 'Simon Willison’s Weblog', domain: 'simonwillison.net' }),
        feeds: [{ feed_url: 'https://simonwillison.net/atom/everything/', title: 'Simon Willison', item_count: 20, content_type: 'application/atom+xml', sample_titles: [] }],
      })],
      config,
    );
    expect(items[0]!.alreadyConfigured).toBe(true);
  });

  it('marks a candidate already in the configured list rather than duplicating it', () => {
    const existing = config.sources[0]!;
    const host = new URL(existing.feed_url).hostname.replace(/^www\./, '');
    const items = adoptableSources(
      [result({
        candidate: candidate({ name: existing.name, domain: host }),
        feeds: [{ feed_url: existing.feed_url, title: existing.name, item_count: 5, content_type: 'application/rss+xml', sample_titles: [] }],
      })],
      config,
    );
    expect(items[0]!.alreadyConfigured).toBe(true);
  });

  it('writes an additive overlay and never touches sources.yaml', () => {
    const dir = profileDir();
    const before = readFileSync(resolve(PROJECT_ROOT, 'config/sources.yaml'), 'utf8');
    const items = adoptableSources([result()], config);
    const outcome = adoptSources(dir, config, items);

    expect(outcome.added).toEqual(['example_writer']);
    expect(readFileSync(resolve(PROJECT_ROOT, 'config/sources.yaml'), 'utf8')).toBe(before);
    const written = parseYaml(readFileSync(resolve(dir, 'sources.added.yaml'), 'utf8')) as { sources: Array<Record<string, unknown>> };
    expect(written.sources[0]!.feed_url).toBe('https://example-writer.test/feed.xml');
    // Resolved values are recorded, so retuning the adoption table later cannot
    // silently re-rate a source the reader already accepted.
    expect(written.sources[0]!.quality_prior).toBe(config.adoption.quality_prior.recommended);
  });

  it('is safe to run twice', () => {
    const dir = profileDir();
    const items = adoptableSources([result()], config);
    adoptSources(dir, config, items);
    const second = adoptSources(dir, config, items);
    expect(second.added).toEqual([]);
    expect(second.skipped[0]!.id).toBe('example_writer');
    const written = parseYaml(readFileSync(resolve(dir, 'sources.added.yaml'), 'utf8')) as { sources: unknown[] };
    expect(written.sources).toHaveLength(1);
  });

  it('writes nothing when the reader ticks nothing', () => {
    const dir = profileDir();
    expect(adoptSources(dir, config, []).added).toEqual([]);
    expect(existsSync(resolve(dir, 'sources.added.yaml'))).toBe(false);
  });

  it('derives an id that satisfies the source schema', () => {
    expect(sourceIdFor('404 Media', '404media.co')).toBe('404media');
    expect(sourceIdFor('Aftermath', 'aftermath.site')).toBe('aftermath');
    expect(sourceIdFor('Odd Name!', '')).toBe('odd_name');
    expect(sourceIdFor('X', 'news.ycombinator.com')).toMatch(/^[a-z0-9_]+$/);
  });

  it('loads adopted sources alongside the configured ones', () => {
    const dir = profileDir();
    // A profile overlay is merged onto the shared list, not substituted for it.
    writeFileSync(resolve(dir, 'sources.added.yaml'), 'version: 1\nsources:\n  - id: adopted_one\n    name: Adopted One\n    feed_url: https://example.com/feed.xml\n');
    const merged = loadConfig({ configDir: dir, reload: true });
    expect(merged.sources.some((source) => source.id === 'adopted_one')).toBe(true);
    expect(merged.sources.length).toBe(config.sources.length + 1);
  });
});
