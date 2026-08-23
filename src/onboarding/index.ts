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
  version: z.literal(3),
  reading_goal: z.string().min(10),
  executive_taste_summary: z.string().min(10),
  attention_selection_model: z.string().min(10),
  values_and_outlook: z.array(z.object({
    description: z.string().min(5),
    ...evidenceItemShape,
  })).default([]),
  current_context: z.array(z.object({
    description: z.string().min(5),
    relevance_to_reading: z.string().min(5),
    ...evidenceItemShape,
  })).default([]),
  interests: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    label: z.string().min(2),
    tier: z.enum(['core', 'high_selective', 'conditional', 'low', 'unwanted']),
    priority: z.number().min(0).max(10),
    preferred_coverage: z.array(z.string().min(2)).default([]),
    conditions: z.array(z.string().min(2)).default([]),
    medium_fit: z.enum(['text_specific', 'cross_medium', 'stronger_elsewhere', 'unknown']).default('unknown'),
    ...evidenceItemShape,
  })).min(1),
  valuable_intersections: z.array(z.object({
    description: z.string().min(5),
    why_it_matters: z.string().min(5),
    ...evidenceItemShape,
  })).default([]),
  rewarding_qualities: z.array(z.object({
    quality: z.string().min(2),
    why: z.string().min(5),
    strength: z.enum(['strong', 'moderate', 'weak']),
    ...evidenceItemShape,
  })).default([]),
  unrewarding_qualities: z.array(z.object({
    quality: z.string().min(2),
    why: z.string().min(5),
    strength: z.enum(['strong', 'moderate', 'weak']),
    ...evidenceItemShape,
  })).default([]),
  content_mix: z.object({
    breaking_news: confidenceSchema,
    reporting: confidenceSchema,
    analysis: confidenceSchema,
    narrative: confidenceSchema,
    criticism: confidenceSchema,
    practical: confidenceSchema,
    entertainment: confidenceSchema,
    serendipity: confidenceSchema,
  }),
  timeliness_profile: z.object({
    news_vs_interpretation: z.string().min(5),
    loses_value_quickly: z.array(z.string().min(2)).default([]),
    remains_valuable: z.array(z.string().min(2)).default([]),
    archival_appetite: z.enum(['low', 'selective', 'high', 'unknown']),
    age_guidance: z.string().min(3),
    ...evidenceItemShape,
  }),
  depth_length_profile: z.object({
    summary: z.string().min(5),
    longform_payoff_threshold: z.string().min(5),
    technical_complexity: z.string().min(3),
    ...evidenceItemShape,
  }),
  medium_profile: z.array(z.object({
    subject_or_style: z.string().min(2),
    fit: z.enum(['text_specific', 'cross_medium', 'stronger_elsewhere', 'unknown']),
    preferred_medium: z.enum(['text', 'video', 'podcast', 'books', 'academic_papers', 'any', 'unknown']),
    transferable_qualities: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  })).default([]),
  entertainment_profile: z.object({
    role_in_ranking: z.string().min(5),
    rewarding_forms: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  }),
  exploration_profile: z.object({
    frequency: z.enum(['rare', 'occasional', 'frequent', 'unknown']),
    execution_override_strength: z.number().min(0).max(10),
    unfamiliar_topic_quality_bar: z.string().min(5),
    override_conditions: z.array(z.string().min(2)).default([]),
    ...evidenceItemShape,
  }),
  professional_personal_boundary: z.object({
    enjoyed_overlap: z.array(z.string().min(2)).default([]),
    useful_but_not_personal: z.array(z.string().min(2)).default([]),
    guidance: z.string().min(5),
    ...evidenceItemShape,
  }),
  style_references: z.array(z.object({
    name: z.string().min(1),
    relationship: z.enum(['known_favorite', 'style_reference', 'medium_reference']),
    qualities: z.string().min(5),
    confidence: confidenceSchema,
  })).default([]),
  examples: z.array(z.object({
    kind: z.enum(['explicit_positive', 'explicit_negative', 'behavioral', 'reference']),
    title_or_description: z.string().min(5),
    reason: z.string().min(5),
    confidence: confidenceSchema,
  })).default([]),
  assistant_preference_hints: assistantPreferenceHintsSchema,
  interest_anchors: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    category: z.string().min(1),
    description: z.string().min(10),
  })).default([]),
  avoid_anchors: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
    description: z.string().min(10),
  })).default([]),
  source_candidates: z.array(sourceCandidateSchema).default([]),
  ranking_guidance: z.object({
    strong_positive_signals: z.array(z.string().min(2)).default([]),
    moderate_positive_signals: z.array(z.string().min(2)).default([]),
    weak_positive_signals: z.array(z.string().min(2)).default([]),
    strong_negative_signals: z.array(z.string().min(2)).default([]),
    hard_filters: z.array(z.string().min(2)).default([]),
    override_rules: z.array(z.string().min(2)).default([]),
    interaction_effects: z.array(z.string().min(2)).default([]),
    source_level_guidance: z.array(z.string().min(2)).default([]),
    duplication_and_saturation: z.array(z.string().min(2)).default([]),
  }),
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

