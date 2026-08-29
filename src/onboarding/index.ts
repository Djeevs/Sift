import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  PROJECT_ROOT,
  resolveHome,
  tasteProfileSchema,
  type ReaderPreferences,
  type TasteProfile,
} from '../config/index.js';
import {
  assistantPreferenceHintsSchema,
  preferenceSummary,
  suggestedReaderPreferences,
} from './preferences.js';

const basisSchema = z.enum(['explicit', 'observed', 'inferred']);
const confidenceSchema = z.number().min(0).max(1);

export const sourceCandidateSchema = z.object({
  name: z.string().min(1),
  domain: z.string().default(''),
  disposition: z.enum(['known_favorite', 'recommended', 'exploratory', 'avoid']),
  role: z.enum(['direct_follow', 'selective', 'discovery_only', 'wildcard']).optional(),
  content_areas: z.array(z.string().min(2)).default([]),
  caveats: z.array(z.string().min(2)).default([]),
  reason: z.string().min(5),
  basis: basisSchema,
  confidence: confidenceSchema,
});

const evidenceItemShape = {
  basis: basisSchema,
  confidence: confidenceSchema,
};

export const onboardingDossierSchema = z.object({
  version: z.literal(5),
  reading_goal: z.string().min(10),
  executive_taste_summary: z.string().min(10),
  attention_selection_model: z.string().min(10),
  /**
   * A live situation, not durable taste -- a project, a trip, a season of
   * interest. Kept apart from `stable_interests` so it can be re-asked rather
   * than silently becoming permanent: `time_horizon` says how long it should
   * be trusted without confirmation, and `refresh_required` flags one that
   * has probably already outlived its relevance.
   */
  contextual_interests: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    description: z.string().min(5),
    effect_on_recommendations: z.string().min(5),
    strength: z.enum(['low', 'moderate', 'high']).default('moderate'),
    time_horizon: z.enum(['days', 'weeks', 'months', 'indefinite', 'unknown']).default('unknown'),
    refresh_required: z.boolean().default(false),
    ...evidenceItemShape,
  })).default([]),
  stable_interests: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    label: z.string().min(2),
    tier: z.enum(['core', 'high_selective', 'conditional', 'low', 'unwanted']),
    priority: z.number().min(0).max(10),
    preferred_coverage: z.array(z.string().min(2)).default([]),
    avoid_coverage: z.array(z.string().min(2)).default([]),
    conditions: z.array(z.string().min(2)).default([]),
    saturation: z.object({
      repeat_tolerance: z.enum(['high', 'moderate', 'low', 'very_low', 'unknown']).default('unknown'),
      new_angle_required: z.boolean().default(false),
      guidance: z.string().default(''),
    }).default({}),
    medium_fit: z.enum(['text_specific', 'cross_medium', 'stronger_elsewhere', 'unknown']).default('unknown'),
    ...evidenceItemShape,
  })).min(1),
  valuable_intersections: z.array(z.object({
    description: z.string().min(5),
    why_it_matters: z.string().min(5),
    ...evidenceItemShape,
  })).default([]),
  /** One signed scale rather than separate rewarding/unrewarding lists, so a
   * quality that is mildly nice in one context and a hard filter in another
   * (`conditions`) does not have to be split across two arrays that disagree. */
  taste_signals: z.array(z.object({
    signal: z.string().min(2),
    effect: z.enum([
      'strong_positive', 'moderate_positive', 'weak_positive',
      'weak_negative', 'moderate_negative', 'strong_negative', 'hard_filter',
    ]),
    why: z.string().min(5),
    conditions: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  })).default([]),
  semantic_anchors: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    /** Links back to `stable_interests[].id` when this anchor sharpens one. */
    interest_id: z.string().nullable().default(null),
    description: z.string().min(10),
    priority: z.number().min(0).max(10).default(5),
    ...evidenceItemShape,
  })).default([]),
  avoid_anchors: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    description: z.string().min(10),
    strength: z.enum(['strong', 'moderate', 'weak']).default('moderate'),
    ...evidenceItemShape,
  })).default([]),
  depth_length_profile: z.object({
    summary: z.string().min(5),
    longform_payoff_threshold: z.string().min(5),
    technical_complexity: z.string().min(3),
    ...evidenceItemShape,
  }),
  timeliness_profile: z.object({
    summary: z.string().min(5),
    loses_value_quickly: z.array(z.string().min(2)).default([]),
    remains_valuable: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  }),
  exploration_profile: z.object({
    frequency: z.enum(['rare', 'occasional', 'frequent', 'unknown']),
    execution_override_strength: z.number().min(0).max(10),
    unfamiliar_topic_quality_bar: z.string().min(5),
    override_conditions: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  }),
  /** Specific promising directions, not just a general appetite for them --
   * each must justify itself against something already established. */
  exploration_frontiers: z.array(z.object({
    description: z.string().min(5),
    bridge: z.string().min(5),
    ...evidenceItemShape,
  })).default([]),
  medium_profile: z.array(z.object({
    subject_or_style: z.string().min(2),
    fit: z.enum(['text_specific', 'cross_medium', 'stronger_elsewhere', 'unknown']),
    preferred_medium: z.enum(['text', 'video', 'podcast', 'books', 'academic_papers', 'any', 'unknown']),
    transferable_qualities: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  })).default([]),
  professional_personal_boundary: z.object({
    enjoyed_overlap: z.array(z.string().min(2)).default([]),
    useful_but_not_personal: z.array(z.string().min(2)).default([]),
    guidance: z.string().min(5),
    ...evidenceItemShape,
  }),
  /**
   * Sources I already have an evidenced relationship with -- not
   * recommendations. Sift already discovers new sources itself, from this
   * profile plus what has actually scored well (`npm run sources:suggest`);
   * an assistant naming publications it merely believes would fit duplicates
   * that job with none of the evidence, so it does not do it here.
   *
   * `scope` keeps "I like their reviews" from becoming "I like everything
   * from this publication": it names what specifically the evidence covers,
   * separately from `reason`, which is what the evidence itself establishes.
   */
  known_source_evidence: z.array(z.object({
    name: z.string().min(1),
    relationship: z.enum(['known_favorite', 'positive_evidence', 'known_dislike', 'style_reference', 'noisy_but_useful']),
    scope: z.string().min(5),
    reason: z.string().min(5),
    ...evidenceItemShape,
  })).default([]),
  examples: z.array(z.object({
    kind: z.enum(['explicit_positive', 'explicit_negative', 'behavioral', 'reference']),
    title_or_description: z.string().min(5),
    reason: z.string().min(5),
    confidence: confidenceSchema,
  })).default([]),
  assistant_preference_hints: assistantPreferenceHintsSchema,
  contradictions: z.array(z.object({
    tension: z.string().min(5),
    conditions: z.string().min(5),
    confidence: confidenceSchema,
  })).default([]),
  uncertainties: z.array(z.string().min(3)).default([]),
  privacy_redactions: z.array(z.string().min(1)).default([]),
});

