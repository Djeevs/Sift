import { z } from 'zod';
import {
  articleLengthSchema,
  attentionBudgetSchema,
  freshnessBalanceSchema,
  paywallPolicySchema,
  preferredMediumSchema,
  readerPreferencesSchema,
  type ReaderPreferences,
} from '../config/index.js';

const confidence = z.number().min(0).max(1);
const scalarHint = <T extends z.ZodTypeAny>(value: T) => z.object({
  value: value.nullable(),
  confidence,
});

export const assistantPreferenceHintsSchema = z.object({
  attention_budget: scalarHint(attentionBudgetSchema).nullable().default(null),
  article_length: scalarHint(articleLengthSchema).nullable().default(null),
  paywall_policy: scalarHint(paywallPolicySchema).nullable().default(null),
  languages: scalarHint(z.array(z.string().min(2))).nullable().default(null),
  freshness_balance: scalarHint(freshnessBalanceSchema).nullable().default(null),
  max_evergreen_age_days: scalarHint(z.number().int().positive()).nullable().default(null),
  serendipity: scalarHint(z.number().min(0).max(10)).nullable().default(null),
  writing_voices: scalarHint(z.array(z.string().min(2))).nullable().default(null),
  disliked_styles: scalarHint(z.array(z.string().min(2))).nullable().default(null),
  medium_preferences: z.array(z.object({
    subject: z.string().min(2),
    preferred_medium: preferredMediumSchema,
    strength: z.enum(['prefer', 'strongly_prefer']).default('prefer'),
    confidence,
  })).default([]),
}).default({});

export type AssistantPreferenceHints = z.output<typeof assistantPreferenceHintsSchema>;

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  dutch: 'nl',
  nederlands: 'nl',
  russian: 'ru',
  russian_language: 'ru',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  portuguese: 'pt',
  italian: 'it',
  ukrainian: 'uk',
};

export function normalizeLanguages(values: string[]): string[] {
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => LANGUAGE_CODES[value.replace(/\s+/g, '_')] ?? value.split(/[-_]/)[0]!)
    .filter((value) => /^[a-z]{2,3}$/.test(value));
  return [...new Set(normalized.length > 0 ? normalized : ['en'])];
}

export function defaultReaderPreferences(): ReaderPreferences {
  return readerPreferencesSchema.parse({});
}

/** Use assistant suggestions only as proposed defaults. Low-confidence guesses
 * remain visible in the dossier but do not silently configure Sift. */
export function suggestedReaderPreferences(hints: AssistantPreferenceHints): ReaderPreferences {
  const defaults = defaultReaderPreferences();
  const use = <T>(hint: { value: T | null; confidence: number } | null, fallback: T): T =>
    hint?.value !== null && hint?.value !== undefined && hint.confidence >= 0.55 ? hint.value : fallback;
  return readerPreferencesSchema.parse({
    ...defaults,
    attention_budget: use(hints.attention_budget, defaults.attention_budget),
    article_length: use(hints.article_length, defaults.article_length),
    paywall_policy: use(hints.paywall_policy, defaults.paywall_policy),
    languages: normalizeLanguages(use(hints.languages, defaults.languages)),
    freshness_balance: use(hints.freshness_balance, defaults.freshness_balance),
    max_evergreen_age_days: use(hints.max_evergreen_age_days, defaults.max_evergreen_age_days),
    serendipity: use(hints.serendipity, defaults.serendipity),
    writing_voices: use(hints.writing_voices, defaults.writing_voices),
    disliked_styles: use(hints.disliked_styles, defaults.disliked_styles),
    medium_preferences: hints.medium_preferences
      .filter((preference) => preference.confidence >= 0.55)
      .map(({ confidence: _confidence, ...preference }) => preference),
  });
}

export function parseReaderPreferences(raw: string): ReaderPreferences {
  let source = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fenced) source = fenced[1]!.trim();
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new Error(`The Sift preferences file is not valid JSON: ${(error as Error).message}`);
  }
  return readerPreferencesSchema.parse(data);
}

export function preferenceSummary(preferences: ReaderPreferences): string[] {
  const attention = {
    under_15: 'under 15 minutes/day',
    '15_30': '15–30 minutes/day',
    '30_60': '30–60 minutes/day',
    '60_plus': '60+ minutes/day',
    variable: 'highly variable',
  }[preferences.attention_budget];
  const medium = preferences.medium_preferences.length > 0
    ? preferences.medium_preferences.map((item) => `${item.subject} → ${item.preferred_medium}`).join('; ')
    : 'no subject-specific medium rules';
  return [
    `Attention: ${attention}`,
    `Length: ${preferences.article_length.replaceAll('_', ' ')}`,
    `Access: ${preferences.paywall_policy.replaceAll('_', ' ')}`,
    `Languages: ${preferences.languages.join(', ')} (${preferences.non_primary_language_policy.replaceAll('_', ' ')})`,
    `Freshness: ${preferences.freshness_balance}; evergreen age limit: ${preferences.max_evergreen_age_days ?? 'none'}`,
    `Serendipity: ${preferences.serendipity}/10`,
    `Voices: ${preferences.writing_voices.join(', ') || 'no special preference'}`,
    `Disliked styles: ${preferences.disliked_styles.join(', ') || 'none supplied'}`,
    `Other media: ${medium}`,
  ];
}
