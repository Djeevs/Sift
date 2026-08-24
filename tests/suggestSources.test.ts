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
  const body = readFileSync(resolve(process.cwd(), 'prompts/source-discovery-v2.md'), 'utf8');

  it('gives each lane its own objective, not one shared one', () => {
    // The whole point of v2: a wire is a strong briefing fit and a weak feeds
    // fit, and the prompt has to say why rather than assume one ranking.
    expect(body).toMatch(/Evaluate every source independently for each lane/);
    expect(body).toMatch(/DO NOT optimize primarily for\s+writing quality/);
    expect(body).toMatch(/could Sift mine this archive for months/);
  });

  it('judges a source against the ones already followed', () => {
    expect(body).toMatch(/incremental value/i);
    expect(body).toMatch(/Penalize sources whose useful output would mostly duplicate/);
  });

  /**
   * The model proposes names and domains; Sift finds the feed. A guessed
   * /feed.xml is noise, and a plausible invention is worse than a short list
   * because Sift will try to fetch it.
   */
  it('forbids inventing feed URLs and publications', () => {
    expect(body).toMatch(/Do NOT guess RSS\/Atom URLs/);
    expect(body).toMatch(/A missing recommendation is much better than a fabricated one/);
  });

  it('treats the quota as a ceiling rather than a target', () => {
    expect(body).toMatch(/Do not fill the quota/);
  });

  it('requires at least one lane per candidate', () => {
    // Enforced in code too: a source qualifying for nothing is not a proposal.
    expect(body).toMatch(/must qualify for at least one lane/);
  });

  it('uses only template variables the renderer supplies', () => {
    const used = [...body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    expect(used).toContain('EXISTING_SOURCES');
    expect(used).toContain('OBSERVED_DOMAINS');
    expect(used).toContain('MAX_CANDIDATES');
  });
});

describe('reading the v2 reply', () => {
  const wrap = (candidates: unknown[]) => JSON.stringify({ candidates });
  const one = (over: Record<string, unknown> = {}) => ({
    name: 'Example', source_type: 'publication', domain: 'example.com',
    homepage_url: 'https://example.com/',
    lanes: { feeds: { fit: 0.8, role: 'selective', reason: 'good articles' }, briefing: null, classics: null },
    content_areas: ['tech'], incremental_value: 'covers a gap', expected_yield: 'weekly',
    caveats: [], disposition: 'recommended', basis: ['reader_profile'], confidence: 0.8, ...over,
  });

  it('keeps only the lanes the model actually assigned', () => {
    const parsed = parseForTest(wrap([one()]));
    expect(parsed[0]!.lanes.map((l) => l.lane)).toEqual(['feeds']);
  });

  // "Every candidate must qualify for at least one lane" — enforced here so it
  // holds whether or not the model followed the instruction.
  it('drops a candidate that qualifies for no lane', () => {
    const parsed = parseForTest(wrap([one({ lanes: { feeds: null, briefing: null, classics: null } })]));
    expect(parsed).toHaveLength(0);
  });

  it('orders lanes by fit, so the best one drives the stored role', () => {
    const parsed = parseForTest(wrap([one({
      lanes: {
        feeds: { fit: 0.4, role: 'discovery_only', reason: 'occasional' },
        briefing: { fit: 0.9, role: 'direct_follow', reason: 'wire copy' },
        classics: null,
      },
    })]));
    expect(parsed[0]!.lanes[0]!.lane).toBe('briefing');
    expect(parsed[0]!.lanes[0]!.role).toBe('direct_follow');
  });

  // One malformed entry must cost one proposal, not the whole reply — the
  // failure that lost six good candidates under v1.
  it('loses only the broken candidate, not the batch', () => {
    const parsed = parseForTest(wrap([one(), { name: 'Broken' }, one({ name: 'Other', domain: 'other.com' })]));
    expect(parsed.map((p) => p.name)).toEqual(['Example', 'Other']);
  });

  it('normalises spacing and case rather than rejecting', () => {
    // The real v1 failure was "observed_fit" where the enum wanted "observed" —
    // near-misses of exactly this shape must survive.
    const parsed = parseForTest(wrap([one({
      disposition: 'Known Favorite',
      lanes: { feeds: { fit: 0.7, role: 'Direct-Follow', reason: 'x' }, briefing: null, classics: null },
    })]));
    expect(parsed[0]!.disposition).toBe('known_favorite');
    expect(parsed[0]!.lanes[0]!.role).toBe('direct_follow');
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
      lanes: { feeds: { fit: 2, role: 'nonsense', reason: 'x' }, briefing: null, classics: null },
    })]));
    expect(parsed[0]!.disposition).toBe('exploratory');
    expect(parsed[0]!.lanes[0]!.role).toBe('selective');
    // fit is a probability; 2 is clamped rather than trusted.
    expect(parsed[0]!.lanes[0]!.fit).toBe(1);
  });

  it('recovers the domain when the model returns a URL instead', () => {
    const parsed = parseForTest(wrap([one({ domain: 'https://www.Example.com/section' })]));
    expect(parsed[0]!.domain).toBe('example.com');
  });
});

describe('merging into the candidate file', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    name: 'Example', domain: 'example.com', disposition: 'exploratory' as const,
    lanes: ['feeds'] as Array<'feeds' | 'briefing' | 'classics'>,
    content_areas: [], caveats: [], reason: 'older guess',
    basis: 'inferred' as const, confidence: 0.5, ...over,
  });

  /**
   * A later run has more evidence — more observed domains, a newer prompt — so
   * a re-proposal must replace the stored verdict. Skipping it left three
   * sources still carrying v1's single-lane guesses after a v2 run.
   */
  it('replaces an earlier proposal for the same source', () => {
    const { merged, refreshed } = mergeCandidates(
      [candidate()],
      [candidate({ lanes: ['feeds', 'briefing'], reason: 'newer verdict', confidence: 0.8 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.lanes).toEqual(['feeds', 'briefing']);
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