export type OnboardingDossier = z.infer<typeof onboardingDossierSchema>;

export interface OnboardingState {
  version: 1 | 2;
  profile_id: string;
  created_at: string;
  first_week_due_at: string;
  calibration: 'pending' | 'completed' | 'skipped';
  calibration_completed_at?: string;
  first_week_review: 'pending' | 'completed';
  first_week_review_completed_at?: string;
  preferences?: 'completed' | 'defaults';
  profile_approved_at?: string;
}

function formatZod(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

/**
 * Find the JSON object inside whatever the reader pasted.
 *
 * A chat reply is prose with an object somewhere in it — "Here's your profile:
 * {...} Let me know if you'd like changes." Requiring a clean paste made the
 * obvious action (select all, copy) fail on the first screen of onboarding, and
 * the resulting error was a JSON parser message. Scanning for the first
 * balanced object is string- and escape-aware so a brace inside a quoted value
 * cannot end the scan early.
 */
export function extractJsonObject(input: string): string | null {
  const start = input.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

export function parseDossier(raw: string): OnboardingDossier {
  let source = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fenced) source = fenced[1]!.trim();
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    // Fall back to the object embedded in a longer reply before giving up.
    const embedded = extractJsonObject(source);
    if (embedded) {
      try {
        data = JSON.parse(embedded);
      } catch {
        throw new Error(`The onboarding dossier is not valid JSON: ${(error as Error).message}`);
      }
    } else {
      throw new Error(`The onboarding dossier is not valid JSON: ${(error as Error).message}`);
    }
  }
  const current = onboardingDossierSchema.safeParse(data);
  if (current.success) return current.data;
  throw new Error(`Invalid onboarding dossier:\n${formatZod(current.error)}`);
}

