import { describe, it, expect } from 'vitest';
import { weightedScore, serendipityScore, checkGates, scoreForFeed, type DeepScores } from '../src/route/score.js';
import { scoreTriage } from '../src/ai/cheapTriage.js';
import type { CheapResult, GateContext } from '../src/ai/cheapTriage.js';
import { loadConfig } from '../src/config/index.js';
import type { FeedConfig } from '../src/config/schema.js';

const config = loadConfig();

function scores(overrides: Partial<DeepScores> = {}): DeepScores {
  return {
    personal_interest: 0.5,
    intellectual_depth: 0.5,
    novelty: 0.5,
    practical_usefulness: 0.5,
    entertainment: 0.5,
    storytelling: 0.5,
    authorial_voice: 0.5,
    critique: 0.5,
    humor: 0.5,
    obsessive_expertise: 0.5,
    rabbit_hole: 0.5,
    delight: 0.5,
    headline_sufficiency: 0,
    source_quality: 0.5,
    serendipity: 0.2,
    ragebait: 0.0,
    duplicate_information: 0.0,
    expected_attention_value: 0.5,
    anchor_distance: 0.4,
    ...overrides,
  };
}

const essential = config.feeds.find((f) => f.id === 'essential')!;
const serendipityFeed = config.feeds.find((f) => f.id === 'serendipity')!;

describe('weightedScore', () => {
  it('is normalised so a perfect item scores 1', () => {
    const perfect = scores({
      personal_interest: 1,
      intellectual_depth: 1,
      novelty: 1,
      practical_usefulness: 1,
      entertainment: 1,
      storytelling: 1,
      authorial_voice: 1,
      critique: 1,
      humor: 1,
      obsessive_expertise: 1,
      rabbit_hole: 1,
      delight: 1,
      headline_sufficiency: 0,
      source_quality: 1,
      expected_attention_value: 1,
    });
    expect(weightedScore(perfect, essential.weights)).toBeCloseTo(1, 5);
  });

  it('penalises ragebait heavily', () => {
    const clean = weightedScore(scores({ personal_interest: 0.9, expected_attention_value: 0.9 }), essential.weights);
    const rage = weightedScore(
      scores({ personal_interest: 0.9, expected_attention_value: 0.9, ragebait: 0.9 }),
      essential.weights,
    );
    expect(rage).toBeLessThan(clean);
    // The penalty must be large enough to sink an otherwise strong item.
    expect(clean - rage).toBeGreaterThan(0.25);
  });

  it('penalises duplicate information', () => {
    const fresh = weightedScore(scores(), essential.weights);
    const dupe = weightedScore(scores({ duplicate_information: 1 }), essential.weights);
    expect(dupe).toBeLessThan(fresh);
  });

  it('ignores dimensions the feed does not weight', () => {
    const a = weightedScore(scores({ serendipity: 0 }), essential.weights);
    const b = weightedScore(scores({ serendipity: 1 }), essential.weights);
    expect(a).toBe(b);
  });
});

describe('serendipityScore', () => {
  it('rewards quality x novelty x distance', () => {
    const near = serendipityScore(scores({ novelty: 0.9, anchor_distance: 0.1 }), serendipityFeed);
    const far = serendipityScore(scores({ novelty: 0.9, anchor_distance: 0.9 }), serendipityFeed);
    expect(far).toBeGreaterThan(near);
  });

  it('will not reward distance alone', () => {
    const lowQuality = serendipityScore(
      scores({ intellectual_depth: 0.1, entertainment: 0.1, storytelling: 0.1, authorial_voice: 0.1, obsessive_expertise: 0.1, rabbit_hole: 0.1, delight: 0.1, source_quality: 0.1, expected_attention_value: 0.1, anchor_distance: 1, novelty: 1 }),
      serendipityFeed,
    );
    const highQuality = serendipityScore(
      scores({ intellectual_depth: 0.9, entertainment: 0.9, storytelling: 0.9, authorial_voice: 0.9, obsessive_expertise: 0.9, rabbit_hole: 0.9, delight: 0.9, source_quality: 0.9, expected_attention_value: 0.9, anchor_distance: 1, novelty: 1 }),
      serendipityFeed,
    );
    expect(lowQuality).toBeLessThan(0.2);
    expect(highQuality).toBeGreaterThan(0.8);
  });

  it('is zero when the item is squarely inside known interests', () => {
    expect(serendipityScore(scores({ anchor_distance: 0 }), serendipityFeed)).toBe(0);
  });
});

