import type { AppConfig, FeedConfig } from '../config/index.js';

/**
 * Feed scoring (§14). Pure functions: no database, no model, no clock.
 *
 * The deep model produces dimensions; code combines them. That split is what
 * keeps the editorial policy inspectable and adjustable from YAML.
 */

export interface DeepScores {
  personal_interest: number;
  intellectual_depth: number;
  novelty: number;
  practical_usefulness: number;
  entertainment: number;
  storytelling?: number;
  authorial_voice?: number;
  critique?: number;
  humor?: number;
  obsessive_expertise?: number;
  rabbit_hole?: number;
  delight?: number;
  headline_sufficiency?: number;
  source_quality: number;
  serendipity: number;
  ragebait: number;
  duplicate_information: number;
  expected_attention_value: number;
  /** Embedding distance from the reader's interest anchors (0..1). */
  anchor_distance: number;
}

export interface FeedScore {
  feedId: string;
  score: number;
  threshold: number;
  eligible: boolean;
  reason: string;
}

const DIMENSION_KEYS: Array<keyof DeepScores> = [
  'personal_interest',
  'intellectual_depth',
  'novelty',
  'practical_usefulness',
  'entertainment',
  'storytelling',
  'authorial_voice',
  'critique',
  'humor',
  'obsessive_expertise',
  'rabbit_hole',
  'delight',
  'headline_sufficiency',
  'source_quality',
  'serendipity',
  'ragebait',
  'duplicate_information',
  'expected_attention_value',
];

/** Weighted sum, normalised by the total positive weight so feeds compare. */
export function weightedScore(scores: DeepScores, weights: Record<string, number>): number {
  let total = 0;
  let positiveWeight = 0;
  for (const key of DIMENSION_KEYS) {
    const w = weights[key];
    if (w === undefined) continue;
    total += w * (scores[key] ?? 0);
    if (w > 0) positiveWeight += w;
  }
  if (positiveWeight === 0) return 0;
  // Penalties can push a score below zero; that is intentional and useful.
  return total / positiveWeight;
}

/** quality x novelty x distance-from-known-interests, with a quality floor. */
export function serendipityScore(scores: DeepScores, feed: FeedConfig): number {
  const qw = feed.quality_weights;
  let quality = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(qw)) {
    const value = scores[key as keyof DeepScores];
    if (typeof value !== 'number') continue;
    quality += weight * value;
    weightSum += weight;
  }
  quality = weightSum > 0 ? quality / weightSum : 0;

  const novelty = Math.max(scores.novelty, scores.serendipity);
  const distance = scores.anchor_distance;

  return (
    quality *
    Math.pow(Math.max(0, novelty), feed.novelty_exponent) *
    Math.pow(Math.max(0, distance), feed.distance_exponent)
  );
}

export function computeQuality(scores: DeepScores, feed: FeedConfig): number {
  const qw = feed.quality_weights;
  let quality = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(qw)) {
    const value = scores[key as keyof DeepScores];
    if (typeof value !== 'number') continue;
    quality += weight * value;
    weightSum += weight;
  }
  return weightSum > 0 ? quality / weightSum : 0;
}

/** Check the feed's hard gates. Returns the failure reason, or null if passed. */
export function checkGates(scores: DeepScores, feed: FeedConfig): string | null {
  for (const [gate, limit] of Object.entries(feed.gates)) {
    if (gate === 'min_quality') {
      const quality = computeQuality(scores, feed);
      if (quality < limit) return `quality ${quality.toFixed(2)} < min_quality ${limit}`;
      continue;
    }
    if (gate === 'min_distance') {
      if (scores.anchor_distance < limit) {
        return `anchor_distance ${scores.anchor_distance.toFixed(2)} < min_distance ${limit}`;
      }
      continue;
    }
    const maxMatch = /^max_(.+)$/.exec(gate);
    if (maxMatch) {
      const key = maxMatch[1] as keyof DeepScores;
      const value = scores[key];
      if (typeof value === 'number' && value > limit) {
        return `${key} ${value.toFixed(2)} > max ${limit}`;
      }
      continue;
    }
    const minMatch = /^min_(.+)$/.exec(gate);
    if (minMatch) {
      const key = minMatch[1] as keyof DeepScores;
      const value = scores[key];
      if (typeof value === 'number' && value < limit) {
        return `${key} ${value.toFixed(2)} < min ${limit}`;
      }
    }
  }
  return null;
}

/** Score one item against one feed. */
export function scoreForFeed(
  scores: DeepScores,
  feed: FeedConfig,
  itemCategory: string,
  modelRecommended: string[],
): FeedScore {
  // Category gating: an empty list means the feed accepts anything.
  if (feed.categories.length > 0 && !feed.categories.includes(itemCategory)) {
    // The model may still route across categories when it feels strongly,
    // but only into a feed that named this item explicitly.
    if (!modelRecommended.includes(feed.id)) {
      return {
        feedId: feed.id,
        score: 0,
        threshold: feed.min_score,
        eligible: false,
        reason: `category "${itemCategory}" not accepted by ${feed.id}`,
      };
    }
  }

  const score = feed.mode === 'serendipity' ? serendipityScore(scores, feed) : weightedScore(scores, feed.weights);

  const gateFailure = checkGates(scores, feed);
  if (gateFailure) {
    return { feedId: feed.id, score, threshold: feed.min_score, eligible: false, reason: `gate: ${gateFailure}` };
  }

  if (score < feed.min_score) {
    return {
      feedId: feed.id,
      score,
      threshold: feed.min_score,
      eligible: false,
      reason: `score ${score.toFixed(3)} < min_score ${feed.min_score}`,
    };
  }

  return {
    feedId: feed.id,
    score,
    threshold: feed.min_score,
    eligible: true,
    reason: `score ${score.toFixed(3)} >= ${feed.min_score}`,
  };
}

export function scoreAllFeeds(
  scores: DeepScores,
  config: AppConfig,
  itemCategory: string,
  modelRecommended: string[],
): FeedScore[] {
  return config.feeds.map((feed) => scoreForFeed(scores, feed, itemCategory, modelRecommended));
}