export function parseDossier(raw: string): OnboardingDossier {
  let source = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fenced) source = fenced[1]!.trim();
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new Error(`The onboarding dossier is not valid JSON: ${(error as Error).message}`);
  }
  const current = onboardingDossierSchema.safeParse(data);
  if (current.success) return current.data;
  throw new Error(`Invalid onboarding dossier:\n${formatZod(current.error)}`);
}

export function compileTasteProfile(
  dossier: OnboardingDossier,
  preferences: ReaderPreferences = suggestedReaderPreferences(dossier.assistant_preference_hints),
): TasteProfile {
  const constraints = preferenceSummary(preferences).join(' ');
  const mix = Object.entries(dossier.content_mix)
    .map(([key, value]) => `${key.replaceAll('_', ' ')} ${Math.round(value * 100)}%`)
    .join(', ');
  const values = dossier.values_and_outlook.length > 0
    ? `Values and outlook: ${dossier.values_and_outlook.map((item) => item.description).join('; ')}.`
    : '';
  const context = dossier.current_context.length > 0
    ? `Current context relevant to reading: ${dossier.current_context.map((item) => `${item.description} (${item.relevance_to_reading})`).join('; ')}.`
    : '';
  const list = (label: string, values: string[]) => values.length > 0 ? `${label}: ${values.join('; ')}.` : '';
  const intersections = dossier.valuable_intersections.map((item) => `${item.description} (${item.why_it_matters})`);
  const medium = dossier.medium_profile.map((item) =>
    `${item.subject_or_style}: ${item.fit}, prefer ${item.preferred_medium}${item.transferable_qualities.length > 0 ? `; transferable qualities ${item.transferable_qualities.join(', ')}` : ''}`);
  const contradictions = dossier.contradictions.map((item) => `${item.tension} (${item.conditions})`);
  const sourceContext = dossier.source_candidates.map((candidate) =>
    `${candidate.name} [${candidate.role ?? candidate.disposition}]: ${candidate.reason}${candidate.content_areas.length > 0 ? ` Relevant areas: ${candidate.content_areas.join(', ')}.` : ''}${candidate.caveats.length > 0 ? ` Caveats: ${candidate.caveats.join('; ')}.` : ''}`);
  const derivedInterestAnchors = dossier.interests
    .filter((interest) => !['low', 'unwanted'].includes(interest.tier))
    .map((interest) => ({
      id: interest.id,
      category: 'other',
      text: `${interest.label}: ${[...interest.preferred_coverage, ...interest.conditions].join('; ') || 'recommend only when the treatment is genuinely worthwhile'}`,
    }));
  const interestAnchors = dossier.interest_anchors.length > 0
    ? dossier.interest_anchors.map((anchor) => ({ id: anchor.id, category: anchor.category, text: anchor.description }))
    : derivedInterestAnchors;
  const avoidAnchors = new Map(dossier.avoid_anchors.map((anchor) => [anchor.id, anchor.description]));
  for (const interest of dossier.interests.filter((item) => item.tier === 'unwanted')) {
    avoidAnchors.set(interest.id, `${interest.label}: ${[...interest.preferred_coverage, ...interest.conditions].join('; ') || 'normally exclude this topic'}`);
  }

  return tasteProfileSchema.parse({
    version: 3,
    about_me: `${dossier.reading_goal.trim()} ${dossier.executive_taste_summary.trim()} ${values} ${context}`.replace(/\s+/g, ' ').trim(),
    strong_interests: dossier.interests
      .filter((interest) => interest.tier === 'core' && interest.confidence >= 0.55)
      .map((interest) => interest.label),
    topic_priorities: dossier.interests.map((interest) => ({
      id: interest.id,
      // Shrink uncertain assistant judgments toward neutral instead of silently
      // treating a speculative high or low preference as established taste.
      priority: Math.round((5 + (interest.priority - 5) * interest.confidence) * 100) / 100,
      guidance: [
        `${interest.tier.replaceAll('_', ' ')} interest.`,
        interest.preferred_coverage.length > 0 ? `Prefer ${interest.preferred_coverage.join(', ')}.` : '',
        interest.conditions.length > 0 ? `Conditions: ${interest.conditions.join('; ')}.` : '',
        interest.medium_fit === 'stronger_elsewhere' ? 'Text must clear a higher quality bar because another medium is usually preferred.' : '',
      ].filter(Boolean).join(' '),
    })),
    positive_content_traits: dossier.rewarding_qualities
      .filter((item) => item.confidence >= 0.35)
      .map((item) => `${item.strength}: ${item.quality} — ${item.why}`),
    negative_content_traits: dossier.unrewarding_qualities
      .filter((item) => item.confidence >= 0.35)
      .map((item) => `${item.strength}: ${item.quality} — ${item.why}`),
    editorial_notes: [
      `Attention selection model: ${dossier.attention_selection_model.trim()}`,
      `Desired portfolio mix: ${mix}.`,
      list('Especially valuable intersections', intersections),
      `Timeliness: ${dossier.timeliness_profile.news_vs_interpretation} Archival appetite is ${dossier.timeliness_profile.archival_appetite}; ${dossier.timeliness_profile.age_guidance}`,
      list('Content that loses value quickly', dossier.timeliness_profile.loses_value_quickly),
      list('Content that remains valuable', dossier.timeliness_profile.remains_valuable),
      `Depth and length: ${dossier.depth_length_profile.summary} Longform bar: ${dossier.depth_length_profile.longform_payoff_threshold} Technical complexity: ${dossier.depth_length_profile.technical_complexity}`,
      list('Medium-specific guidance', medium),
      `Entertainment: ${dossier.entertainment_profile.role_in_ranking}${dossier.entertainment_profile.rewarding_forms.length > 0 ? ` Rewarding forms: ${dossier.entertainment_profile.rewarding_forms.join(', ')}.` : ''}`,
      `Exploration: ${dossier.exploration_profile.frequency}; execution override ${dossier.exploration_profile.execution_override_strength}/10. ${dossier.exploration_profile.unfamiliar_topic_quality_bar}`,
      list('Exploration override conditions', dossier.exploration_profile.override_conditions),
      `Professional versus personal: ${dossier.professional_personal_boundary.guidance}`,
      list('Enjoyed professional overlap', dossier.professional_personal_boundary.enjoyed_overlap),
      list('Useful but not personal reading', dossier.professional_personal_boundary.useful_but_not_personal),
      list('Strong positive ranking signals', dossier.ranking_guidance.strong_positive_signals),
      list('Moderate positive ranking signals', dossier.ranking_guidance.moderate_positive_signals),
      list('Weak positive ranking signals', dossier.ranking_guidance.weak_positive_signals),
      list('Strong negative ranking signals', dossier.ranking_guidance.strong_negative_signals),
      list('Hard filters', dossier.ranking_guidance.hard_filters),
      list('Override rules', dossier.ranking_guidance.override_rules),
      list('Interaction effects', dossier.ranking_guidance.interaction_effects),
      list('Source-level guidance', dossier.ranking_guidance.source_level_guidance),
      list('Source candidate context', sourceContext),
      list('Duplication and saturation', dossier.ranking_guidance.duplication_and_saturation),
      list('Useful tensions', contradictions),
      constraints,
      list('Uncertainties to revisit after real feedback', dossier.uncertainties),
    ].filter(Boolean).join(' '),
    style_references: dossier.style_references.map((reference) => ({
      name: reference.name,
      guidance: reference.qualities,
    })),
    positive_examples: dossier.examples.filter((example) => example.kind === 'explicit_positive').map((example) => ({
      description: example.title_or_description,
      reason: example.reason,
    })),
    negative_examples: dossier.examples.filter((example) => example.kind === 'explicit_negative').map((example) => ({
      description: example.title_or_description,
      reason: example.reason,
    })),
    reader_preferences: preferences,
    source_preferences: dossier.source_candidates.map((candidate) => ({
      name: candidate.name,
      domain: candidate.domain,
      disposition: candidate.disposition,
      role: candidate.role ?? null,
      reason: candidate.reason,
      confidence: candidate.confidence,
    })),
    interest_anchors: interestAnchors,
    avoid_anchors: [...avoidAnchors].map(([id, text]) => ({ id, text })),
  });
}