describe('checkGates', () => {
  it('blocks ragebait above the feed limit', () => {
    expect(checkGates(scores({ ragebait: 0.9 }), essential)).toMatch(/ragebait/);
    expect(checkGates(scores({ ragebait: 0.1, intellectual_depth: 0.8, expected_attention_value: 0.8 }), essential)).toBeNull();
  });

  it('enforces minimum gates', () => {
    expect(checkGates(scores({ expected_attention_value: 0.2 }), essential)).toMatch(/expected_attention_value/);
  });

  it('enforces the serendipity quality floor', () => {
    const shallow = scores({
      intellectual_depth: 0.1,
      entertainment: 0.1,
      source_quality: 0.1,
      expected_attention_value: 0.1,
      novelty: 0.9,
      anchor_distance: 0.9,
    });
    expect(checkGates(shallow, serendipityFeed)).toMatch(/quality/);
  });

  it('enforces the serendipity distance floor', () => {
    const nearby = scores({
      intellectual_depth: 0.9,
      entertainment: 0.9,
      source_quality: 0.9,
      expected_attention_value: 0.9,
      novelty: 0.9,
      anchor_distance: 0.05,
    });
    expect(checkGates(nearby, serendipityFeed)).toMatch(/distance/);
  });
});

describe('scoreForFeed', () => {
  const aiFeed = config.feeds.find((f) => f.id === 'ai_product')!;

  it('rejects items from a category the feed does not accept', () => {
    const result = scoreForFeed(scores({ personal_interest: 1 }), aiFeed, 'games', []);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/category/);
  });

  it('allows a cross-category item the model explicitly recommended', () => {
    const strong = scores({
      personal_interest: 0.9,
      intellectual_depth: 0.9,
      novelty: 0.9,
      practical_usefulness: 0.9,
      entertainment: 0.9,
      source_quality: 0.9,
      expected_attention_value: 0.9,
    });
    const result = scoreForFeed(strong, aiFeed, 'games', ['ai_product']);
    expect(result.eligible).toBe(true);
  });

  it('accepts any category into a feed with no category restriction', () => {
    expect(essential.categories).toEqual([]);
    const strong = scores({
      personal_interest: 0.95,
      intellectual_depth: 0.95,
      novelty: 0.9,
      practical_usefulness: 0.8,
      entertainment: 0.8,
      source_quality: 0.9,
      expected_attention_value: 0.95,
    });
    expect(scoreForFeed(strong, essential, 'society', []).eligible).toBe(true);
  });

  it('is deterministic', () => {
    const s = scores({ personal_interest: 0.77 });
    const a = scoreForFeed(s, essential, 'ai_product', []);
    const b = scoreForFeed(s, essential, 'ai_product', []);
    expect(a).toEqual(b);
  });
});

