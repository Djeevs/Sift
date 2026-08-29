import { describe, expect, it } from 'vitest';
import { contextualInterestExpired, activeContextualInterests } from '../src/config/index.js';
import { compileTasteProfile, type OnboardingDossier } from '../src/onboarding/index.js';
import { tasteVars } from '../src/ai/prompts.js';

const DAY = 86_400_000;

function baseDossier(): OnboardingDossier {
  return {
    version: 5,
    reading_goal: 'Find things worth attention.',
    executive_taste_summary: 'A reader who values explanation.',
    attention_selection_model: 'Execution can override topic fit.',
    contextual_interests: [],
    stable_interests: [{
      id: 'science',
      label: 'science',
      tier: 'core',
      priority: 8,
      preferred_coverage: [],
      avoid_coverage: [],
      conditions: [],
      saturation: { repeat_tolerance: 'unknown', new_angle_required: false, guidance: '' },
      medium_fit: 'unknown',
      basis: 'explicit',
      confidence: 0.9,
    }],
    valuable_intersections: [],
    taste_signals: [],
    semantic_anchors: [],
    avoid_anchors: [],
    depth_length_profile: { summary: 'n/a', longform_payoff_threshold: 'n/a', technical_complexity: 'n/a', basis: 'inferred', confidence: 0.5 },
    timeliness_profile: { summary: 'n/a', loses_value_quickly: [], remains_valuable: [], basis: 'inferred', confidence: 0.5 },
    exploration_profile: { frequency: 'occasional', execution_override_strength: 0, unfamiliar_topic_quality_bar: 'n/a', override_conditions: [], basis: 'inferred', confidence: 0.5 },
    exploration_frontiers: [],
    medium_profile: [],
    professional_personal_boundary: { enjoyed_overlap: [], useful_but_not_personal: [], guidance: 'n/a', basis: 'inferred', confidence: 0.5 },
    known_source_evidence: [],
    examples: [],
    assistant_preference_hints: {
      attention_budget: null, article_length: null, paywall_policy: null, languages: null,
      freshness_balance: null, max_evergreen_age_days: null, serendipity: null,
      writing_voices: null, disliked_styles: null, medium_preferences: [],
    },
    contradictions: [],
    uncertainties: [],
    privacy_redactions: [],
  };
}

describe('contextual interest decay', () => {
  it('trusts a "days" interest for 14 days and expires it after', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const fresh = { id: 'x', description: 'd', effect_on_recommendations: '', time_horizon: 'days' as const, strength: 'moderate' as const, created_at: '2026-05-20' };
    const stale = { ...fresh, created_at: '2026-05-01' };
    expect(contextualInterestExpired(fresh, now)).toBe(false);
    expect(contextualInterestExpired(stale, now)).toBe(true);
  });

  it('never expires an indefinite interest', () => {
    const veryOld = { id: 'x', description: 'd', effect_on_recommendations: '', time_horizon: 'indefinite' as const, strength: 'moderate' as const, created_at: '2000-01-01' };
    expect(contextualInterestExpired(veryOld, Date.now())).toBe(false);
  });

  it('drops expired interests from what a prompt actually sees, but keeps active ones', () => {
    const dossier = baseDossier();
    dossier.contextual_interests = [
      { id: 'live_project', description: 'Working on a specific migration.', effect_on_recommendations: 'Surface related engineering pieces.', time_horizon: 'weeks', refresh_required: false, basis: 'explicit', confidence: 0.9 },
    ];
    const taste = compileTasteProfile(dossier);
    expect(taste.contextual_interests).toHaveLength(1);

    const soon = Date.parse(taste.contextual_interests[0]!.created_at) + 5 * DAY;
    const wayLater = Date.parse(taste.contextual_interests[0]!.created_at) + 400 * DAY;
    expect(tasteVars(taste, soon).EDITORIAL_NOTES).toContain('Working on a specific migration');
    expect(tasteVars(taste, wayLater).EDITORIAL_NOTES).not.toContain('Working on a specific migration');
    expect(activeContextualInterests(taste, wayLater)).toHaveLength(0);
  });
});

describe('known-source evidence stays scoped', () => {
  it('turns a comment into a bounded quality_prior nudge, not an unconditional one', () => {
    const dossier = baseDossier();
    dossier.known_source_evidence = [{
      name: 'Example Review', relationship: 'known_favorite',
      scope: 'Their long-form reviews specifically.',
      reason: 'Repeatedly enjoyed for conceptual explanations.', basis: 'explicit', confidence: 0.9,
    }];
    const taste = compileTasteProfile(dossier);
    expect(taste.source_preferences).toHaveLength(1);
    expect(taste.source_preferences[0]!.disposition).toBe('known_favorite');
    expect(taste.source_preferences[0]!.comment).toContain('long-form reviews');
    // The comment is preserved as evidence, but it does not silently become a
    // second, wider ranking signal beyond the one bounded prior.
    expect(taste.avoid_anchors.some((a) => a.text.includes('Example Review'))).toBe(false);
  });

  it('gives "noisy but useful" a discovery-only role, not a blanket boost', () => {
    const dossier = baseDossier();
    dossier.known_source_evidence = [{
      name: 'Noisy Wire', relationship: 'noisy_but_useful',
      scope: 'Occasional exceptional pieces only.',
      reason: 'Mostly filler, but breaks things worth knowing occasionally.', basis: 'inferred', confidence: 0.6,
    }];
    const taste = compileTasteProfile(dossier);
    expect(taste.source_preferences[0]!.role).toBe('discovery_only');
  });

  it('routes a style_reference relationship to style_references, not source_preferences', () => {
    const dossier = baseDossier();
    dossier.known_source_evidence = [{
      name: 'Some Author', relationship: 'style_reference',
      scope: 'Dry, precise prose.',
      reason: 'Repeatedly cited as an example of the voice I want more of.', basis: 'observed', confidence: 0.7,
    }];
    const taste = compileTasteProfile(dossier);
    expect(taste.source_preferences).toHaveLength(0);
    expect(taste.style_references.some((s) => s.name === 'Some Author')).toBe(true);
  });

  it('turns a known_dislike into an avoid anchor, gated by content rather than domain', () => {
    const dossier = baseDossier();
    dossier.known_source_evidence = [{
      name: 'Tabloid Wire', relationship: 'known_dislike',
      scope: 'Sensationalized headlines with little substance.',
      reason: 'Repeatedly disappointing.', basis: 'observed', confidence: 0.8,
    }];
    const taste = compileTasteProfile(dossier);
    expect(taste.source_preferences[0]!.disposition).toBe('avoid');
    expect(taste.avoid_anchors.some((a) => a.text.includes('Sensationalized headlines'))).toBe(true);
  });
});
