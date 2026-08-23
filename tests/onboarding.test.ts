import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, PROJECT_ROOT } from '../src/config/index.js';
import {
  compileTasteProfile,
  createProfile,
  parseDossier,
  renderProfilePreview,
  readOnboardingState,
  readTasteProfile,
  type OnboardingDossier,
} from '../src/onboarding/index.js';
import { defaultReaderPreferences, suggestedReaderPreferences } from '../src/onboarding/preferences.js';
import {
  applyRankedCalibration,
  rankedCalibrationItems,
  type RankedCalibrationAnswers,
} from '../src/onboarding/calibration.js';
import {
  applyFirstWeekProposal,
  firstWeekMetrics,
  proposeFirstWeekChanges,
} from '../src/onboarding/review.js';
import { seedDeepEvaluation, seedItem, testDb } from './helpers.js';

const dossier: OnboardingDossier = {
  version: 3,
  reading_goal: 'Find a small number of things that consistently justify attention.',
  executive_taste_summary: 'An inquisitive general reader who values explanation more than comprehensive news coverage.',
  attention_selection_model: 'Execution can override topic fit, but routine relevance is not enough.',
  values_and_outlook: [{ description: 'Values evidence and intellectual honesty.', basis: 'observed', confidence: 0.8 }],
  current_context: [{ description: 'Learning about resilient institutions.', relevance_to_reading: 'Makes institutional case studies timely.', basis: 'explicit', confidence: 0.9 }],
  interests: [{
    id: 'science_discoveries',
    label: 'science discoveries',
    tier: 'core',
    priority: 8,
    preferred_coverage: ['Accessible discoveries that change understanding rather than incremental paper summaries.'],
    conditions: [],
    medium_fit: 'cross_medium',
    basis: 'explicit',
    confidence: 0.9,
  }],
  valuable_intersections: [{ description: 'science and institutional incentives', why_it_matters: 'Mechanisms connect abstract findings to real systems.', basis: 'observed', confidence: 0.7 }],
  rewarding_qualities: [{ quality: 'clear mechanisms', why: 'They make the causal insight reusable.', strength: 'strong', basis: 'observed', confidence: 0.8 }],
  unrewarding_qualities: [{ quality: 'thin aggregation', why: 'It adds little beyond the headline.', strength: 'strong', basis: 'observed', confidence: 0.8 }],
  content_mix: { breaking_news: 0.2, reporting: 0.7, analysis: 0.9, narrative: 0.7, criticism: 0.5, practical: 0.4, entertainment: 0.5, serendipity: 0.6 },
  timeliness_profile: { news_vs_interpretation: 'Prefer explanation after the event unless immediacy changes action.', loses_value_quickly: ['routine announcements'], remains_valuable: ['conceptual explanations'], archival_appetite: 'high', age_guidance: 'Old work is welcome when still illuminating.', basis: 'observed', confidence: 0.7 },
  depth_length_profile: { summary: 'Depth matters more than length.', longform_payoff_threshold: 'Long pieces need a durable conceptual or narrative payoff.', technical_complexity: 'Welcome when clearly explained.', basis: 'observed', confidence: 0.8 },
  medium_profile: [{ subject_or_style: 'craft analysis', fit: 'stronger_elsewhere', preferred_medium: 'video', transferable_qualities: ['clear demonstration'], basis: 'explicit', confidence: 0.8 }],
  entertainment_profile: { role_in_ranking: 'Enjoyment can justify reading without professional utility.', rewarding_forms: ['dry humor'], basis: 'observed', confidence: 0.7 },
  exploration_profile: { frequency: 'occasional', execution_override_strength: 7, unfamiliar_topic_quality_bar: 'Require exceptional storytelling or explanation.', override_conditions: ['unusual expertise'], basis: 'observed', confidence: 0.8 },
  professional_personal_boundary: { enjoyed_overlap: ['institutional incentives'], useful_but_not_personal: ['routine industry news'], guidance: 'Do not rank merely obligatory professional coverage.', basis: 'observed', confidence: 0.7 },
  style_references: [{ name: 'Example Review', relationship: 'style_reference', qualities: 'Clear mechanisms and dry humor.', confidence: 0.7 }],
  examples: [{ kind: 'explicit_positive', title_or_description: 'A careful investigation of a failed institution', reason: 'It explained incentives through a story.', confidence: 0.8 }],
  assistant_preference_hints: {
    attention_budget: { value: '15_30', confidence: 0.8 },
    article_length: { value: 'long_when_exceptional', confidence: 0.8 },
    paywall_policy: { value: 'free_only', confidence: 0.9 },
    languages: { value: ['English'], confidence: 0.9 },
    freshness_balance: { value: 'balanced', confidence: 0.7 },
    max_evergreen_age_days: null,
    serendipity: { value: 7, confidence: 0.8 },
    writing_voices: { value: ['explanatory', 'dryly funny'], confidence: 0.7 },
    disliked_styles: { value: ['breathless hype'], confidence: 0.8 },
    medium_preferences: [{ subject: 'craft analysis', preferred_medium: 'video', strength: 'prefer', confidence: 0.8 }],
  },
  interest_anchors: [{ id: 'science', category: 'ideas_science', description: 'Major accessible science discoveries with a conceptual payoff.' }],
  avoid_anchors: [{ id: 'thin', description: 'Thin aggregation and announcements replaceable by the headline.' }],
  source_candidates: [{ name: 'Example Review', domain: 'example.com', disposition: 'known_favorite', role: 'direct_follow', content_areas: ['explanatory reporting'], caveats: [], reason: 'A repeatedly enjoyed explanatory publication.', basis: 'explicit', confidence: 0.9 }],
  ranking_guidance: {
    strong_positive_signals: ['clear causal explanation'],
    moderate_positive_signals: ['distinctive voice'],
    weak_positive_signals: [],
    strong_negative_signals: ['thin aggregation'],
    hard_filters: [],
    override_rules: ['Exceptional execution can override weak topic fit.'],
    interaction_effects: ['institutional incentives plus narrative investigation'],
    source_level_guidance: ['A favorite source is a prior, not a guarantee.'],
    duplication_and_saturation: ['Prefer the best treatment of a repeated story.'],
  },
  contradictions: [{ tension: 'Values depth but not unnecessary length.', conditions: 'Length works when it produces durable payoff.', confidence: 0.8 }],
  uncertainties: ['Tolerance for very long articles'],
  privacy_redactions: ['Exact employer omitted'],
};