describe('Luna gate: recall-first behaviour', () => {
  /**
   * The gate now combines Luna's output with the free score, the band and the
   * source prior, so tests supply a GateContext rather than loose arguments.
   */
  function context(overrides: Partial<GateContext> = {}): GateContext {
    return { freeScore: 0.5, band: 'B', qualityPrior: 0.55, exploration: false, ...overrides };
  }

  function cheap(overrides: Partial<CheapResult> = {}): CheapResult {
    return {
      action: 'KEEP',
      categories: ['ai_product'],
      interest_match: 0.5,
      novelty_likelihood: 0.5,
      junk_probability: 0.1,
      needs_full_article: false,
      serendipity_candidate: false,
      gist: 'something',
      ...overrides,
    };
  }

  it('passes a clearly interesting item', () => {
    const d = scoreTriage(
      cheap({ interest_match: 0.9, novelty_likelihood: 0.8 }),
      context({ freeScore: 0.7, band: 'A', qualityPrior: 0.8 }),
      config,
    );
    expect(d.passed).toBe(true);
  });

  it('drops obvious junk', () => {
    const d = scoreTriage(
      cheap({ action: 'DROP', interest_match: 0.05, novelty_likelihood: 0.05, junk_probability: 0.95 }),
      context({ freeScore: 0.1, band: 'D', qualityPrior: 0.3 }),
      config,
    );
    expect(d.passed).toBe(false);
  });

  it('gives UNCERTAIN items a lower bar than DROP', () => {
    const base = cheap({ interest_match: 0.45, novelty_likelihood: 0.45 });
    const uncertain = scoreTriage({ ...base, action: 'UNCERTAIN' }, context(), config);
    const keep = scoreTriage({ ...base, action: 'KEEP' }, context(), config);
    expect(uncertain.threshold).toBeLessThan(keep.threshold);
  });

  it('gives trusted sources the benefit of the doubt', () => {
    const item = cheap({ interest_match: 0.4, novelty_likelihood: 0.4 });
    const trusted = scoreTriage(item, context({ qualityPrior: 0.9 }), config);
    const untrusted = scoreTriage(item, context({ qualityPrior: 0.4 }), config);
    expect(trusted.threshold).toBeLessThan(untrusted.threshold);
    expect(trusted.score).toBeGreaterThan(untrusted.score);
  });

  it('always lets serendipity candidates through, whatever the score', () => {
    const d = scoreTriage(
      cheap({ interest_match: 0.05, novelty_likelihood: 0.2, serendipity_candidate: true, junk_probability: 0.1 }),
      context({ freeScore: 0.1, band: 'D', qualityPrior: 0.3 }),
      config,
    );
    expect(d.passed).toBe(true);
    expect(d.reason).toMatch(/serendipity/);
  });

  it('does not let serendipity rescue junk', () => {
    const d = scoreTriage(
      cheap({ action: 'DROP', interest_match: 0.05, serendipity_candidate: true, junk_probability: 0.95 }),
      context({ freeScore: 0.1, band: 'D', qualityPrior: 0.3 }),
      config,
    );
    expect(d.passed).toBe(false);
  });

  it('forces an audit sample through regardless of score', () => {
    const junk = cheap({ action: 'DROP', interest_match: 0.01, junk_probability: 0.9 });
    const normal = scoreTriage(junk, context({ freeScore: 0.1, band: 'D' }), config);
    const audited = scoreTriage(junk, context({ freeScore: 0.1, band: 'D', isAuditSample: true }), config);
    expect(normal.passed).toBe(false);
    expect(audited.passed).toBe(true);
    expect(audited.reason).toMatch(/audit/);
  });

  it('never rejects an item merely because a run budget was spent', () => {
    /**
     * Regression. The gate used to flip `passed` to false once the per-run Terra
     * budget was exhausted, writing the item as `rejected_luna` -- permanently,
     * because Luna only reads `free_ranked` and Terra only reads `triaged`. One
     * backlog run stranded 60 already-qualified items, serendipity candidates
     * among them. The cap now lives solely in the pipeline's LIMIT, so overflow
     * items stay `triaged` and are picked up by the next run.
     */
    const strong = cheap({ interest_match: 0.9, novelty_likelihood: 0.85 });
    const ctx = context({ freeScore: 0.7, band: 'A', qualityPrior: 0.85 });
    // Whatever the call order, the same input yields the same verdict: the gate
    // holds no per-run counter at all.
    const decisions = Array.from({ length: 200 }, () => scoreTriage(strong, ctx, config));
    expect(decisions.every((d) => d.passed)).toBe(true);
    expect(decisions.every((d) => !/budget/i.test(d.reason))).toBe(true);
  });

  it('discounts the threshold when the article body is needed to judge', () => {
    const item = cheap({ interest_match: 0.5 });
    const needs = scoreTriage({ ...item, needs_full_article: true }, context(), config);
    const doesNot = scoreTriage({ ...item, needs_full_article: false }, context(), config);
    expect(needs.threshold).toBeLessThan(doesNot.threshold);
  });
});