export function renderProfilePreview(
  dossier: OnboardingDossier,
  preferences: ReaderPreferences,
  preferenceSource: 'completed' | 'defaults' = 'completed',
): string {
  const topics = dossier.interests
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .map((topic) => `  - ${topic.label}: ${topic.priority}/10, ${topic.tier.replaceAll('_', ' ')} (${topic.basis}, ${Math.round(topic.confidence * 100)}% confidence)`);
  const sourceGroups = ['known_favorite', 'recommended', 'exploratory', 'avoid'] as const;
  const sources = sourceGroups.flatMap((disposition) => {
    const items = dossier.source_candidates.filter((candidate) => candidate.disposition === disposition);
    if (items.length === 0) return [];
    return [
      `  ${disposition.replaceAll('_', ' ')}:`,
      ...items.map((candidate) => `    - ${candidate.name}${candidate.domain ? ` (${candidate.domain})` : ''}: ${candidate.reason} [${Math.round(candidate.confidence * 100)}%]`),
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

export function profileDirectory(profileId: string, projectRoot = PROJECT_ROOT): string {
  return resolve(projectRoot, 'profiles', validateProfileId(profileId));
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
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const profileId = validateProfileId(options.profileId);
  const directory = profileDirectory(profileId, projectRoot);
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
  const databasePath = resolve(projectRoot, 'data', 'profiles', `${profileId}.db`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(tastePath, stringifyYaml(taste, { lineWidth: 100 }));
  atomicWrite(resolve(directory, 'onboarding-dossier.json'), `${JSON.stringify(options.dossier, null, 2)}\n`);
  atomicWrite(resolve(directory, 'reader-preferences.json'), `${JSON.stringify(preferences, null, 2)}\n`);
  atomicWrite(resolve(directory, 'source-candidates.json'), `${JSON.stringify({
    version: 1,
    candidates: options.dossier.source_candidates,
    note: 'Candidate names and domains are evidence, not feed URLs. Validate feeds before adding them to sources.yaml.',
  }, null, 2)}\n`);
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