describe('reader onboarding', () => {
  it('parses a fenced dossier and compiles only ranking fields', () => {
    const parsed = parseDossier(`\`\`\`json\n${JSON.stringify(dossier)}\n\`\`\``);
    const taste = compileTasteProfile(parsed);
    expect(taste.strong_interests).toEqual(['science discoveries']);
    expect(taste.topic_priorities[0]).not.toHaveProperty('confidence');
    expect(taste.editorial_notes).toContain('analysis 90%');
    expect(taste.editorial_notes).toContain('best treatment of a repeated story');
    expect(taste.editorial_notes).toContain('Tolerance for very long articles');
    expect(taste.positive_examples[0]?.description).toContain('failed institution');
    expect(taste.reader_preferences.serendipity).toBe(7);
    expect(taste.source_preferences[0]?.disposition).toBe('known_favorite');
  });

  it('keeps the JSON example in the user-facing prompt aligned with the parser', () => {
    const prompt = readFileSync(resolve(PROJECT_ROOT, 'onboarding/chatgpt-profile-prompt.md'), 'utf8');
    const example = /\n(\{\n  "version": 3[\s\S]*?\n\})\n\nAllowed values:/.exec(prompt)?.[1];
    expect(example).toBeTruthy();
    expect(parseDossier(example!).version).toBe(3);
  });

  it('rejects obsolete dossier contracts instead of assigning ambiguous meanings', () => {
    expect(() => parseDossier(JSON.stringify({ version: 2 }))).toThrow(/version/);
  });

  it('shows assistant proposals in a preview but requires explicit approval before writing', () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'sift-approval-'));
    const preferences = suggestedReaderPreferences(dossier.assistant_preference_hints);
    const preview = renderProfilePreview(dossier, preferences);
    expect(preview).toContain('NO FILES HAVE BEEN CREATED');
    expect(preview).toContain('Example Review');
    expect(() => createProfile({ projectRoot, profileId: 'unapproved', dossier, preferences, approved: false })).toThrow(/explicit approval/i);
  });

  it('creates isolated profiles with distinct tokens and blank publisher bindings', () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'sift-onboard-'));
    const first = createProfile({ projectRoot, profileId: 'alice', dossier, approved: true, skipCalibration: true, accessToken: 'alice-token' });
    const second = createProfile({ projectRoot, profileId: 'bob', dossier, approved: true, skipCalibration: false, accessToken: 'bob-token' });
    expect(first.databasePath).not.toBe(second.databasePath);
    expect(readOnboardingState(first.directory).calibration).toBe('skipped');
    expect(readOnboardingState(second.directory).calibration).toBe('pending');
    const env = readFileSync(resolve(first.directory, '.env'), 'utf8');
    expect(env).toContain('SIFT_ACCESS_TOKEN=alice-token');
    expect(env).toContain('SIFT_KV_NAMESPACE_ID=\n');
    expect(env).not.toContain('bob-token');
    expect(readFileSync(resolve(first.directory, 'reader-preferences.json'), 'utf8')).toContain('attention_budget');
    expect(readFileSync(resolve(first.directory, 'source-candidates.json'), 'utf8')).toContain('Example Review');
  });

  it('calibrates only against real ranked articles and records concrete feedback', () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'sift-calibrate-'));
    const created = createProfile({ projectRoot, profileId: 'reader', dossier, approved: true, accessToken: 'token' });
    const { db, config } = testDb();
    const first = seedItem(db, { sourceId: config.sources[0]!.id, title: 'A real ranked investigation' });
    const second = seedItem(db, { sourceId: config.sources[0]!.id, title: 'A real but disappointing recap' });
    for (const [index, item] of [first, second].entries()) {
      db.run(`INSERT INTO published_feed_items (feed_id, item_id, score, rank_position, why_it_surfaced, published_at, day_key)
              VALUES ('essential', :item, :score, :rank, 'Ranked from the real pipeline.', :now, '2026-08-22')`,
      { item, score: 0.9 - index * 0.1, rank: index + 1, now: Date.now() + index });
    }
    const ranked = rankedCalibrationItems(db.raw);
    const answers: RankedCalibrationAnswers = {
      version: 2,
      answers: ranked.map((item) => ({
        item_id: item.item_id,
        label: item.title.includes('investigation') ? 'glad' : 'not_for_me',
      })),
    };
    applyRankedCalibration(created.directory, db.raw, answers, new Date('2026-08-22T10:00:00Z'));
    const taste = readTasteProfile(created.directory);
    expect(taste.positive_examples.some((example) => example.description.includes('real ranked'))).toBe(true);
    expect(taste.negative_examples.some((example) => example.description.includes('disappointing'))).toBe(true);
    expect(db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM explicit_feedback WHERE matched_by = 'calibration'`)?.count).toBe(2);
    expect(readOnboardingState(created.directory).calibration).toBe('completed');
    db.close();
  });

  it('loads a generated profile as an overlay on neutral mechanics', () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'sift-overlay-'));
    const created = createProfile({ projectRoot, profileId: 'overlay', dossier, approved: true, accessToken: 'token' });
    const config = loadConfig({ configDir: created.directory, reload: true });
    expect(config.taste.strong_interests).toEqual(['science discoveries']);
    expect(config.sources.length).toBeGreaterThan(5);
    expect(config.feeds.length).toBeGreaterThan(1);
    expect(config.final.final_ranking.exploration.fraction).toBeCloseTo(0.28);
  });

  it('applies only a small bounded prior when a suggested source matches a validated source', () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'sift-source-prior-'));
    const withQuanta: OnboardingDossier = {
      ...dossier,
      source_candidates: [{
        name: 'Quanta Magazine',
        domain: 'quantamagazine.org',
        disposition: 'known_favorite',
        role: 'direct_follow',
        content_areas: ['conceptual science'],
        caveats: [],
        reason: 'Repeatedly enjoyed for conceptual science explanations.',
        basis: 'explicit',
        confidence: 1,
      }],
    };
    const created = createProfile({ projectRoot, profileId: 'source-prior', dossier: withQuanta, approved: true, accessToken: 'token' });
    const base = loadConfig({ configDir: resolve(PROJECT_ROOT, 'config'), reload: true });
    const personalized = loadConfig({ configDir: created.directory, reload: true });
    const basePrior = base.sources.find((source) => source.id === 'quanta')!.quality_prior;
    const personalizedPrior = personalized.sources.find((source) => source.id === 'quanta')!.quality_prior;
    expect(personalizedPrior).toBe(0.95);
    expect(personalizedPrior).toBeGreaterThan(basePrior);
    expect(personalizedPrior - basePrior).toBeLessThanOrEqual(0.08);
  });

  it('does not turn discovery-only sources into ranking priors', () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), 'sift-discovery-prior-'));
    const discoveryOnly: OnboardingDossier = {
      ...dossier,
      source_candidates: [{
        name: 'Quanta Magazine',
        domain: 'quantamagazine.org',
        disposition: 'recommended',
        role: 'discovery_only',
        content_areas: ['conceptual science'],
        caveats: ['Treat as candidate generation rather than a blanket endorsement.'],
        reason: 'Useful for discovering occasional conceptual science pieces.',
        basis: 'inferred',
        confidence: 1,
      }],
    };
    const created = createProfile({ projectRoot, profileId: 'discovery-only', dossier: discoveryOnly, approved: true, accessToken: 'token' });
    const base = loadConfig({ configDir: resolve(PROJECT_ROOT, 'config'), reload: true });
    const personalized = loadConfig({ configDir: created.directory, reload: true });
    expect(personalized.sources.find((source) => source.id === 'quanta')!.quality_prior)
      .toBe(base.sources.find((source) => source.id === 'quanta')!.quality_prior);
  });

  it('uses safe system defaults when the preference wizard is skipped', () => {
    const preferences = defaultReaderPreferences();
    expect(preferences.languages).toEqual(['en']);
    expect(preferences.non_primary_language_policy).toBe('never');
    expect(preferences.paywall_policy).toBe('free_only');
    expect(preferences.serendipity).toBe(5);
  });
});

describe('first-week review', () => {
  it('combines observed metrics with reader answers and applies only the approved proposal', () => {
    const { db, config } = testDb();
    const now = Date.now();
    const first = seedItem(db, { sourceId: config.sources[0]!.id, title: 'One', clusterId: 'story-a' });
    const second = seedItem(db, { sourceId: config.sources[0]!.id, title: 'Two', clusterId: 'story-a' });
    seedDeepEvaluation(db, first, { category: 'ideas_science' });
    seedDeepEvaluation(db, second, { category: 'ideas_science' });
    for (const item of [first, second]) {
      db.run(`INSERT INTO published_feed_items (feed_id, item_id, score, rank_position, published_at, day_key)
              VALUES ('essential', :item, 0.9, 1, :now, '2026-08-22')`, { item, now });
    }
    db.run(`INSERT INTO explicit_feedback (id, item_id, signal, origin, created_at)
            VALUES ('negative', :item, 'not_for_me', 'manual', :now)`, { item: first, now });

    const metrics = firstWeekMetrics(db, new Date(now - 1000).toISOString());
    expect(metrics.unique_items).toBe(2);
    expect(metrics.explicit_negative_rate).toBe(1);
    expect(metrics.top_category).toBe('ideas_science');

    const proposal = proposeFirstWeekChanges(metrics, {
      too_narrow: true,
      too_noisy: false,
      too_repetitive: true,
      missing_interests: ['urban design'],
    });
    expect(proposal.add_strong_interests).toEqual(['urban design']);
    expect(proposal.add_interest_anchors[0]?.text).toContain('urban design');
    expect(proposal.add_negative_traits.join(' ')).toContain('repetitive');
    const next = applyFirstWeekProposal(config.taste, proposal);
    expect(next.strong_interests).toContain('urban design');
    expect(next.interest_anchors.some((anchor) => anchor.text.includes('urban design'))).toBe(true);
    expect(config.taste.strong_interests).not.toContain('urban design');
    db.close();
  });
});