/**
 * relationship → the existing source_preferences vocabulary that
 * config/index.ts already turns into a small bounded quality_prior nudge.
 * `role` controls how much of that nudge actually applies: "noisy but
 * useful" is deliberately not a blanket endorsement, so it gets the same
 * near-zero multiplier `discovery_only` already had.
 */
const SOURCE_RELATIONSHIP: Record<string, { disposition: 'known_favorite' | 'recommended' | 'exploratory' | 'avoid'; role: 'direct_follow' | 'selective' | 'discovery_only' } | null> = {
  known_favorite: { disposition: 'known_favorite', role: 'direct_follow' },
  positive_evidence: { disposition: 'recommended', role: 'selective' },
  known_dislike: { disposition: 'avoid', role: 'direct_follow' },
  noisy_but_useful: { disposition: 'exploratory', role: 'discovery_only' },
  style_reference: null, // routed to style_references instead; not a "should Sift favour this domain" signal
};

export function compileTasteProfile(
  dossier: OnboardingDossier,
  preferences: ReaderPreferences = suggestedReaderPreferences(dossier.assistant_preference_hints),
): TasteProfile {
  const constraints = preferenceSummary(preferences).join(' ');
  const list = (label: string, values: string[]) => values.length > 0 ? `${label}: ${values.join('; ')}.` : '';
  const intersections = dossier.valuable_intersections.map((item) => `${item.description} (${item.why_it_matters})`);
  const medium = dossier.medium_profile.map((item) =>
    `${item.subject_or_style}: ${item.fit}, prefer ${item.preferred_medium}${item.transferable_qualities.length > 0 ? `; transferable qualities ${item.transferable_qualities.join(', ')}` : ''}`);
  const contradictions = dossier.contradictions.map((item) => `${item.tension} (${item.conditions})`);
  const frontiers = dossier.exploration_frontiers.map((item) => `${item.description} (bridge: ${item.bridge})`);
  const tasteSignals = dossier.taste_signals.map((item) =>
    `${item.effect.replaceAll('_', ' ')}: ${item.signal} — ${item.why}${item.conditions.length > 0 ? ` (${item.conditions.join('; ')})` : ''}`);

  const semanticAnchors = dossier.semantic_anchors.length > 0
    ? dossier.semantic_anchors.map((anchor) => ({ id: anchor.id, category: 'other', text: anchor.description }))
    : dossier.stable_interests
        .filter((interest) => !['low', 'unwanted'].includes(interest.tier))
        .map((interest) => ({
          id: interest.id,
          category: 'other',
          text: `${interest.label}: ${[...interest.preferred_coverage, ...interest.conditions].join('; ') || 'recommend only when the treatment is genuinely worthwhile'}`,
        }));
  const avoidAnchors = new Map(dossier.avoid_anchors.map((anchor) => [anchor.id, { text: anchor.description, strength: anchor.strength }]));
  for (const interest of dossier.stable_interests.filter((item) => item.tier === 'unwanted')) {
    avoidAnchors.set(interest.id, {
      text: `${interest.label}: ${[...interest.preferred_coverage, ...interest.conditions].join('; ') || 'normally exclude this topic'}`,
      strength: 'moderate' as const,
    });
  }
  // A source comment ("I like their reviews") becomes evidence gated by what
  // the article is actually about, not a domain-wide boost -- so it is
  // compiled to an anchor, exactly like any other taste signal. `scope` is
  // used rather than `reason`: it is the part that says what the evidence
  // specifically covers.
  for (const source of dossier.known_source_evidence) {
    if (source.relationship === 'known_dislike') {
      avoidAnchors.set(`source_${source.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, { text: `${source.name}: ${source.scope}`, strength: 'moderate' as const });
    }
  }

  return tasteProfileSchema.parse({
    version: 4,
    about_me: `${dossier.reading_goal.trim()} ${dossier.executive_taste_summary.trim()}`.replace(/\s+/g, ' ').trim(),
    strong_interests: dossier.stable_interests
      .filter((interest) => interest.tier === 'core' && interest.confidence >= 0.55)
      .map((interest) => interest.label),
    topic_priorities: dossier.stable_interests.map((interest) => ({
      id: interest.id,
      // Shrink uncertain assistant judgments toward neutral instead of silently
      // treating a speculative high or low preference as established taste.
      priority: Math.round((5 + (interest.priority - 5) * interest.confidence) * 100) / 100,
      guidance: [
        `${interest.tier.replaceAll('_', ' ')} interest.`,
        interest.preferred_coverage.length > 0 ? `Prefer ${interest.preferred_coverage.join(', ')}.` : '',
        interest.avoid_coverage.length > 0 ? `Avoid ${interest.avoid_coverage.join(', ')}.` : '',
        interest.conditions.length > 0 ? `Conditions: ${interest.conditions.join('; ')}.` : '',
        interest.saturation.guidance || (interest.saturation.repeat_tolerance !== 'unknown' ? `Repeat tolerance: ${interest.saturation.repeat_tolerance}.` : ''),
        interest.medium_fit === 'stronger_elsewhere' ? 'Text must clear a higher quality bar because another medium is usually preferred.' : '',
      ].filter(Boolean).join(' '),
    })),
    positive_content_traits: dossier.taste_signals
      .filter((item) => item.effect.endsWith('positive') && item.confidence >= 0.35)
      .map((item) => `${item.effect.replace('_positive', '')}: ${item.signal} — ${item.why}`),
    negative_content_traits: dossier.taste_signals
      .filter((item) => (item.effect.endsWith('negative') || item.effect === 'hard_filter') && item.confidence >= 0.35)
      .map((item) => `${item.effect === 'hard_filter' ? 'hard filter' : item.effect.replace('_negative', '')}: ${item.signal} — ${item.why}`),
    editorial_notes: [
      `Attention selection model: ${dossier.attention_selection_model.trim()}`,
      list('Especially valuable intersections', intersections),
      `Timeliness: ${dossier.timeliness_profile.summary}`,
      list('Content that loses value quickly', dossier.timeliness_profile.loses_value_quickly),
      list('Content that remains valuable', dossier.timeliness_profile.remains_valuable),
      `Depth and length: ${dossier.depth_length_profile.summary} Longform bar: ${dossier.depth_length_profile.longform_payoff_threshold} Technical complexity: ${dossier.depth_length_profile.technical_complexity}`,
      list('Medium-specific guidance', medium),
      `Exploration: ${dossier.exploration_profile.frequency}; execution override ${dossier.exploration_profile.execution_override_strength}/10. ${dossier.exploration_profile.unfamiliar_topic_quality_bar}`,
      list('Exploration override conditions', dossier.exploration_profile.override_conditions),
      list('Specific exploration frontiers', frontiers),
      `Professional versus personal: ${dossier.professional_personal_boundary.guidance}`,
      list('Enjoyed professional overlap', dossier.professional_personal_boundary.enjoyed_overlap),
      list('Useful but not personal reading', dossier.professional_personal_boundary.useful_but_not_personal),
      list('Taste signals', tasteSignals),
      list('Useful tensions', contradictions),
      constraints,
      list('Uncertainties to revisit after real feedback', dossier.uncertainties),
    ].filter(Boolean).join(' '),
    positive_examples: dossier.examples.filter((example) => example.kind === 'explicit_positive').map((example) => ({
      description: example.title_or_description,
      reason: example.reason,
    })),
    negative_examples: dossier.examples.filter((example) => example.kind === 'explicit_negative').map((example) => ({
      description: example.title_or_description,
      reason: example.reason,
    })),
    style_references: dossier.known_source_evidence
      .filter((source) => source.relationship === 'style_reference')
      .map((source) => ({ name: source.name, guidance: source.scope })),
    reader_preferences: preferences,
    contextual_interests: dossier.contextual_interests.map((item) => ({
      id: item.id,
      description: item.description,
      effect_on_recommendations: item.effect_on_recommendations,
      time_horizon: item.time_horizon === 'unknown' ? 'months' : item.time_horizon,
      strength: item.strength,
      created_at: new Date().toISOString().slice(0, 10),
    })),
    source_preferences: dossier.known_source_evidence
      .filter((source) => SOURCE_RELATIONSHIP[source.relationship])
      .map((source) => ({
        name: source.name,
        domain: '',
        disposition: SOURCE_RELATIONSHIP[source.relationship]!.disposition,
        role: SOURCE_RELATIONSHIP[source.relationship]!.role,
        reason: source.reason,
        confidence: source.confidence,
        comment: source.scope,
      })),
    interest_anchors: semanticAnchors,
    avoid_anchors: [...avoidAnchors].map(([id, { text, strength }]) => ({ id, text, strength })),
  });
}

export function renderProfilePreview(
  dossier: OnboardingDossier,
  preferences: ReaderPreferences,
  preferenceSource: 'completed' | 'defaults' = 'completed',
): string {
  const topics = dossier.stable_interests
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .map((topic) => `  - ${topic.label}: ${topic.priority}/10, ${topic.tier.replaceAll('_', ' ')} (${topic.basis}, ${Math.round(topic.confidence * 100)}% confidence)`);
  const relationshipGroups = ['known_favorite', 'positive_evidence', 'noisy_but_useful', 'style_reference', 'known_dislike'] as const;
  const sources = relationshipGroups.flatMap((relationship) => {
    const items = dossier.known_source_evidence.filter((source) => source.relationship === relationship);
    if (items.length === 0) return [];
    return [
      `  ${relationship.replaceAll('_', ' ')}:`,
      ...items.map((source) => `    - ${source.name}: ${source.scope} [${Math.round(source.confidence * 100)}%]`),
    ];
  });
  const uncertainty = dossier.uncertainties.length > 0
    ? dossier.uncertainties.map((item) => `  - ${item}`)
    : ['  - none supplied'];
  return [
    'SIFT PROFILE PREVIEW — NO FILES HAVE BEEN CREATED',
    '',
    `Reading goal: ${dossier.reading_goal}`,
    `Reader: ${dossier.executive_taste_summary}`,
    '',
    'Highest-priority topics:',
    ...(topics.length > 0 ? topics : ['  - none']),
    '',
    `Sift preferences (${preferenceSource === 'defaults' ? 'safe defaults; wizard skipped' : 'reviewed or proposed'}):`,
    ...preferenceSummary(preferences).map((line) => `  - ${line}`),
    '',
    'Source evidence and candidates:',
    ...(sources.length > 0 ? sources : ['  - none supplied']),
    '  Sift will not invent or activate feed URLs. Only matches to validated configured sources receive a small bounded prior.',
    '',
    'Uncertainties to revisit:',
    ...uncertainty,
    '',
    `Attention selection model: ${dossier.attention_selection_model}`,
  ].join('\n');
}

export function validateProfileId(profileId: string): string {
  const normalized = profileId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Profile id must be 1-64 lowercase letters, numbers, hyphens, or underscores');
  }
  return normalized;
}

/**
 * A reader's private directory. Rooted in SIFT_HOME, not PROJECT_ROOT: this is
 * state, and it has to survive replacing the application.
 */
export function profileDirectory(profileId: string, home = resolveHome()): string {
  return resolve(home, 'profiles', validateProfileId(profileId));
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function readOnboardingState(profileDir: string): OnboardingState {
  const path = resolve(profileDir, 'onboarding-state.json');
  if (!existsSync(path)) throw new Error(`No onboarding state found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as OnboardingState;
}

export function onboardingReminder(profileId: string, now = new Date()): string | null {
  const directory = profileDirectory(profileId);
  const path = resolve(directory, 'onboarding-state.json');
  if (!existsSync(path)) return null;
  const state = readOnboardingState(directory);
  if (state.first_week_review === 'pending' && now.getTime() >= new Date(state.first_week_due_at).getTime()) {
    return `First-week review is due for profile ${profileId}. Run: npm run review -- --profile ${profileId}`;
  }
  return null;
}

export function writeOnboardingState(profileDir: string, state: OnboardingState): void {
  atomicWrite(resolve(profileDir, 'onboarding-state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

export interface CreateProfileOptions {
  /**
   * Where this reader's files are written. Named for what it is: everything
   * createProfile touches is state, so it belongs under SIFT_HOME rather than
   * beside the code. Tests pass a fixture directory.
   */
  projectRoot?: string;
  profileId: string;
  dossier: OnboardingDossier;
  preferences?: ReaderPreferences;
  preferencesStatus?: 'completed' | 'defaults';
  approved: boolean;
  skipCalibration?: boolean;
  force?: boolean;
  now?: Date;
  accessToken?: string;
}

export interface CreatedProfile {
  profileId: string;
  directory: string;
  databasePath: string;
  state: OnboardingState;
}

export function createProfile(options: CreateProfileOptions): CreatedProfile {
  if (!options.approved) {
    throw new Error('Profile creation requires explicit approval after reviewing the compiled preview.');
  }
  const home = options.projectRoot ?? resolveHome();
  const profileId = validateProfileId(options.profileId);
  const directory = profileDirectory(profileId, home);
  const tastePath = resolve(directory, 'taste-profile.yaml');
  if (existsSync(tastePath) && !options.force) {
    throw new Error(`Profile "${profileId}" already exists. Use --force only after reviewing the existing files.`);
  }

  const now = options.now ?? new Date();
  const due = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const state: OnboardingState = {
    version: 2,
    profile_id: profileId,
    created_at: now.toISOString(),
    first_week_due_at: due.toISOString(),
    calibration: options.skipCalibration ? 'skipped' : 'pending',
    first_week_review: 'pending',
    preferences: options.preferencesStatus ?? 'completed',
    profile_approved_at: now.toISOString(),
  };
  const preferences = options.preferences ?? suggestedReaderPreferences(options.dossier.assistant_preference_hints);
  const taste = compileTasteProfile(options.dossier, preferences);
  const token = options.accessToken ?? randomBytes(32).toString('base64url');
  const databasePath = resolve(home, 'data', 'profiles', `${profileId}.db`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(tastePath, stringifyYaml(taste, { lineWidth: 100 }));
  atomicWrite(resolve(directory, 'onboarding-dossier.json'), `${JSON.stringify(options.dossier, null, 2)}\n`);
  atomicWrite(resolve(directory, 'reader-preferences.json'), `${JSON.stringify(preferences, null, 2)}\n`);
  // The dossier no longer proposes sources -- that is Sift's own job, done
  // with more evidence than an assistant has (`npm run sources:suggest`).
  // Only seed the file if a suggestion run has not already populated it, so
  // recompiling a dossier never discards candidates already found.
  const candidatesPath = resolve(directory, 'source-candidates.json');
  if (!existsSync(candidatesPath)) {
    atomicWrite(candidatesPath, `${JSON.stringify({
      version: 1,
      candidates: [],
      note: 'Empty until you run: npm run sources:suggest -- --profile <id>. Candidate names and domains are evidence, not feed URLs; validate feeds before adding them to sources.yaml.',
    }, null, 2)}\n`);
  }
  atomicWrite(resolve(directory, 'profile-preview.txt'), `${renderProfilePreview(
    options.dossier,
    preferences,
    options.preferencesStatus ?? 'completed',
  )}\n`);
  writeOnboardingState(directory, state);
  const environmentPath = resolve(directory, '.env');
  // `--force` may intentionally recompile a dossier, but it must never rotate
  // a live feed token or erase publisher bindings as a side effect.
  if (!existsSync(environmentPath)) {
    atomicWrite(environmentPath, [
      `SIFT_CONFIG_DIR=./profiles/${profileId}`,
      `SIFT_DB_PATH=./data/profiles/${profileId}.db`,
      'SIFT_PUBLIC_URL=http://localhost:8787',
      `SIFT_ACCESS_TOKEN=${token}`,
      '# Configure a separate Cloudflare namespace before publishing this profile.',
      'CLOUDFLARE_ACCOUNT_ID=',
      'CLOUDFLARE_API_TOKEN=',
      'SIFT_KV_NAMESPACE_ID=',
      'SIFT_FEEDBACK_EXCELLENT_URL=',
      'SIFT_FEEDBACK_NOT_FOR_ME_URL=',
      '',
    ].join('\n'));
  }

  return { profileId, directory, databasePath, state };
}

export function readTasteProfile(profileDir: string): TasteProfile {
  const path = resolve(profileDir, 'taste-profile.yaml');
  if (!existsSync(path)) throw new Error(`Taste profile not found: ${path}`);
  return tasteProfileSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

export function writeTasteProfile(profileDir: string, taste: TasteProfile): void {
  const validated = tasteProfileSchema.parse(taste);
  atomicWrite(resolve(profileDir, 'taste-profile.yaml'), stringifyYaml(validated, { lineWidth: 100 }));
}
