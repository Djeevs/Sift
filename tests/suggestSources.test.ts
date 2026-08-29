import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCandidates, observedDomains, parseCandidatesForTest as parseForTest } from '../src/onboarding/suggestSources.js';
import { seedDeepEvaluation, seedItem, testDb } from './helpers.js';

/**
 * The assistant supplies context; Sift chooses the sources. Where Sift has
 * watched a domain perform for this reader, that evidence outranks any model's
 * prior, so it is gathered and handed to the prompt rather than left in the
 * database unused.
 */
describe('evidence for source suggestions', () => {
  it('reports discovery domains that produced several good articles', () => {
    const { db } = testDb();
    db.run(`UPDATE sources SET feed_type = 'linkblog' WHERE id = 'hacker_news'`);
    for (const [i, score] of [0.8, 0.7, 0.2].entries()) {
      const id = seedItem(db, { sourceId: 'hacker_news', title: `good ${i}`, url: `https://good.example/${i}` });
      seedDeepEvaluation(db, id, { expected_attention_value: score });
    }
    const domains = observedDomains(db);
    expect(domains.map((d) => d.domain)).toContain('good.example');
    expect(domains.find((d) => d.domain === 'good.example')!.items).toBe(3);
  });

  // One good article is luck; the threshold exists so a single outlier cannot
  // recommend a whole publication.
  it('ignores a domain seen only once', () => {
    const { db } = testDb();
    db.run(`UPDATE sources SET feed_type = 'linkblog' WHERE id = 'hacker_news'`);
    const id = seedItem(db, { sourceId: 'hacker_news', title: 'once', url: 'https://once.example/a' });
    seedDeepEvaluation(db, id, { expected_attention_value: 0.9 });
    expect(observedDomains(db).some((d) => d.domain === 'once.example')).toBe(false);
  });

  // An item from a source already configured says nothing about whether to
  // configure it, so it is not evidence for this question.
  it('ignores items from sources already followed', () => {
    const { db } = testDb();
    const configured = db.all<{ id: string }>(`SELECT id FROM sources WHERE feed_type != 'linkblog' LIMIT 1`)[0];
    if (!configured) return;
    for (let i = 0; i < 3; i += 1) {
      const id = seedItem(db, { sourceId: configured.id, title: `already ${i}`, url: `https://already.example/${i}` });
      seedDeepEvaluation(db, id, { expected_attention_value: 0.9 });
    }
    expect(observedDomains(db).some((d) => d.domain === 'already.example')).toBe(false);
  });

  it('degrades to no evidence rather than failing', () => {
    expect(observedDomains(null as never)).toEqual([]);
  });
});

