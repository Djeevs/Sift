import { resolve } from 'node:path';
import type { AppConfig, TasteProfile } from '../config/index.js';
import type { Db } from '../db/index.js';
import {
  atomicWrite,
  readOnboardingState,
  writeOnboardingState,
  writeTasteProfile,
} from './index.js';

export interface FirstWeekMetrics {
  since: string;
  unique_items: number;
  placements: number;
  opens: number;
  excellent: number;
  not_for_me: number;
  explicit_negative_rate: number | null;
  repeated_cluster_share: number;
  top_category: string | null;
  top_category_share: number;
  top_source: string | null;
  top_source_share: number;
  by_feed: Array<{ feed_id: string; count: number }>;
  warnings: string[];
}

export interface FirstWeekResponses {
  too_narrow: boolean;
  too_noisy: boolean;
  too_repetitive: boolean;
  missing_interests: string[];
}

export interface ProfileProposal {
  reasons: string[];
  add_strong_interests: string[];
  add_positive_traits: string[];
  add_negative_traits: string[];
  add_editorial_notes: string[];
  add_interest_anchors: Array<{ id: string; category: string; text: string }>;
}

export function firstWeekMetrics(db: Db, sinceIso: string): FirstWeekMetrics {
  const since = new Date(sinceIso).getTime();
  if (!Number.isFinite(since)) throw new Error(`Invalid onboarding timestamp: ${sinceIso}`);
  const totals = db.get<{
    unique_items: number;
    placements: number;
    opens: number;
    excellent: number;
    not_for_me: number;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT item_id) FROM published_feed_items WHERE published_at >= :since) AS unique_items,
       (SELECT COUNT(*) FROM published_feed_items WHERE published_at >= :since) AS placements,
       (SELECT COUNT(*) FROM open_events WHERE opened_at >= :since) AS opens,
       (SELECT COUNT(*) FROM explicit_feedback WHERE created_at >= :since AND signal = 'excellent') AS excellent,
       (SELECT COUNT(*) FROM explicit_feedback WHERE created_at >= :since AND signal = 'not_for_me') AS not_for_me`,
    { since },
  ) ?? { unique_items: 0, placements: 0, opens: 0, excellent: 0, not_for_me: 0 };

  const byFeed = db.all<{ feed_id: string; count: number }>(
    `SELECT feed_id, COUNT(*) AS count FROM published_feed_items
     WHERE published_at >= :since GROUP BY feed_id ORDER BY count DESC, feed_id`,
    { since },
  );
  const categories = db.all<{ category: string; count: number }>(
    `SELECT COALESCE(de.category, 'unknown') AS category, COUNT(DISTINCT p.item_id) AS count
     FROM published_feed_items p
     LEFT JOIN deep_evaluations de ON de.item_id = p.item_id
     WHERE p.published_at >= :since GROUP BY COALESCE(de.category, 'unknown')
     ORDER BY count DESC, category`,
    { since },
  );
  const sources = db.all<{ source: string; count: number }>(
    `SELECT s.name AS source, COUNT(DISTINCT p.item_id) AS count
     FROM published_feed_items p JOIN feed_items fi ON fi.id = p.item_id
     JOIN sources s ON s.id = fi.source_id
     WHERE p.published_at >= :since GROUP BY s.id, s.name ORDER BY count DESC, source`,
    { since },
  );
  const repeated = db.get<{ repeated: number }>(
    `SELECT COALESCE(SUM(item_count - 1), 0) AS repeated FROM (
       SELECT fi.cluster_id, COUNT(DISTINCT p.item_id) AS item_count
       FROM published_feed_items p JOIN feed_items fi ON fi.id = p.item_id
       WHERE p.published_at >= :since AND fi.cluster_id IS NOT NULL
       GROUP BY fi.cluster_id HAVING COUNT(DISTINCT p.item_id) > 1
     )`,
    { since },
  )?.repeated ?? 0;
  const explicit = totals.excellent + totals.not_for_me;
  const topCategory = categories[0];
  const topSource = sources[0];
  const warnings: string[] = [];
  if (totals.unique_items < 10) warnings.push('Fewer than 10 unique published items; treat conclusions as provisional.');
  if (explicit < 5) warnings.push('Fewer than 5 explicit feedback signals; preference conclusions rely mostly on the questionnaire.');
  if (totals.placements === 0) warnings.push('No editions have been published for this profile yet.');

  return {
    since: sinceIso,
    ...totals,
    explicit_negative_rate: explicit > 0 ? totals.not_for_me / explicit : null,
    repeated_cluster_share: totals.unique_items > 0 ? repeated / totals.unique_items : 0,
    top_category: topCategory?.category ?? null,
    top_category_share: totals.unique_items > 0 ? (topCategory?.count ?? 0) / totals.unique_items : 0,
    top_source: topSource?.source ?? null,
    top_source_share: totals.unique_items > 0 ? (topSource?.count ?? 0) / totals.unique_items : 0,
    by_feed: byFeed,
    warnings,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function proposeFirstWeekChanges(
  metrics: FirstWeekMetrics,
  responses: FirstWeekResponses,
): ProfileProposal {
  const proposal: ProfileProposal = {
    reasons: [],
    add_strong_interests: unique(responses.missing_interests),
    add_positive_traits: [],
    add_negative_traits: [],
    add_editorial_notes: [],
    add_interest_anchors: [],
  };
  if (responses.too_narrow) {
    proposal.reasons.push('The reader reported that editions feel too narrow.');
    proposal.add_positive_traits.push('exceptional discoveries outside established interests');
    proposal.add_editorial_notes.push('Increase breadth and serendipity when execution is exceptional; topic distance alone is not a reason to reject.');
  }
  if (responses.too_noisy) {
    proposal.reasons.push('The reader reported too many low-value recommendations.');
    proposal.add_negative_traits.push('items that are merely relevant but do not justify the reading time');
    proposal.add_editorial_notes.push('Apply a stricter attention-value bar: plausible relevance is insufficient without a concrete payoff.');
  }
  if (responses.too_repetitive) {
    proposal.reasons.push('The reader reported repetitive coverage.');
    proposal.add_negative_traits.push('repetitive coverage that adds no distinct perspective or information');
    proposal.add_editorial_notes.push('Prefer one strong representative per story unless another item adds a meaningfully different perspective.');
  }
  if (proposal.add_strong_interests.length > 0) {
    proposal.reasons.push(`The reader named missing interests: ${proposal.add_strong_interests.join(', ')}.`);
    proposal.add_interest_anchors = proposal.add_strong_interests.map((interest) => ({
      id: `review_${interest.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'interest'}`,
      category: 'other',
      text: `High-quality reporting, analysis, or storytelling about ${interest}, with a concrete payoff.`,
    }));
  }
  if (metrics.explicit_negative_rate !== null && metrics.explicit_negative_rate >= 0.3) {
    proposal.reasons.push(`Observed explicit negative-feedback rate was ${Math.round(metrics.explicit_negative_rate * 100)}%.`);
    if (!responses.too_noisy) {
      proposal.add_editorial_notes.push('Recent explicit feedback suggests selectivity should be reviewed; do not lower the quality bar to fill feeds.');
    }
  }
  if (metrics.top_category_share >= 0.55 && metrics.top_category) {
    proposal.reasons.push(`${metrics.top_category} supplied ${Math.round(metrics.top_category_share * 100)}% of unique recommendations.`);
    proposal.add_editorial_notes.push(`Avoid allowing ${metrics.top_category} to crowd out other worthwhile categories in a weekly portfolio.`);
  }
  if (metrics.top_source_share >= 0.35 && metrics.top_source) {
    proposal.reasons.push(`${metrics.top_source} supplied ${Math.round(metrics.top_source_share * 100)}% of unique recommendations.`);
    proposal.add_editorial_notes.push('Preserve source diversity when multiple items offer similar expected value.');
  }
  return {
    reasons: unique(proposal.reasons),
    add_strong_interests: unique(proposal.add_strong_interests),
    add_positive_traits: unique(proposal.add_positive_traits),
    add_negative_traits: unique(proposal.add_negative_traits),
    add_editorial_notes: unique(proposal.add_editorial_notes),
    add_interest_anchors: [
      ...new Map(proposal.add_interest_anchors.map((anchor) => [anchor.id, anchor])).values(),
    ],
  };
}

export function applyFirstWeekProposal(taste: TasteProfile, proposal: ProfileProposal): TasteProfile {
  const next = structuredClone(taste);
  next.strong_interests = unique([...next.strong_interests, ...proposal.add_strong_interests]);
  next.positive_content_traits = unique([...next.positive_content_traits, ...proposal.add_positive_traits]);
  next.negative_content_traits = unique([...next.negative_content_traits, ...proposal.add_negative_traits]);
  const anchors = new Map(next.interest_anchors.map((anchor) => [anchor.id, anchor]));
  for (const anchor of proposal.add_interest_anchors) {
    if (!anchors.has(anchor.id)) anchors.set(anchor.id, anchor);
  }
  next.interest_anchors = [...anchors.values()];
  if (proposal.add_editorial_notes.length > 0) {
    next.editorial_notes = `${next.editorial_notes.trim()} First-week review: ${proposal.add_editorial_notes.join(' ')}`.trim();
  }
  return next;
}

export interface SaveReviewOptions {
  profileDir: string;
  config: AppConfig;
  metrics: FirstWeekMetrics;
  responses: FirstWeekResponses;
  proposal: ProfileProposal;
  apply: boolean;
  now?: Date;
}

export function saveFirstWeekReview(options: SaveReviewOptions): void {
  const now = options.now ?? new Date();
  if (options.apply) {
    const next = applyFirstWeekProposal(options.config.taste, options.proposal);
    writeTasteProfile(options.profileDir, next);
  }
  atomicWrite(resolve(options.profileDir, 'first-week-review.json'), `${JSON.stringify({
    version: 1,
    reviewed_at: now.toISOString(),
    metrics: options.metrics,
    responses: options.responses,
    proposal: options.proposal,
    applied: options.apply,
  }, null, 2)}\n`);
  const state = readOnboardingState(options.profileDir);
  state.first_week_review = 'completed';
  state.first_week_review_completed_at = now.toISOString();
  writeOnboardingState(options.profileDir, state);
}
