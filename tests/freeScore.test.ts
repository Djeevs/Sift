import { describe, it, expect } from 'vitest';
import {
  computeFreeScore,
  classifyEditorialType,
  editorialTypeScore,
  freshnessScore,
  isExpired,
  keywordInterestScore,
  semanticInterestScore,
  negativeInterestPenalty,
  clickbaitPenalty,
  isShouting,
  sourceVolumePenalty,
  redundancyPenalty,
  explorationAdjustedQuality,
  bandFor,
  type FreeScoreInput,
} from '../src/rank/freeScore.js';
import { hashUnit } from '../src/rank/runFreeRanker.js';
import { loadConfig, categoryPrior, feedWeight, sourceCategories } from '../src/config/index.js';
import { DAY_MS } from '../src/util/time.js';

const config = loadConfig();
const quanta = config.sources.find((s) => s.id === 'quanta')!;
const rps = config.sources.find((s) => s.id === 'rock_paper_shotgun')!;
const media404 = config.sources.find((s) => s.id === '404media')!;

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

function input(overrides: Partial<FreeScoreInput> = {}): FreeScoreInput {
  return {
    id: 'item-1',
    sourceId: 'quanta',
    title: 'How Quantum Error Correction Actually Works',
    subtitle: null,
    summary: 'A detailed explanation of the mechanism behind error correction in quantum computers.',
    publicationTime: NOW - DAY_MS,
    firstSeenAt: NOW - DAY_MS,
    feedCategories: [],
    anchorSimilarities: [0.35, 0.3, 0.25],
    avoidSimilarity: 0.05,
    bestAnchorId: 'physics_cosmology',
    category: 'ideas_science',
    sourceRankInRun: 1,
    sourceUniqueness: 0.7,
    isRedundantInCluster: false,
    nearestNeighbourSimilarity: 0.2,
    sourceItemsSeen: 100,
    semanticAvailable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('source priors', () => {
  it('reads a rich source model rather than one generic weight', () => {
    expect(quanta.quality_prior).toBe(0.92);
    expect(quanta.volume_budget).toBeGreaterThan(0);
    expect(quanta.exploration_floor).toBeGreaterThan(0);
    expect(Object.keys(quanta.category_priors).length).toBeGreaterThan(1);
    expect(Object.keys(quanta.feed_weights).length).toBeGreaterThan(1);
  });

  it('gives a high-volume news source a smaller volume budget', () => {
    expect(rps.volume_budget).toBeLessThan(quanta.volume_budget);
  });

  it('applies category-specific source priors', () => {
    // A source is not equally good at everything: 404 Media on internet culture
    // is not 404 Media on physics.
    expect(categoryPrior(media404, 'culture')).toBeGreaterThan(categoryPrior(media404, 'ideas_science'));
    expect(categoryPrior(quanta, 'ideas_science')).toBe(1);
    expect(categoryPrior(quanta, 'games')).toBeLessThan(0.5);
  });

  it('falls back to the source default for an unlisted category', () => {
    expect(categoryPrior(quanta, 'wildcard')).toBe(quanta.category_priors['default']);
  });

  it('applies per-feed source weights', () => {
    expect(feedWeight(quanta, 'ideas_science')).toBe(1);
    expect(feedWeight(quanta, 'serendipity')).toBeLessThan(feedWeight(quanta, 'ideas_science'));
    expect(feedWeight(rps, 'essential')).toBeLessThan(feedWeight(quanta, 'essential'));
  });

  it('derives a source\'s categories from its priors, strongest first', () => {
    expect(sourceCategories(quanta)[0]).toBe('ideas_science');
    expect(sourceCategories(quanta)).not.toContain('default');
  });
});

describe('editorial type', () => {
  it('separates an essay from an announcement', () => {
    expect(classifyEditorialType({ title: 'OpenAI announces a new model', subtitle: null, summary: null }, undefined, config)).toBe('announcement');
    expect(classifyEditorialType({ title: 'Notes on attention and memory', subtitle: null, summary: null }, undefined, config)).toBe('essay');
    expect(classifyEditorialType({ title: '10 best productivity tools', subtitle: null, summary: null }, undefined, config)).toBe('listicle');
    expect(classifyEditorialType({ title: 'The history of the shipping container', subtitle: null, summary: null }, undefined, config)).toBe('history');
    expect(classifyEditorialType({ title: 'How does a transformer actually work', subtitle: null, summary: null }, undefined, config)).toBe('explainer');
  });

  it('scores an announcement well below an essay', () => {
    expect(editorialTypeScore('announcement', config)).toBeLessThan(editorialTypeScore('essay', config));
    expect(editorialTypeScore('listicle', config)).toBeLessThan(editorialTypeScore('analysis', config));
  });

  it('honours a per-source content_type override', () => {
    const pinned = { ...quanta, hard_rules: { content_type: 'criticism' } } as typeof quanta;
    expect(classifyEditorialType({ title: 'OpenAI announces a thing', subtitle: null, summary: null }, pinned, config)).toBe('criticism');
  });

  it('treats a link blog as its own type', () => {
    const linkblog = config.sources.find((s) => s.id === 'simon_willison')!;
    expect(linkblog.feed_type).toBe('linkblog');
    expect(classifyEditorialType({ title: 'Some untyped headline here', subtitle: null, summary: null }, linkblog, config)).toBe('linkblog');
  });
});

describe('freshness curves per content type', () => {
  it('decays breaking news fast and history barely at all', () => {
    const threeDays = NOW - 3 * DAY_MS;
    const news = freshnessScore(threeDays, threeDays, 'news', config, NOW).score;
    const history = freshnessScore(threeDays, threeDays, 'history', config, NOW).score;
    const essay = freshnessScore(threeDays, threeDays, 'essay', config, NOW).score;

    expect(news).toBeLessThan(0.3);
    expect(essay).toBeGreaterThan(news);
    expect(history).toBeGreaterThan(0.9);
  });

  it('reaches 0.5 of its range at the half-life', () => {
    const curve = config.free.free_ranking.freshness.curves['analysis']!;
    const at = NOW - curve.half_life_days * DAY_MS;
    const score = freshnessScore(at, at, 'analysis', config, NOW).score;
    // floor + (1 - floor) * 0.5
    expect(score).toBeCloseTo(curve.floor + (1 - curve.floor) * 0.5, 5);
  });

  it('never falls below the configured floor', () => {
    const ancient = NOW - 3650 * DAY_MS;
    for (const type of Object.keys(config.free.free_ranking.freshness.curves)) {
      const curve = config.free.free_ranking.freshness.curves[type]!;
      const score = freshnessScore(ancient, ancient, type, config, NOW).score;
      expect(score, type).toBeGreaterThanOrEqual(curve.floor - 1e-9);
    }
  });

  it('expires time-sensitive types only', () => {
    const old = NOW - 10 * DAY_MS;
    expect(isExpired(old, 'news', config, NOW).expired).toBe(true);
    expect(isExpired(old, 'essay', config, NOW).expired).toBe(false);
    expect(isExpired(old, 'history', config, NOW).expired).toBe(false);
    // No date means no expiry: a feed without pubDate must not be discarded.
    expect(isExpired(null, 'news', config, NOW).expired).toBe(false);
  });
});

describe('interest components', () => {
  it('scores keyword matches, weighting the title higher', () => {
    const inTitle = keywordInterestScore(
      { title: 'Important developments with meaningful consequences', subtitle: null, summary: null },
      config,
    );
    const inBody = keywordInterestScore(
      { title: 'A study of nothing in particular', subtitle: null, summary: 'Important developments with meaningful consequences' },
      config,
    );
    expect(inTitle).toBeGreaterThan(inBody);
    expect(inBody).toBeGreaterThan(0);
  });

  it('saturates rather than rewarding repetition', () => {
    const many = keywordInterestScore(
      { title: 'agents agents agents agents search personalization Nintendo physics', subtitle: null, summary: null },
      config,
    );
    expect(many).toBeLessThanOrEqual(1);
  });

  it('scores nothing for an unrelated headline', () => {
    expect(
      keywordInterestScore({ title: 'Local weather stays mild', subtitle: null, summary: null }, config),
    ).toBe(0);
  });

  it('rescales semantic similarity into a usable range', () => {
    const low = semanticInterestScore([0.05, 0.04, 0.03], config);
    const high = semanticInterestScore([0.6, 0.55, 0.5], config);
    expect(low).toBe(0);
    expect(high).toBeCloseTo(1, 6);
    expect(semanticInterestScore([0.3, 0.3, 0.3], config)).toBeGreaterThan(0);
  });

  it('penalises similarity to avoid anchors', () => {
    expect(negativeInterestPenalty(0.05, config)).toBe(0);
    expect(negativeInterestPenalty(0.6, config)).toBe(1);
  });

  it('detects structural clickbait only', () => {
    expect(clickbaitPenalty('You won’t believe what happened next', config)).toBeGreaterThan(0);
    expect(clickbaitPenalty('Everyone is furious about the new rules', config)).toBeGreaterThan(0);
    expect(clickbaitPenalty('How Quantum Error Correction Actually Works', config)).toBe(0);
    expect(clickbaitPenalty('The GDPR and AI Act compared', config)).toBe(0);
  });

  it('does not treat an all-caps headline as clickbait by default', () => {
    // Caps are often legitimate: acronym-dense titles, emphatic-but-honest
    // headlines, and publishers who set every title in caps. Penalising those
    // would downgrade a whole source rather than an article.
    expect(config.free.free_ranking.clickbait.shouting_enabled).toBe(false);
    expect(clickbaitPenalty('NASA JWST IR SPECTRA RELEASED', config)).toBe(0);
    expect(clickbaitPenalty('THE MAKING OF A CLASSIC ADVENTURE GAME', config)).toBe(0);
  });

  it('can be told to treat shouting as a signal, for one bad source', () => {
    const shouty = {
      ...config,
      free: {
        ...config.free,
        free_ranking: {
          ...config.free.free_ranking,
          clickbait: { ...config.free.free_ranking.clickbait, shouting_enabled: true },
        },
      },
    };
    expect(isShouting('THIS CHANGES ABSOLUTELY EVERYTHING TODAY', shouty)).toBe(true);
    expect(isShouting('A perfectly ordinary headline about things', shouty)).toBe(false);
    // Still needs to be overwhelmingly caps, not merely acronym-heavy.
    expect(isShouting('The NASA JWST IR data explained', shouty)).toBe(false);
  });
});

describe('source volume: diminishing returns, not caps', () => {
  it('decays with each further item from the same source', () => {
    const penalties = [1, 2, 3, 4, 5].map((rank) => sourceVolumePenalty(rank, quanta, config));
    expect(penalties[0]).toBe(0);
    for (let i = 1; i < penalties.length; i += 1) {
      expect(penalties[i]!).toBeGreaterThan(penalties[i - 1]!);
    }
  });

  it('never rejects outright, so an exceptional later item can still win', () => {
    // The tenth item is heavily discounted but not zeroed.
    expect(sourceVolumePenalty(10, quanta, config)).toBeLessThan(1);
  });

  it('compresses the curve for a source with a small volume budget', () => {
    // Same rank, tighter budget: the busy source hits the steep part sooner.
    const generous = sourceVolumePenalty(3, quanta, config);
    const tight = sourceVolumePenalty(3, rps, config);
    expect(tight).toBeGreaterThan(generous);
  });
});

describe('redundancy', () => {
  it('penalises a near-duplicate of something already scored', () => {
    const penalty = redundancyPenalty(
      { isRedundantInCluster: false, nearestNeighbourSimilarity: 0.97, sourceUniqueness: 0.5 },
      config,
    );
    expect(penalty).toBe(1);
  });

  it('penalises a weaker cluster member less when the source is differentiated', () => {
    const commodity = redundancyPenalty(
      { isRedundantInCluster: true, nearestNeighbourSimilarity: 0.5, sourceUniqueness: 0.1 },
      config,
    );
    const differentiated = redundancyPenalty(
      { isRedundantInCluster: true, nearestNeighbourSimilarity: 0.5, sourceUniqueness: 0.95 },
      config,
    );
    // This is what keeps the sceptical critique while dropping the recap.
    expect(differentiated).toBeLessThan(commodity);
  });

  it('does not penalise an item that is nobody else\'s story', () => {
    expect(
      redundancyPenalty(
        { isRedundantInCluster: false, nearestNeighbourSimilarity: 0.3, sourceUniqueness: 0.5 },
        config,
      ),
    ).toBe(0);
  });
});

describe('exploration floor', () => {
  it('lifts a low-prior source that has too little history to judge', () => {
    const unknown = { ...quanta, quality_prior: 0.3, exploration_floor: 0.2 } as typeof quanta;
    const early = explorationAdjustedQuality(unknown, 2, config);
    const settled = explorationAdjustedQuality(unknown, 500, config);
    expect(early.exploring).toBe(true);
    expect(settled.exploring).toBe(false);
    expect(early.quality).toBeGreaterThan(settled.quality);
  });

  it('leaves a well-sampled source alone', () => {
    const result = explorationAdjustedQuality(quanta, 500, config);
    expect(result.quality).toBe(quanta.quality_prior);
  });
});

describe('free score', () => {
  it('stores every component, not just the total', () => {
    const result = computeFreeScore(input(), quanta, config, NOW);
    for (const key of [
      'source_quality_prior',
      'category_prior',
      'keyword_interest_score',
      'semantic_interest_score',
      'freshness_score',
      'editorial_type_score',
      'source_uniqueness_score',
      'source_volume_penalty',
      'redundancy_penalty',
      'clickbait_penalty',
      'negative_interest_penalty',
      'free_score',
    ] as const) {
      expect(result[key], key).toBeTypeOf('number');
    }
    expect(result.band).toMatch(/^[ABCD]$/);
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('stays within 0..1', () => {
    const best = computeFreeScore(
      input({ anchorSimilarities: [0.9, 0.9, 0.9], sourceUniqueness: 1, avoidSimilarity: 0 }),
      quanta,
      config,
      NOW,
    );
    const worst = computeFreeScore(
      input({
        title: 'You won’t believe this shocking thing',
        anchorSimilarities: [0, 0, 0],
        avoidSimilarity: 0.9,
        sourceUniqueness: 0,
        sourceRankInRun: 9,
        isRedundantInCluster: true,
        nearestNeighbourSimilarity: 0.99,
      }),
      rps,
      config,
      NOW,
    );
    expect(best.free_score).toBeLessThanOrEqual(1);
    expect(worst.free_score).toBeGreaterThanOrEqual(0);
    expect(best.free_score).toBeGreaterThan(worst.free_score);
  });

  it('is deterministic: identical inputs give identical output', () => {
    const a = computeFreeScore(input(), quanta, config, NOW);
    const b = computeFreeScore(input(), quanta, config, NOW);
    expect(a).toEqual(b);
  });

  it('ranks a good source\'s essay above a weak source\'s announcement', () => {
    const essay = computeFreeScore(
      input({ title: 'Notes on how error correction actually works' }),
      quanta,
      config,
      NOW,
    );
    const announcement = computeFreeScore(
      input({
        sourceId: 'rock_paper_shotgun',
        title: 'Studio announces release date for its next game',
        category: 'games',
        anchorSimilarities: [0.2, 0.15, 0.1],
      }),
      rps,
      config,
      NOW,
    );
    expect(essay.free_score).toBeGreaterThan(announcement.free_score);
  });

  it('redistributes the semantic weight when embeddings are unavailable', () => {
    // Otherwise a semantic outage would silently drag every score down and empty
    // the feeds, which looks identical to "nothing was good today".
    const withSemantic = computeFreeScore(input(), quanta, config, NOW);
    const without = computeFreeScore(
      input({ semanticAvailable: false, anchorSimilarities: [] }),
      quanta,
      config,
      NOW,
    );
    expect(without.semantic_interest_score).toBe(0);
    expect(without.free_score).toBeGreaterThan(withSemantic.free_score * 0.6);
    expect(without.explanation.join(' ')).toMatch(/semantic scoring unavailable/);
  });

  it('does not let a strong source rescue a clickbait headline', () => {
    const clean = computeFreeScore(input(), quanta, config, NOW);
    const bait = computeFreeScore(
      input({ title: 'You won’t believe this shocking result' }),
      quanta,
      config,
      NOW,
    );
    expect(bait.free_score).toBeLessThan(clean.free_score);
  });
});

describe('bands', () => {
  it('maps scores onto the configured thresholds', () => {
    const b = config.free.free_ranking.bands;
    expect(bandFor(b.a_min + 0.01, config)).toBe('A');
    expect(bandFor(b.b_min + 0.01, config)).toBe('B');
    expect(bandFor(b.c_min + 0.01, config)).toBe('C');
    expect(bandFor(b.c_min - 0.01, config)).toBe('D');
  });

  it('is monotonic: a higher score never lands in a worse band', () => {
    const order = { A: 3, B: 2, C: 1, D: 0 };
    let previous = 0;
    for (let score = 0; score <= 1.0001; score += 0.02) {
      const rank = order[bandFor(score, config)];
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it('has thresholds in a sane order', () => {
    const b = config.free.free_ranking.bands;
    expect(b.a_min).toBeGreaterThan(b.b_min);
    expect(b.b_min).toBeGreaterThan(b.c_min);
  });
});

describe('audit sampling randomness', () => {
  it('is deterministic per item, so a rerun samples the same items', () => {
    expect(hashUnit('free-audit:abc')).toBe(hashUnit('free-audit:abc'));
    expect(hashUnit('free-audit:abc')).not.toBe(hashUnit('free-audit:abd'));
  });

  it('is spread roughly uniformly, so a sample rate means what it says', () => {
    const values = Array.from({ length: 2000 }, (_, i) => hashUnit(`item-${i}`));
    expect(Math.min(...values)).toBeLessThan
      ? expect(Math.min(...values)).toBeLessThan(0.05)
      : undefined;
    expect(Math.max(...values)).toBeGreaterThan(0.95);
    const below6pct = values.filter((v) => v < 0.06).length / values.length;
    expect(below6pct).toBeGreaterThan(0.03);
    expect(below6pct).toBeLessThan(0.10);
  });
});