describe('the source-discovery prompt', () => {
  const body = readFileSync(resolve(process.cwd(), 'prompts/feed-source-discovery-v2.md'), 'utf8');

  it('is scoped to the reading feed, not the whole funnel', () => {
    expect(body).toMatch(/maintaining the source portfolio for Sift's reading feed/);
    expect(body).toMatch(/not ranking articles, building a news briefing, or finding archival/);
  });

  it('judges a source against the ones already followed', () => {
    expect(body).toMatch(/incremental[- ]value test/i);
    expect(body).toMatch(/current source ecosystem probably\s+does not/);
  });

  it('keeps a user-provided source comment scoped rather than a blanket boost', () => {
    expect(body).toMatch(/does NOT mean\s+everything from that publication should receive a source-level boost/);
  });

  /**
   * The model proposes names and domains; Sift finds the feed. A guessed
   * /feed.xml is noise, and a plausible invention is worse than a short list
   * because Sift will try to fetch it.
   */
  it('forbids inventing feed URLs and publications', () => {
    expect(body).toMatch(/Do not guess RSS or Atom URLs/);
    expect(body).toMatch(/A short accurate list is better than a longer speculative one/);
  });

  it('treats the quota as a ceiling rather than a target', () => {
    expect(body).toMatch(/is a maximum, not a target/);
  });

  it('uses only template variables the renderer supplies', () => {
    const used = [...body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    expect(used).toContain('READER_PROFILE');
    expect(used).toContain('USER_SOURCES');
    expect(used).toContain('EXISTING_SOURCES');
    expect(used).toContain('OBSERVED_SOURCE_PERFORMANCE');
    expect(used).toContain('COVERAGE_SUMMARY');
    expect(used).toContain('MAX_CANDIDATES');
  });
});

describe('reading the reply', () => {
  const wrap = (candidates: unknown[]) => JSON.stringify({ candidates });
  const one = (over: Record<string, unknown> = {}) => ({
    name: 'Example', source_type: 'publication', domain: 'example.com',
    homepage_url: 'https://example.com/',
    role: 'selective', disposition: 'recommended',
    content_areas: ['tech'], incremental_value: 'covers a gap', expected_yield: 'medium',
    caveats: [], basis: ['reader_profile'], reason: 'good articles', confidence: 0.8, ...over,
  });

  it('reads name, role, and disposition directly off the candidate', () => {
    const parsed = parseForTest(wrap([one()]));
    expect(parsed[0]!.role).toBe('selective');
    expect(parsed[0]!.disposition).toBe('recommended');
    expect(parsed[0]!.sourceType).toBe('publication');
  });

  // One malformed entry must cost one proposal, not the whole reply.
  it('loses only the broken candidate, not the batch', () => {
    const parsed = parseForTest(wrap([one(), { name: 'Broken' }, one({ name: 'Other', domain: 'other.com' })]));
    expect(parsed.map((p) => p.name)).toEqual(['Example', 'Other']);
  });

  it('normalises spacing and case rather than rejecting', () => {
    const parsed = parseForTest(wrap([one({
      disposition: 'Known Favorite',
      role: 'Direct-Follow',
    })]));
    expect(parsed[0]!.disposition).toBe('known_favorite');
    expect(parsed[0]!.role).toBe('direct_follow');
  });

  /**
   * A value it cannot recognise falls back to the cautious option rather than
   * the flattering one: `exploratory` earns a lower prior than `recommended`,
   * and `selective` filters harder than `direct_follow`. Guessing upward would
   * hand an unvetted source more of the reader's attention on a typo.
   */
  it('falls back to the cautious option for anything unrecognisable', () => {
    const parsed = parseForTest(wrap([one({
      disposition: 'wildly enthusiastic',
      role: 'nonsense',
    })]));
    expect(parsed[0]!.disposition).toBe('exploratory');
    expect(parsed[0]!.role).toBe('selective');
  });

  it('recovers the domain when the model returns a URL instead', () => {
    const parsed = parseForTest(wrap([one({ domain: 'https://www.Example.com/section' })]));
    expect(parsed[0]!.domain).toBe('example.com');
  });
});

describe('merging into the candidate file', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    name: 'Example', domain: 'example.com', disposition: 'exploratory' as const,
    role: 'selective' as const,
    content_areas: [], caveats: [], reason: 'older guess',
    basis: 'inferred' as const, confidence: 0.5, ...over,
  });

  /**
   * A later run has more evidence — more observed domains, more coverage
   * history — so a re-proposal must replace the stored verdict rather than
   * being skipped.
   */
  it('replaces an earlier proposal for the same source', () => {
    const { merged, refreshed } = mergeCandidates(
      [candidate()],
      [candidate({ reason: 'newer verdict', confidence: 0.8 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.reason).toBe('newer verdict');
    expect(refreshed).toBe(1);
  });

  it('keeps sources that were not re-proposed', () => {
    const { merged, refreshed } = mergeCandidates(
      [candidate({ name: 'Kept', domain: 'kept.com' })],
      [candidate({ name: 'New', domain: 'new.com' })],
    );
    expect(merged.map((c) => c.name).sort()).toEqual(['Kept', 'New']);
    expect(refreshed).toBe(0);
  });

  it('matches on name and domain together, not either alone', () => {
    const { merged } = mergeCandidates(
      [candidate({ name: 'Example', domain: 'example.com' })],
      [candidate({ name: 'Example', domain: 'example.org' })],
    );
    expect(merged).toHaveLength(2);
  });
});
