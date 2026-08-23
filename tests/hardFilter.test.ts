import { describe, it, expect } from 'vitest';
import { applyHardFilter, hardFilterPending, type FilterInput } from '../src/filter/hardFilter.js';
import { loadConfig } from '../src/config/index.js';
import { testDb, seedItem } from './helpers.js';
import { classifyArticleLanguage } from '../src/filter/language.js';

const config = loadConfig();
const rps = config.sources.find((s) => s.id === 'rock_paper_shotgun')!;
const quanta = config.sources.find((s) => s.id === 'quanta')!;
const aftermath = config.sources.find((s) => s.id === 'aftermath')!;
const derekThompson = config.sources.find((s) => s.id === 'derek_thompson')!;

function input(overrides: Partial<FilterInput> = {}): FilterInput {
  return {
    id: 'x',
    source_id: 'quanta',
    title: 'How Quantum Error Correction Actually Works',
    canonical_url: 'https://example.com/a',
    original_url: 'https://example.com/a',
    rss_summary: 'A long and detailed summary of a genuinely interesting article about physics and mathematics.',
    rss_content: null,
    feed_categories: [],
    publication_time: Date.now(),
    first_seen_at: Date.now(),
    ...overrides,
  };
}

describe('applyHardFilter', () => {
  it('keeps a normal article', () => {
    expect(applyHardFilter(input(), quanta, config).keep).toBe(true);
  });

  it('drops sponsored content and job posts', () => {
    for (const title of [
      'Sponsored: the future of cloud',
      '[Sponsored] A word from our partner',
      'Hiring: senior engineer',
      "We're hiring a designer",
      'Jobs board: October',
    ]) {
      const verdict = applyHardFilter(input({ title }), quanta, config);
      expect(verdict.keep, `expected "${title}" to be dropped`).toBe(false);
    }
  });

  it('drops by URL pattern', () => {
    const verdict = applyHardFilter(
      input({ canonical_url: 'https://example.com/sponsored/thing', original_url: 'https://example.com/sponsored/thing' }),
      quanta,
      config,
    );
    expect(verdict.keep).toBe(false);
    expect(verdict.reason).toMatch(/url/);
  });

  it('drops blocklisted feed categories', () => {
    expect(applyHardFilter(input({ feed_categories: ['Sponsored'] }), quanta, config).keep).toBe(false);
    expect(applyHardFilter(input({ feed_categories: ['physics'] }), quanta, config).keep).toBe(true);
  });

  it('drops malformed items with neither title nor link', () => {
    expect(applyHardFilter(input({ title: '', canonical_url: null, original_url: null }), quanta, config).keep).toBe(
      false,
    );
  });

  it('excludes thin items when their language cannot be established', () => {
    // The English-only requirement explicitly prefers exclusion when uncertain.
    const verdict = applyHardFilter(input({ rss_summary: 'Short.' }), quanta, config);
    expect(verdict.keep).toBe(false);
    expect(verdict.thin).toBe(true);
    expect(verdict.reason).toMatch(/language uncertain/);
  });

  it('rejects explicit or detected non-English and accepts clear English', () => {
    expect(applyHardFilter(input({ language: 'nl' }), quanta, config).reason).toMatch(/non-English/);
    expect(
      applyHardFilter(
        input({
          language: null,
          title: 'Waarom deze nieuwe machine anders werkt',
          rss_summary: 'De machine is een nieuw ontwerp en het is gemaakt voor de mensen die met het systeem werken.',
        }),
        quanta,
        config,
      ).keep,
    ).toBe(false);
    expect(
      classifyArticleLanguage([
        'This is a careful English explanation of how the new system works and why it matters for the people who use it.',
      ]).verdict,
    ).toBe('english');
  });

  it('accepts an explicitly declared non-English language when the reader enabled it', () => {
    const multilingual = structuredClone(config);
    multilingual.taste.reader_preferences.languages = ['en', 'nl'];
    multilingual.taste.reader_preferences.non_primary_language_policy = 'equal';
    const verdict = applyHardFilter(input({ language: 'nl' }), quanta, multilingual);
    expect(verdict.keep).toBe(true);
  });

  it('rejects non-primary languages when the reader policy is never', () => {
    const primaryOnly = structuredClone(config);
    primaryOnly.taste.reader_preferences.languages = ['en', 'nl'];
    primaryOnly.taste.reader_preferences.non_primary_language_policy = 'never';
    const verdict = applyHardFilter(input({ language: 'nl' }), quanta, primaryOnly);
    expect(verdict.keep).toBe(false);
    expect(verdict.reason).toMatch(/not in the reader's allowed languages/);
  });

  it('rejects configured mixed/paywalled sources and known paywall links', () => {
    expect(applyHardFilter(input({ source_id: 'aftermath' }), aftermath, config).reason).toMatch(/source access/);
    // Mixed sources with both post-level safeguards continue to canonical-page
    // extraction, where paid and ambiguous articles fail closed.
    expect(applyHardFilter(input({ source_id: 'derek_thompson' }), derekThompson, config).keep).toBe(true);
    const linked = applyHardFilter(
      input({
        canonical_url: 'https://www.bloomberg.com/opinion/articles/example',
        original_url: 'https://www.bloomberg.com/opinion/articles/example',
      }),
      quanta,
      config,
    );
    expect(linked.keep).toBe(false);
    expect(linked.reason).toMatch(/known paywall host/);
  });

  it('applies per-source rules', () => {
    const verdict = applyHardFilter(
      input({ source_id: 'rock_paper_shotgun', title: 'Hades 3 release date announced' }),
      rps,
      config,
    );
    expect(verdict.keep).toBe(false);
    expect(verdict.reason).toMatch(/source rule/);
  });

  it('does not apply one source\'s rules to another source', () => {
    const verdict = applyHardFilter(input({ title: 'Hades 3 release date announced' }), quanta, config);
    expect(verdict.keep).toBe(true);
  });

  it('drops items older than the configured limit', () => {
    const old = Date.now() - 400 * 86_400_000;
    expect(applyHardFilter(input({ publication_time: old }), quanta, config).keep).toBe(false);
  });

  it('keeps items with no publication date at all', () => {
    // Feeds that omit pubDate are common; treating them as ancient would
    // silently discard the whole source.
    expect(applyHardFilter(input({ publication_time: null }), quanta, config).keep).toBe(true);
  });

  it('is conservative: nothing is dropped for being uninteresting', () => {
    const verdict = applyHardFilter(input({ title: 'A boring headline about nothing much' }), quanta, config);
    expect(verdict.keep).toBe(true);
  });
});

describe('hardFilterPending', () => {
  it('moves kept items to filtered and dropped items to rejected_hard', () => {
    const { db, config: cfg } = testDb();
    const keepId = seedItem(db, { sourceId: 'quanta', title: 'A Genuinely Interesting Physics Result', status: 'new' });
    const dropId = seedItem(db, { sourceId: 'quanta', title: 'Sponsored: buy this thing', status: 'new' });

    const stats = hardFilterPending(db, cfg);
    expect(stats.kept).toBe(1);
    expect(stats.dropped).toBe(1);

    const kept = db.get<{ status: string }>(`SELECT status FROM feed_items WHERE id = :id`, { id: keepId });
    const dropped = db.get<{ status: string; status_reason: string }>(
      `SELECT status, status_reason FROM feed_items WHERE id = :id`,
      { id: dropId },
    );
    expect(kept?.status).toBe('filtered');
    expect(dropped?.status).toBe('rejected_rules');
    expect(dropped?.status_reason).toMatch(/pattern/);
    db.close();
  });

  it('is idempotent: a second run has nothing to do', () => {
    const { db, config: cfg } = testDb();
    seedItem(db, { sourceId: 'quanta', title: 'Another Real Article About Cosmology', status: 'new' });
    expect(hardFilterPending(db, cfg).examined).toBe(1);
    expect(hardFilterPending(db, cfg).examined).toBe(0);
    db.close();
  });
});
