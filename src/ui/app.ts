import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { Hono, type Context } from 'hono';
import { parse as parseYaml } from 'yaml';
import {
  PROJECT_ROOT,
  resolveHome,
  feedFileSchema,
  classicsFileSchema,
  modelsFileSchema,
  readerPreferencesSchema,
  budgetFileSchema,
  type ReaderPreferences,
} from '../config/index.js';
import { escapeXml } from '../util/text.js';
import {
  createProfile,
  atomicWrite,
  parseDossier,
  compileTasteProfile,
  profileDirectory,
  readOnboardingState,
  renderProfilePreview,
  validateProfileId,
  type OnboardingDossier,
} from '../onboarding/index.js';
import {
  defaultReaderPreferences,
  normalizeLanguages,
  suggestedReaderPreferences,
} from '../onboarding/preferences.js';
import {
  applyRankedCalibration,
  rankedCalibrationItems,
  type RankedCalibrationAnswers,
  type RankedCalibrationLabel,
} from '../onboarding/calibration.js';
import {
  adoptSources,
  adoptableSources,
  type AdoptableSource,
} from '../onboarding/adoptSources.js';
import { loadConfig } from '../config/index.js';
import { ACTIONS, JobBusyError, UiJobRunner, type UiAction } from './jobs.js';
import { readJobProgress, type JobProgress } from './progress.js';
import { serviceState } from '../service/launchd.js';

interface Draft {
  profileId: string;
  dossier: OnboardingDossier;
  preferences?: ReaderPreferences;
  preferenceStatus?: 'completed' | 'defaults';
}

interface ProfileSummary {
  id: string;
  databasePath: string;
  databaseExists: boolean;
  items: number;
  placements: number;
  publicUrl: string;
  token: string;
  calibration: string;
  review: string;
  sourceCandidates: number;
  validatedFeeds: number;
  provider: string;
  aiKeyConfigured: boolean;
  aiReady: boolean;
  triageModel: string;
  deepModel: string;
  embeddingModel: string;
  baseUrl: string;
  cloudflareConfigured: boolean;
}

export interface UiAppOptions {
  /** Read-only assets: bundled config defaults, prompts, the onboarding text. */
  projectRoot?: string;
  /**
   * Writable state: readers, databases, tokens. Defaults to `projectRoot` when
   * one is given, so a test fixture stays a single self-contained directory,
   * and to SIFT_HOME otherwise.
   */
  home?: string;
  csrfToken?: string;
  jobRunner?: UiJobRunner;
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return Object.fromEntries(
      Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

const PROVIDERS = ['openai', 'ollama', 'openrouter', 'groq', 'gemini', 'anthropic', 'custom'] as const;
type Provider = typeof PROVIDERS[number];

function providerKeyName(provider: Provider): string | null {
  return {
    openai: 'OPENAI_API_KEY',
    ollama: null,
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    custom: 'OPENAI_API_KEY',
  }[provider];
}

function configuredSecret(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  return Boolean(normalized && !/^(?:sk-\.\.\.|change-me|your[-_ ]|example)/i.test(normalized));
}

function safeEnvValue(value: string, label: string, max = 1000): string {
  if (value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${label} contains invalid characters.`);
  return value.trim();
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Preserve unrelated profile settings and comments. Values are always quoted
 * so API-key punctuation cannot become dotenv syntax. */
function updateEnv(path: string, updates: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^${key}=`).test(line));
    const rendered = `${key}=${JSON.stringify(value)}`;
    if (index >= 0) lines[index] = rendered;
    else lines.push(rendered);
  }
  atomicWrite(path, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}

function field(body: Record<string, string | File>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function checked(body: Record<string, string | File>, name: string): boolean {
  return ['1', 'true', 'yes', 'on', 'approve'].includes(field(body, name).toLowerCase());
}

function splitList(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

const MEDIUM_ROWS = 3;

/**
 * Medium rules used to be one text box parsed as `subject=video, other=podcast`.
 * A key=value mini-syntax in a consumer form is a trap: a typo produced a
 * validation error on a page the reader had already spent minutes filling in.
 * Three subject/medium pairs express the same thing and cannot be malformed.
 */
function mediumPreferencesFromRows(body: Record<string, string | File>): ReaderPreferences['medium_preferences'] {
  const out: ReaderPreferences['medium_preferences'] = [];
  for (let index = 0; index < MEDIUM_ROWS; index += 1) {
    const subject = field(body, `medium_subject_${index}`).trim();
    const medium = field(body, `medium_value_${index}`).trim().toLowerCase();
    if (!subject) continue;
    if (!['text', 'video', 'podcast', 'any'].includes(medium)) continue;
    out.push({ subject, preferred_medium: medium as 'text' | 'video' | 'podcast' | 'any', strength: 'prefer' as const });
  }
  return out;
}

function mediumRowsHtml(proposed: ReaderPreferences['medium_preferences']): string {
  return Array.from({ length: MEDIUM_ROWS }, (_, index) => {
    const existing = proposed[index];
    const selected = existing?.preferred_medium ?? 'any';
    return `<div class="medium-row"><input name="medium_subject_${index}" type="text" value="${escapeXml(existing?.subject ?? '')}" placeholder="${index === 0 ? 'game criticism' : index === 1 ? 'long interviews' : 'a subject you prefer elsewhere'}" aria-label="Subject ${index + 1}"><select name="medium_value_${index}" aria-label="Preferred medium ${index + 1}">${option('any', 'no preference', selected)}${option('text', 'better as writing', selected)}${option('video', 'better as video', selected)}${option('podcast', 'better as a podcast', selected)}</select></div>`;
  }).join('');
}

function preferencesFromForm(body: Record<string, string | File>): ReaderPreferences {
  const maxAgeRaw = field(body, 'max_evergreen_age_days').trim();
  return readerPreferencesSchema.parse({
    version: 1,
    attention_budget: field(body, 'attention_budget'),
    article_length: field(body, 'article_length'),
    paywall_policy: field(body, 'paywall_policy'),
    subscribed_publications: splitList(field(body, 'subscribed_publications')),
    languages: normalizeLanguages(splitList(field(body, 'languages'))),
    non_primary_language_policy: field(body, 'non_primary_language_policy'),
    freshness_balance: field(body, 'freshness_balance'),
    max_evergreen_age_days: maxAgeRaw ? Number(maxAgeRaw) : null,
    serendipity: Number(field(body, 'serendipity')),
    writing_voices: splitList(field(body, 'writing_voices')),
    disliked_styles: splitList(field(body, 'disliked_styles')),
    medium_preferences: mediumPreferencesFromRows(body),
  });
}

function option(value: string, label: string, selected: string): string {
  return `<option value="${escapeXml(value)}"${value === selected ? ' selected' : ''}>${escapeXml(label)}</option>`;
}

function hiddenCsrf(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeXml(csrf)}">`;
}

function profileIds(projectRoot: string): string[] {
  const root = resolve(projectRoot, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'example' && existsSync(resolve(root, entry.name, 'taste-profile.yaml')))
    .map((entry) => entry.name)
    .sort();
}

function jsonCount(path: string, property: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const value = parsed[property];
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

function profileSummary(projectRoot: string, home: string, profileId: string): ProfileSummary {
  const directory = profileDirectory(profileId, home);
  const rootEnv = readEnv(resolve(projectRoot, '.env'));
  const profileEnv = readEnv(resolve(directory, '.env'));
  const effectiveEnv = { ...rootEnv, ...profileEnv };
  const isRootProfile = rootEnv.SIFT_PROFILE?.trim().toLowerCase() === profileId;
  const rawDb = profileEnv.SIFT_DB_PATH || (isRootProfile ? rootEnv.SIFT_DB_PATH : '') || `./data/profiles/${profileId}.db`;
  const databasePath = rawDb === ':memory:' ? rawDb : resolve(projectRoot, rawDb);
  let items = 0;
  let placements = 0;
  if (databasePath !== ':memory:' && existsSync(databasePath)) {
    try {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      const row = db.prepare(`SELECT (SELECT COUNT(*) FROM feed_items) AS items,
        (SELECT COUNT(*) FROM published_feed_items) AS placements`).get() as { items: number; placements: number };
      items = Number(row.items ?? 0);
      placements = Number(row.placements ?? 0);
      db.close();
    } catch {
      // The dashboard remains usable when a database is mid-migration or locked.
    }
  }
  let calibration = 'not started';
  let review = 'not started';
  try {
    const state = readOnboardingState(directory);
    calibration = state.calibration;
    review = state.first_week_review;
  } catch {
    // Older owner profiles predate onboarding state.
  }
  const publicUrl = (profileEnv.SIFT_PUBLIC_URL || (isRootProfile ? rootEnv.SIFT_PUBLIC_URL : '') || 'http://localhost:8787').replace(/\/+$/, '');
  const token = profileEnv.SIFT_ACCESS_TOKEN || (isRootProfile ? rootEnv.SIFT_ACCESS_TOKEN : '') || '';
  const sourceCandidates = jsonCount(resolve(directory, 'source-candidates.json'), 'candidates');
  let validatedFeeds = 0;
  const discoveryPath = resolve(directory, 'source-discovery.json');
  if (existsSync(discoveryPath)) {
    try {
      const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { results?: Array<{ feeds?: unknown[] }> };
      validatedFeeds = (discovery.results ?? []).reduce((sum, result) => sum + (result.feeds?.length ?? 0), 0);
    } catch {
      // Leave the count at zero; the report itself remains available on disk.
    }
  }
  const modelPath = existsSync(resolve(directory, 'models.yaml'))
    ? resolve(directory, 'models.yaml')
    : resolve(projectRoot, 'config', 'models.yaml');
  const models = modelsFileSchema.parse(parseYaml(readFileSync(modelPath, 'utf8')));
  const provider = (effectiveEnv.SIFT_AI_PROVIDER || 'openai').toLowerCase();
  const knownProvider = PROVIDERS.includes(provider as Provider) ? provider as Provider : 'custom';
  const keyName = providerKeyName(knownProvider);
  const sharedKeyConfigured = keyName ? configuredSecret(effectiveEnv[keyName]) : true;
  const roleKeysConfigured = configuredSecret(effectiveEnv.SIFT_TRIAGE_API_KEY) && configuredSecret(effectiveEnv.SIFT_DEEP_API_KEY);
  const aiKeyConfigured = sharedKeyConfigured || roleKeysConfigured;
  return {
    id: profileId,
    databasePath,
    databaseExists: databasePath === ':memory:' || existsSync(databasePath),
    items,
    placements,
    publicUrl,
    token,
    calibration,
    review,
    sourceCandidates,
    validatedFeeds,
    provider,
    aiKeyConfigured,
    aiReady: provider === 'ollama' || aiKeyConfigured,
    triageModel: profileEnv.SIFT_TRIAGE_MODEL || effectiveEnv.SIFT_TRIAGE_MODEL || models.models.triage.model,
    deepModel: profileEnv.SIFT_DEEP_MODEL || effectiveEnv.SIFT_DEEP_MODEL || models.models.deep.model,
    embeddingModel: profileEnv.SIFT_EMBEDDING_MODEL || effectiveEnv.SIFT_EMBEDDING_MODEL || models.models.embeddings.model,
    baseUrl: profileEnv.OPENAI_BASE_URL || effectiveEnv.OPENAI_BASE_URL || '',
    cloudflareConfigured: Boolean(
      effectiveEnv.SIFT_KV_NAMESPACE_ID?.trim() &&
      publicUrl &&
      !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(publicUrl)
    ),
  };
}

function feedSlugs(projectRoot: string, home: string, profileId: string): Array<{ title: string; slug: string }> {
  const directory = profileDirectory(profileId, home);
  const configPath = (name: string) => existsSync(resolve(directory, name))
    ? resolve(directory, name)
    : resolve(projectRoot, 'config', name);
  const feeds = feedFileSchema.parse(parseYaml(readFileSync(configPath('feed-config.yaml'), 'utf8'))).feeds;
  const classics = classicsFileSchema.parse(parseYaml(readFileSync(configPath('classics.yaml'), 'utf8'))).feed;
  return [...feeds, classics].map((feed) => ({ title: feed.title, slug: feed.slug }));
}

/**
 * Turn whatever the reader typed into a valid profile id.
 *
 * The field used to reject anything but lowercase-and-hyphens, so "Alice Smith"
 * -- the obvious thing to type into a box labelled "Reader name" -- failed
 * validation on the very first screen. The id is only ever a folder and
 * database filename, so there is no reason to make the reader produce it.
 */
export function slugifyReaderName(raw: string): string {
  const slug = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (!slug) throw new Error('Please enter a name using at least one letter or number.');
  return slug;
}

/**
 * Plain-language rewrites of the failures a first-time reader actually hits.
 *
 * The error page used to print the raw exception, including zod output, which
 * is unreadable for the audience most likely to see it.
 */
export function plainError(error: unknown): { headline: string; detail: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (/not valid JSON/i.test(raw)) {
    return {
      headline: 'That does not look like the profile ChatGPT produced.',
      detail: 'Copy the part of its reply that starts with { and ends with }, then paste it again. Leaving in the surrounding sentences is fine — Sift will find the profile inside them.',
    };
  }
  if (/Invalid onboarding dossier/i.test(raw)) {
    return {
      headline: 'The profile from ChatGPT is missing something Sift needs.',
      detail: `Ask ChatGPT to output the whole JSON object again in one piece, then paste it. Technical detail: ${raw.replace(/^Invalid onboarding dossier:\s*/i, '')}`,
    };
  }
  if (/already exists/i.test(raw)) {
    return { headline: raw, detail: 'Pick a different name, or open the existing reader from the home page.' };
  }
  if (/expired/i.test(raw)) {
    return { headline: 'This page was open too long.', detail: 'Go back, reload, and enter your answers again. Nothing was saved.' };
  }
  if (/Configure an AI provider/i.test(raw)) {
    return { headline: 'Sift needs an AI service before it can find articles.', detail: 'Open step 1 on the dashboard and connect one. The free test run works without it.' };
  }
  // zod serialises its issues as a JSON array. That is unreadable for the
  // audience most likely to see it, so name the field and say what to do.
  if (raw.trimStart().startsWith('[') && /"code"|"path"/.test(raw)) {
    const paths = [...raw.matchAll(/"path":\s*\[([^\]]*)\]/g)]
      .map((match) => match[1]!.replace(/["\s]/g, '').split(',').filter(Boolean).join(' → '))
      .filter(Boolean);
    return {
      headline: 'Sift could not build a profile from that answer.',
      detail: paths.length > 0
        ? `The problem is in: ${paths.join('; ')}. Ask ChatGPT to regenerate its answer, or edit that part before pasting again.`
        : 'Ask ChatGPT to produce the whole answer again, then paste it.',
    };
  }
  return { headline: 'Something needs attention.', detail: raw };
}

/** Is the local feed server actually up? Copying a dead URL into a reader app
 * is the most common silent failure in the local publishing path. */
async function feedServerRunning(publicUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    try {
      const response = await fetch(`${publicUrl}/health`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Month-to-date AI spend for this reader, read from its own ledger. */
function spendThisMonth(databasePath: string): number | null {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return null;
  const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare(`SELECT SUM(estimated_cost) AS spent FROM api_usage WHERE created_at >= :start`).get({ start }) as { spent: number | null };
    db.close();
    return Number(row?.spent ?? 0);
  } catch {
    return null;
  }
}

/** The configured monthly target and hard limit for the active mode. */
function budgetLimits(projectRoot: string, home: string, profileId: string): { target: number; hardLimit: number } | null {
  const directory = profileDirectory(profileId, home);
  const path = existsSync(resolve(directory, 'budget.yaml'))
    ? resolve(directory, 'budget.yaml')
    : resolve(projectRoot, 'config', 'budget.yaml');
  try {
    const file = budgetFileSchema.parse(parseYaml(readFileSync(path, 'utf8')));
    const mode = file.modes[file.mode] ?? Object.values(file.modes)[0];
    if (!mode) return null;
    return { target: mode.monthly_target_usd, hardLimit: mode.monthly_hard_limit_usd };
  } catch {
    return null;
  }
}

export interface Pick {
  title: string;
  source: string;
  url: string | null;
  why: string | null;
  feed: string;
}

/**
 * The articles Sift most recently chose.
 *
 * Without this the dashboard never shows what the reader is actually getting:
 * you complete four technical steps and then have to leave for a separate RSS
 * app to find out whether any of it worked.
 */
function latestPicks(databasePath: string, limit = 6): Pick[] {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return [];
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const rows = db.prepare(
      `SELECT fi.title AS title,
              COALESCE(s.name, fi.source_id) AS source,
              COALESCE(fi.canonical_url, fi.original_url) AS url,
              MAX(p.why_it_surfaced) AS why,
              MAX(p.feed_id) AS feed
       FROM published_feed_items p
       JOIN feed_items fi ON fi.id = p.item_id
       LEFT JOIN sources s ON s.id = fi.source_id
       GROUP BY fi.id, fi.title, s.name, fi.source_id, fi.canonical_url, fi.original_url
       ORDER BY MAX(p.published_at) DESC
       LIMIT :limit`,
    ).all({ limit }) as unknown as Pick[];
    db.close();
    return rows;
  } catch {
    return [];
  }
}

const ATTENTION_WORDS: Record<string, string> = {
  under_15: 'under 15 minutes of reading a day',
  '15_30': '15 to 30 minutes of reading a day',
  '30_60': '30 to 60 minutes of reading a day',
  '60_plus': 'an hour or more of reading a day',
  variable: 'a reading budget that varies day to day',
};

const PAYWALL_WORDS: Record<string, string> = {
  free_only: 'skip anything behind a paywall',
  subscribed_publications: 'include paywalled articles only from publications you subscribe to',
  readable_only: 'include paywalled articles when they are normally readable',
  quality_first: 'favour the best writing, provided it is still readable',
};

const FRESHNESS_WORDS: Record<string, string> = {
  timely: 'mostly things published this week',
  balanced: 'a mix of this week and older work worth keeping',
  evergreen: 'the best writing regardless of when it appeared',
};

/**
 * The approval step in plain sentences.
 *
 * It used to render the compiled profile as a raw text dump, which the reader
 * could not meaningfully review -- so the required checkbox became a rubber
 * stamp and the approval boundary stopped meaning anything.
 */
export function humanProfileSummary(
  dossier: OnboardingDossier,
  preferences: ReaderPreferences,
  usedDefaults: boolean,
): string {
  const topics = dossier.interests
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5)
    .map((topic) => topic.label);
  const avoid = dossier.source_candidates.filter((candidate) => candidate.disposition === 'avoid').length;
  const favourites = dossier.source_candidates.filter((candidate) => candidate.disposition === 'known_favorite').length;
  const bullets: string[] = [];
  if (topics.length > 0) {
    bullets.push(`Look hardest for writing about <strong>${topics.map(escapeXml).join('</strong>, <strong>')}</strong>.`);
  }
  bullets.push(`Aim for about ${escapeXml(ATTENTION_WORDS[preferences.attention_budget] ?? preferences.attention_budget)}, and ${escapeXml(PAYWALL_WORDS[preferences.paywall_policy] ?? preferences.paywall_policy)}.`);
  bullets.push(`Prefer ${escapeXml(FRESHNESS_WORDS[preferences.freshness_balance] ?? preferences.freshness_balance)}.`);
  bullets.push(`Read in ${escapeXml(preferences.languages.join(', ') || 'English')}${preferences.non_primary_language_policy === 'never' ? ', and skip other languages' : preferences.non_primary_language_policy === 'exceptional_only' ? ', allowing other languages only when something is exceptional' : ', treating other languages equally'}.`);
  bullets.push(`Set aside roughly ${preferences.serendipity} in 10 of the surprise slots for things outside your usual interests.`);
  if (preferences.disliked_styles.length > 0) {
    bullets.push(`Avoid ${escapeXml(preferences.disliked_styles.join(', '))}.`);
  }
  if (favourites > 0 || avoid > 0) {
    bullets.push(`Noted ${favourites} publication${favourites === 1 ? '' : 's'} you already like${avoid > 0 ? ` and ${avoid} to steer clear of` : ''}. Suggested feeds stay switched off until you validate them.`);
  }
  return `<ul class="plain">${bullets.map((line) => `<li>${line}</li>`).join('')}</ul>${
    usedDefaults ? '<p class="hint">You skipped the preferences page, so these are Sift’s cautious defaults. You can change them later.</p>' : ''
  }<p class="hint">Nothing has been created yet. Approving below writes this reader’s private files on this Mac only.</p>`;
}

function progressHtml(progress: JobProgress): string {
  if (!progress.staged || progress.stages.length === 0) return '';
  const steps = progress.stages.map((stage) => `<li class="stage ${stage.state}">
    <span class="stage-mark" aria-hidden="true">${stage.state === 'done' ? '✓' : stage.state === 'active' ? '●' : ''}</span>
    <span class="stage-body"><strong>${escapeXml(stage.label)}</strong><span class="stage-hint">${escapeXml(stage.detail ?? stage.hint)}</span></span>
  </li>`).join('');
  return `<div class="progress" role="group" aria-label="Progress">
    <div class="bar"><div class="bar-fill" style="width:${progress.percent}%"></div></div>
    <p class="bar-label">${progress.completed} of ${progress.total} steps done</p>
    <ol class="stages">${steps}</ol>
  </div>`;
}

function page(title: string, body: string, options: { refresh?: number } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : ''}
<title>${escapeXml(title)} · Sift</title>
<style>
:root { color-scheme: light dark; --bg:#f4f2ed; --card:#fffdf8; --ink:#24231f; --muted:#726f66; --line:#ddd8ce; --accent:#315f4f; --accent2:#dce9e3; --warn:#9b4b31; }
@media (prefers-color-scheme:dark){:root{--bg:#171816;--card:#20221f;--ink:#f1eee6;--muted:#aaa69d;--line:#373a35;--accent:#8bc5af;--accent2:#293c35;--warn:#ed9b7d}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 20px 72px} nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}.brand{font:700 22px/1 Georgia,serif;letter-spacing:.02em}.navlinks{display:flex;gap:16px}
h1{font:700 clamp(30px,5vw,50px)/1.05 Georgia,serif;margin:0 0 12px;max-width:760px}h2{font:700 22px/1.2 Georgia,serif;margin:0 0 14px}h3{margin:0 0 8px}.lede{font-size:18px;color:var(--muted);max-width:720px;margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 1px 2px #0000000a}.hero{padding:28px;margin-bottom:20px}.stack>*+*{margin-top:16px}.muted{color:var(--muted)}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:700;color:var(--muted)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.button,button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:10px;padding:10px 14px;background:var(--accent);color:var(--card);font:600 14px/1.2 inherit;cursor:pointer;text-decoration:none}.button.secondary,button.secondary{background:var(--accent2);color:var(--ink)}.button.danger,button.danger{background:var(--warn);color:white}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
label{display:block;font-weight:650;margin-bottom:5px}.hint{font-size:13px;color:var(--muted);margin-top:4px}input[type=text],input[type=password],input[type=url],input[type=number],textarea,select{width:100%;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);padding:10px 11px;font:inherit}textarea{min-height:130px;resize:vertical}.json{min-height:320px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.prompt{min-height:260px}.field{margin-bottom:17px}.check{display:flex;gap:9px;align-items:flex-start}.check input{margin-top:5px}.check label{font-weight:500}
.metric{font:700 25px/1.1 Georgia,serif}.metric-label{color:var(--muted);font-size:12px;margin-top:4px}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:12px;color:var(--muted)}.good{color:var(--accent)}.warning{color:var(--warn)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#161815;color:#e9efe9;border-radius:12px;padding:16px;max-height:460px;overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.feed{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.feed:first-child{border-top:0}.feed code{font-size:12px;overflow-wrap:anywhere}.section{margin-top:28px}.error{border-color:var(--warn);color:var(--warn)}
.step{display:grid;grid-template-columns:34px 1fr;gap:12px}.step-number{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent2);font-weight:700}.step h2{margin-top:2px}.article-card h3{font:700 18px/1.3 Georgia,serif}.article-meta{font-size:12px;color:var(--muted);margin-bottom:8px}.rating{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px}.rating label{font-weight:550}.rating input{margin-right:5px}details{border-top:1px solid var(--line);padding:14px 0}details:first-of-type{border-top:0}summary{cursor:pointer;font-weight:700}button:disabled,.button.disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
.progress{margin:0}.bar{height:8px;border-radius:999px;background:var(--accent2);overflow:hidden}.bar-fill{height:100%;background:var(--accent);border-radius:999px;transition:width .4s ease}.bar-label{margin:8px 0 16px;font-size:13px;color:var(--muted)}
.stages{list-style:none;margin:0;padding:0}.stage{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;padding:9px 0;border-top:1px solid var(--line)}.stage:first-child{border-top:0}
.stage-mark{width:20px;height:20px;margin-top:2px;border-radius:50%;display:grid;place-items:center;font-size:11px;border:1px solid var(--line);color:var(--card);background:var(--line)}
.stage.done .stage-mark{background:var(--accent);border-color:var(--accent)}.stage.active .stage-mark{background:var(--card);border-color:var(--accent);color:var(--accent);animation:pulse 1.4s ease-in-out infinite}
.stage-body{display:flex;flex-direction:column;gap:2px}.stage-hint{font-size:13px;color:var(--muted)}
.stage.pending .stage-body strong{color:var(--muted);font-weight:600}.stage.active .stage-body strong{color:var(--accent)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){.stage.active .stage-mark{animation:none}.bar-fill{transition:none}}
ul.plain{margin:0 0 4px;padding-left:20px}ul.plain li{margin-bottom:8px}ol.plain-steps{margin:0 0 16px;padding-left:20px}ol.plain-steps li{margin-bottom:8px}
.medium-row{display:grid;grid-template-columns:1fr 200px;gap:10px;margin-bottom:8px}
.pick{padding:14px 0;border-top:1px solid var(--line)}.pick:first-of-type{border-top:0}.pick h3{font:700 17px/1.3 Georgia,serif;margin:0 0 4px}.pick p{margin:0 0 4px}
@media(max-width:640px){.medium-row{grid-template-columns:1fr}}
</style></head><body><main><nav><a class="brand" href="/">Sift</a><div class="navlinks"><a href="/">Your readers</a><a href="/onboarding">Add a reader</a></div></nav>${body}</main>
<script>document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{await navigator.clipboard.writeText(document.querySelector(b.dataset.copy).value||document.querySelector(b.dataset.copy).textContent);const old=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=old,1200)}));document.querySelectorAll('[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!confirm(f.dataset.confirm))e.preventDefault()}));</script>
</body></html>`;
}

function errorPage(error: unknown): string {
  const { headline, detail } = plainError(error);
  const raw = error instanceof Error ? error.message : String(error);
  // The original message is kept, but folded away: it is useful when something
  // genuinely unexpected happens and useless noise the rest of the time.
  const technical = raw === headline || raw === detail
    ? ''
    : `<details><summary>Technical detail</summary><p class="muted">${escapeXml(raw)}</p></details>`;
  return page('Something needs attention', `<div class="card error"><p class="eyebrow">Could not continue</p><h2>${escapeXml(headline)}</h2><p>${escapeXml(detail)}</p>${technical}<p><a href="javascript:history.back()">Go back</a></p></div>`);
}

export function createUiApp(options: UiAppOptions = {}): Hono {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const home = options.home ?? options.projectRoot ?? resolveHome();
  const csrf = options.csrfToken ?? randomBytes(24).toString('base64url');
  const runner = options.jobRunner ?? new UiJobRunner(projectRoot, home);
  const drafts = new Map<string, Draft>();
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    await next();
  });

  const parseForm = async (c: Context) => {
    const body = await c.req.parseBody() as Record<string, string | File>;
    if (field(body, 'csrf') !== csrf) throw new Error('This form expired. Reload the page and try again.');
    return body;
  };

  app.get('/', (c) => {
    const profiles = profileIds(home).map((id) => profileSummary(projectRoot, home, id));
    const cards = profiles.length > 0
      ? profiles.map((profile) => `<article class="card stack"><div><span class="pill">${profile.databaseExists ? 'ready' : 'needs setup'}</span><h2 style="margin-top:10px">${escapeXml(profile.id)}</h2><p class="muted">${profile.items.toLocaleString()} articles looked at · ${profile.placements.toLocaleString()} chosen</p></div><a class="button secondary" href="/profile/${encodeURIComponent(profile.id)}">Open dashboard</a></article>`).join('')
      : '<div class="card"><h2>No readers yet</h2><p class="muted">A reader is one person\u2019s set of feeds. Add one to get started \u2014 it takes about five minutes.</p><a class="button" href="/onboarding">Add a reader</a></div>';
    return c.html(page('Sift Home', `<section class="card hero"><p class="eyebrow">Private discovery on your Mac</p><h1>Good things from the internet, without the feed treadmill.</h1><p class="lede">Sift reads far more than you can and passes on only what you would be glad to have found. Everything runs on this Mac.</p><div class="actions"><a class="button" href="/onboarding">Add a reader</a></div></section><section class="section"><h2>Readers</h2><div class="grid">${cards}</div></section>`));
  });

  app.get('/onboarding', (c) => {
    const prompt = readFileSync(resolve(projectRoot, 'onboarding', 'chatgpt-profile-prompt.md'), 'utf8');
    return c.html(page('Add a reader', `<p class="eyebrow">Step 1 of 3</p><h1>Tell Sift what you like to read.</h1><p class="lede">The quickest way is to let ChatGPT describe your taste for you. It takes about two minutes, and your chat history never enters Sift — only the summary you paste below.</p>
      <div class="card stack"><ol class="plain-steps">
      <li><strong>Copy the question below</strong> and paste it into ChatGPT.</li>
      <li><strong>Answer anything it asks.</strong> It may ask up to three short questions.</li>
      <li><strong>Copy its final answer</strong> and paste the whole thing into the second box here. Sift will pick out the part it needs.</li>
      </ol><div class="actions"><button type="button" class="secondary" data-copy="#assistant-prompt">Copy ChatGPT prompt</button><a class="button secondary" href="https://chatgpt.com" target="_blank" rel="noopener noreferrer">Open ChatGPT ↗</a></div>
      <details><summary>See the question Sift will ask ChatGPT</summary><textarea id="assistant-prompt" class="prompt" readonly>${escapeXml(prompt)}</textarea></details></div>
      <form class="card section" method="post" action="/onboarding/dossier">${hiddenCsrf(csrf)}
      <div class="field"><label for="profile_id">Who is this reading feed for?</label><input id="profile_id" name="profile_id" type="text" placeholder="Alice" maxlength="80" required><p class="hint">Just a label so you can tell readers apart. Type it however you like.</p></div>
      <div class="field"><label for="dossier">Paste ChatGPT’s answer</label><textarea id="dossier" name="dossier" class="json" placeholder="Paste the whole reply here. It should contain a block starting with {" required></textarea><p class="hint">Pasting the surrounding sentences is fine. If ChatGPT split its answer, paste the part containing the curly braces.</p></div>
      <button type="submit">Continue →</button></form>`));
  });

  app.post('/onboarding/dossier', async (c) => {
    try {
      const body = await parseForm(c);
      const profileId = validateProfileId(slugifyReaderName(field(body, 'profile_id')));
      if (existsSync(resolve(profileDirectory(profileId, home), 'taste-profile.yaml'))) throw new Error(`Profile “${profileId}” already exists.`);
      const dossier = parseDossier(field(body, 'dossier'));
      const proposed = suggestedReaderPreferences(dossier.assistant_preference_hints);
      const id = randomUUID();
      drafts.set(id, { profileId, dossier });
      return c.html(page('Reading preferences', `<p class="eyebrow">Step 2 of 3</p><h1>Set the practical reading rules.</h1><p class="lede">ChatGPT suggestions are prefilled when confidence is adequate. These choices belong to Sift and remain editable.</p><form class="card" method="post" action="/onboarding/preview">${hiddenCsrf(csrf)}<input type="hidden" name="draft_id" value="${id}">
      <div class="check field"><input id="skip_preferences" name="skip_preferences" type="checkbox"><label for="skip_preferences">Skip this page and use conservative Sift defaults</label></div>
      <div class="grid"><div class="field"><label>Reading capacity</label><select name="attention_budget">${option('under_15','Under 15 minutes/day',proposed.attention_budget)}${option('15_30','15–30 minutes/day',proposed.attention_budget)}${option('30_60','30–60 minutes/day',proposed.attention_budget)}${option('60_plus','60+ minutes/day',proposed.attention_budget)}${option('variable','Highly variable',proposed.attention_budget)}</select></div>
      <div class="field"><label>Article length</label><select name="article_length">${option('mostly_short','Mostly short',proposed.article_length)}${option('medium','Mostly medium',proposed.article_length)}${option('long_when_exceptional','Long when exceptional',proposed.article_length)}${option('any','Any length',proposed.article_length)}</select></div>
      <div class="field"><label>Paywalls</label><select name="paywall_policy">${option('free_only','Free only',proposed.paywall_policy)}${option('subscribed_publications','My subscriptions when readable',proposed.paywall_policy)}${option('readable_only','Anything normally readable',proposed.paywall_policy)}${option('quality_first','Quality first, still readable',proposed.paywall_policy)}</select></div>
      <div class="field"><label>Freshness</label><select name="freshness_balance">${option('timely','Mostly this week',proposed.freshness_balance)}${option('balanced','Timely + evergreen',proposed.freshness_balance)}${option('evergreen','Best regardless of age',proposed.freshness_balance)}</select></div>
      <div class="field"><label>Languages</label><input name="languages" type="text" value="${escapeXml(proposed.languages.join(', '))}"><p class="hint">Names or codes, comma-separated.</p></div>
      <div class="field"><label>Other languages</label><select name="non_primary_language_policy">${option('never','Never',proposed.non_primary_language_policy)}${option('exceptional_only','Only when exceptional',proposed.non_primary_language_policy)}${option('equal','Treat equally',proposed.non_primary_language_policy)}</select></div>
      <div class="field"><label>Serendipity: <output id="serendipity-value">${proposed.serendipity}</output>/10</label><input name="serendipity" type="range" min="0" max="10" step="1" value="${proposed.serendipity}" oninput="document.querySelector('#serendipity-value').value=this.value"></div>
      <div class="field"><label>Maximum evergreen age</label><input name="max_evergreen_age_days" type="number" min="1" value="${proposed.max_evergreen_age_days ?? ''}" placeholder="No limit"></div></div>
      <div class="field"><label>Subscribed publications</label><input name="subscribed_publications" type="text" value="${escapeXml(proposed.subscribed_publications.join(', '))}" placeholder="Publication A, Publication B"></div>
      <div class="field"><label>Preferred writing voices</label><input name="writing_voices" type="text" value="${escapeXml(proposed.writing_voices.join(', '))}" placeholder="concise, investigative, dryly funny"></div>
      <div class="field"><label>Styles to avoid</label><input name="disliked_styles" type="text" value="${escapeXml(proposed.disliked_styles.join(', '))}" placeholder="breathless hype, generic advice"></div>
      <div class="field"><label>Subjects you would rather watch or listen to</label><p class="hint">Optional. Leave blank if you have no preference.</p>${mediumRowsHtml(proposed.medium_preferences)}</div>
      <button type="submit">Build profile preview →</button></form>`));
    } catch (error) {
      return c.html(errorPage(error), 400);
    }
  });

  app.post('/onboarding/preview', async (c) => {
    try {
      const body = await parseForm(c);
      const draft = drafts.get(field(body, 'draft_id'));
      if (!draft) throw new Error('This onboarding draft expired. Start again.');
      const skipped = checked(body, 'skip_preferences');
      draft.preferences = skipped ? defaultReaderPreferences() : preferencesFromForm(body);
      draft.preferenceStatus = skipped ? 'defaults' : 'completed';
      // Compile here, purely to validate. createProfile compiles for real at the
      // final click, and a failure there lands after the reader has approved --
      // which is exactly where a short example title used to strand them. This
      // writes nothing; it just moves the error before the point of no return.
      compileTasteProfile(draft.dossier, draft.preferences);
      const preview = renderProfilePreview(draft.dossier, draft.preferences, draft.preferenceStatus);
      return c.html(page('Approve profile', `<p class="eyebrow">Step 3 of 3</p><h1>Here is what Sift will do for you.</h1><p class="lede">Check this reads like you. Nothing has been saved yet — no files, no feeds, no account anywhere.</p><div class="card">${humanProfileSummary(draft.dossier, draft.preferences, draft.preferenceStatus === 'defaults')}<details><summary>See the full technical profile</summary><pre>${escapeXml(preview)}</pre></details></div><form class="card section" method="post" action="/onboarding/create">${hiddenCsrf(csrf)}<input type="hidden" name="draft_id" value="${escapeXml(field(body, 'draft_id'))}"><div class="check field"><input id="approval" name="approval" value="approve" type="checkbox" required><label for="approval">This looks right — create this reader on my Mac.</label></div><button type="submit">Create reader →</button></form>`));
    } catch (error) {
      return c.html(errorPage(error), 400);
    }
  });

  app.post('/onboarding/create', async (c) => {
    try {
      const body = await parseForm(c);
      if (field(body, 'approval') !== 'approve') throw new Error('Approval is required before profile creation.');
      const draftId = field(body, 'draft_id');
      const draft = drafts.get(draftId);
      if (!draft?.preferences || !draft.preferenceStatus) throw new Error('This onboarding draft expired. Start again.');
      createProfile({
        projectRoot,
        profileId: draft.profileId,
        dossier: draft.dossier,
        preferences: draft.preferences,
        preferencesStatus: draft.preferenceStatus,
        approved: true,
        skipCalibration: false,
      });
      drafts.delete(draftId);
      return c.redirect(`/profile/${encodeURIComponent(draft.profileId)}`, 303);
    } catch (error) {
      return c.html(errorPage(error), 400);
    }
  });

  app.get('/profile/:id', async (c) => {
    try {
      const id = validateProfileId(c.req.param('id'));
      const profile = profileSummary(projectRoot, home, id);
      const feeds = feedSlugs(projectRoot, home, id);
      const token = profile.token && profile.token !== 'change-me-please' ? `?t=${encodeURIComponent(profile.token)}` : '';
      const latest = runner.latest(id);
      const running = runner.running(id);
      const service = serviceState(id);
      const picks = latestPicks(profile.databasePath);
      const spent = spendThisMonth(profile.databasePath);
      const limits = budgetLimits(projectRoot, home, id);
      const spendLabel = spent === null ? '—' : `$${spent.toFixed(2)}`;
      const spendCaption = spent === null
        ? 'spent on AI this month'
        : limits
          ? `spent on AI this month · stops at $${limits.hardLimit}`
          : 'spent on AI this month';
      // Said before the key is saved, not after the bill arrives.
      const budgetNote = limits
        ? `<p class="muted">Sift aims to stay under <strong>$${limits.target} a month</strong> and stops spending entirely at <strong>$${limits.hardLimit}</strong>. You pay the AI service directly; Sift takes nothing.</p>`
        : '';
      const feedRows = feeds.map((feed, index) => {
        const url = `${profile.publicUrl}/feed/${feed.slug}.xml${token}`;
        return `<div class="feed"><div><strong>${escapeXml(feed.title)}</strong><br><code id="feed-${index}">${escapeXml(url)}</code></div><button type="button" class="secondary" data-copy="#feed-${index}">Copy</button></div>`;
      }).join('');
      const saved = c.req.query('saved') === 'ai'
        ? '<div class="card good"><strong>AI settings saved.</strong> The API key was not returned to this page.</div>'
        : c.req.query('saved') === 'calibration'
          ? '<div class="card good"><strong>Article feedback saved.</strong> Sift will use the positive and negative examples on future runs.</div>'
          : '';
      const localPublishing = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(profile.publicUrl);
      // Copying a URL that nothing is serving is the quietest failure in the
      // whole product: the reader app just shows an empty feed and says nothing.
      const serverUp = localPublishing ? await feedServerRunning(profile.publicUrl) : true;
      // One sentence answering "what do I do now?", which is the only thing a
      // first-time reader wants from a dashboard.
      const statusText = !profile.databaseExists
        ? 'First: set up storage in step 2 below.'
        : !profile.aiReady
          ? 'Next: connect an AI service in step 1 below. Nothing can be found until you do.'
          : profile.placements === 0
            ? 'Next: run “Find articles” in step 2 below. It takes a few minutes.'
            : localPublishing && !serverUp
              ? 'Sift has chosen articles for you. Start the feed server in step 4 to read them.'
              : profile.calibration === 'completed'
                ? 'All set. Sift keeps looking each time you run it.'
                : 'All set. Rate a few articles in step 3 to make the picks better.';
      const providerOptions = [
        option('openai', 'OpenAI — recommended', profile.provider),
        '<optgroup label="Already use one of these?">',
        option('ollama', 'Ollama — runs on this Mac, no key, no cost', profile.provider),
        option('openrouter', 'OpenRouter', profile.provider),
        option('groq', 'Groq', profile.provider),
        option('gemini', 'Google Gemini', profile.provider),
        option('anthropic', 'Anthropic-compatible endpoint', profile.provider),
        option('custom', 'Custom OpenAI-compatible endpoint', profile.provider),
        '</optgroup>',
      ].join('');
      const serveCommand = `npm run serve -- --profile ${id}`;
      const exportCommand = `npm run export -- --profile ${id}`;
      return c.html(page(`${id} dashboard`, `<p class="eyebrow">Reader</p><h1>${escapeXml(id)}</h1><p class="lede">${escapeXml(statusText)}</p>${saved}
      <div class="grid"><div class="card"><div class="metric">${profile.items.toLocaleString()}</div><div class="metric-label">articles Sift looked at</div></div><div class="card"><div class="metric">${profile.placements.toLocaleString()}</div><div class="metric-label">articles it chose for you</div></div><div class="card"><div class="metric">${spendLabel}</div><div class="metric-label">${escapeXml(spendCaption)}</div></div></div>

      ${picks.length > 0 ? `<section class="section card"><h2>Latest picks for you</h2><p class="muted">The most recent articles Sift chose. This is what lands in your reading app.</p>${picks.map((pick) => `<article class="pick"><h3>${pick.url ? `<a href="${escapeXml(safeHttpUrl(pick.url) ?? '#')}" target="_blank" rel="noopener noreferrer">${escapeXml(pick.title)} ↗</a>` : escapeXml(pick.title)}</h3><p class="article-meta">${escapeXml(pick.source)}${pick.feed ? ` · ${escapeXml(pick.feed)}` : ''}</p>${pick.why ? `<p class="muted">${escapeXml(pick.why)}</p>` : ''}</article>`).join('')}</section>` : ''}

      <section class="section card step"><div class="step-number">1</div><div><h2>Connect an AI service</h2><p class="muted">Sift pays a small amount to an AI service to read and judge articles for you. ${profile.aiReady ? '<span class="good">Connected and ready.</span>' : '<span class="warning">Not connected yet — Sift cannot find articles until this is done.</span>'} Your key is written only to this reader’s private settings file on this Mac; Sift never shows it again, not even in job logs.</p>
      ${budgetNote}
      ${profile.aiReady ? '' : `<details open><summary>How to get an OpenAI key (about 5 minutes)</summary><ol class="plain-steps"><li>Go to <a href="https://platform.openai.com/signup" target="_blank" rel="noopener noreferrer">platform.openai.com</a> and sign in or create an account.</li><li>Add a payment method under <strong>Billing</strong>. This is separate from a ChatGPT Plus subscription — having Plus does not give you a key.</li><li>Open <strong>API keys</strong>, choose <strong>Create new secret key</strong>, and copy it.</li><li>Paste it below and save. It starts with <code>sk-</code>.</li></ol></details>`}
      <form method="post" action="/profile/${id}/ai">${hiddenCsrf(csrf)}
      <div class="grid"><div class="field"><label for="provider">AI service</label><select id="provider" name="provider">${providerOptions}</select><p class="hint">OpenAI is the usual choice. The others are for people who already use them.</p></div><div class="field"><label for="api_key">API key</label><input id="api_key" name="api_key" type="password" autocomplete="new-password" spellcheck="false" placeholder="${profile.aiKeyConfigured ? 'Configured — leave blank to keep it' : 'Paste only if this provider requires one'}"><p class="hint">${profile.aiKeyConfigured ? 'A key is configured. Its value is deliberately never shown.' : 'Ollama runs on your Mac and needs no key. Every other option needs one.'}</p></div></div>
      <div class="check field"><input id="clear_api_key" name="clear_api_key" type="checkbox"><label for="clear_api_key">Remove the saved key for the selected provider</label></div>
      <details><summary>Advanced: model names and custom endpoint</summary><div class="grid section"><div class="field"><label>Triage model</label><input name="triage_model" type="text" value="${escapeXml(profile.triageModel)}"></div><div class="field"><label>Deep-ranking model</label><input name="deep_model" type="text" value="${escapeXml(profile.deepModel)}"></div><div class="field"><label>Embedding model</label><input name="embedding_model" type="text" value="${escapeXml(profile.embeddingModel)}"></div><div class="field"><label>Custom base URL</label><input name="base_url" type="url" value="${escapeXml(profile.baseUrl)}" placeholder="https://provider.example/v1"><p class="hint">Used only with Custom. Ollama uses its local default.</p></div></div></details>
      <button type="submit">Save</button></form></div></section>

      <section class="section card step"><div class="step-number">2</div><div><h2>Find articles</h2><p class="muted">The test run is free and checks that everything is wired up. The real run reads and ranks articles, and is the one that uses your AI credit.</p><div class="actions">
      ${!profile.databaseExists ? `<form method="post" action="/profile/${id}/action">${hiddenCsrf(csrf)}<input type="hidden" name="action" value="db_setup"><button type="submit"${running ? ' disabled title="A run is already in progress"' : ''}>${escapeXml(ACTIONS.db_setup.label)}</button></form>` : ''}
      <form method="post" action="/profile/${id}/action">${hiddenCsrf(csrf)}<input type="hidden" name="action" value="pipeline_dry"><button class="secondary" type="submit"${running ? ' disabled title="A run is already in progress"' : ''}>${escapeXml(ACTIONS.pipeline_dry.label)} — free</button></form>
      <form method="post" action="/profile/${id}/action" data-confirm="Start a real run now? This spends a small amount with your AI service.">${hiddenCsrf(csrf)}<input type="hidden" name="action" value="pipeline"><button type="submit"${running ? ' disabled title="A run is already in progress"' : profile.aiReady ? '' : ' disabled title="Connect an AI service first"'}>${escapeXml(ACTIONS.pipeline.label)} now — uses AI credit</button></form>
      ${profile.sourceCandidates > 0 ? `<form method="post" action="/profile/${id}/action">${hiddenCsrf(csrf)}<input type="hidden" name="action" value="source_discover"><button class="secondary" type="submit"${running ? ' disabled title="A run is already in progress"' : ''}>${escapeXml(ACTIONS.source_discover.label)}</button></form>` : ''}
      ${profile.validatedFeeds > 0 ? `<a class="button" href="/profile/${id}/sources">Review ${profile.validatedFeeds} suggested source${profile.validatedFeeds === 1 ? '' : 's'} →</a>` : ''}
      </div>${running
        ? `<p class="hint"><strong>${escapeXml(running.label)} is running now.</strong> <a href="/job/${running.id}">Watch it →</a> Sift runs one job at a time for each reader.</p>`
        : latest ? `<p class="hint">Last run: <a href="/job/${latest.id}">${escapeXml(latest.label)} — ${escapeXml(latest.status)}</a></p>` : ''}</div></section>

      <section class="section card step"><div class="step-number">3</div><div><h2>Teach it what you liked <span class="pill">optional</span></h2>${profile.placements > 0
        ? `<p class="muted">Read a few of the articles above, then tell Sift which were worth your time. It uses your answers to choose better next time.</p><a class="button secondary" href="/profile/${id}/calibration">${profile.calibration === 'completed' ? 'Rate more articles' : 'Rate what you read'}</a>`
        : '<p class="muted">Available once Sift has chosen some articles for you. Run “Find articles” above first.</p><span class="button secondary disabled">Waiting for your first articles</span>'}</div></section>

      <section class="section card step"><div class="step-number">4</div><div><h2>Publish and subscribe</h2><p class="muted">${profile.cloudflareConfigured ? '<span class="good">Publishing through Cloudflare — your feeds stay available even when this Mac sleeps.</span>' : localPublishing ? 'Your feeds are served from this Mac. That is the simplest way to start; move to Cloudflare later if you want them available while the Mac sleeps.' : 'A remote address is configured. Check it is running before subscribing.'}</p>
      <details open><summary>On this Mac — start here</summary><p>${serverUp
        ? '<span class="good">The feed server is running.</span> The links below work now. Paste one into your reading app (Reeder, NetNewsWire, Feedly — anything that takes an RSS address).'
        : '<span class="warning">The feed server is not running.</span> The links below will not work until you start it. Open Terminal, paste the command, and leave that window open.'}</p><div class="actions"><code id="serve-command">${escapeXml(serveCommand)}</code><button type="button" class="secondary" data-copy="#serve-command">Copy command</button></div><p class="hint">Other devices on your network can subscribe only while this Mac is awake and reachable.</p></details>
      <details><summary>Later: Cloudflare, so feeds work while the Mac sleeps</summary><p>Cloudflare keeps the RSS URLs reachable when your Mac sleeps; the Mac still does discovery and ranking when you run or schedule Sift.</p><ol><li>From <code>worker/</code>, run <code>npx wrangler login</code>, create the SIFT_FEEDS KV namespace and <code>sift-events</code> D1 database, then deploy the Worker.</li><li>Put the returned namespace id and Worker URL in this profile’s private <code>.env</code>. Use <code>wrangler secret put</code> for the feed token—never place it in a shell command, chat, or committed file.</li><li>Preview with <code>npm run push -- --profile ${escapeXml(id)} --dry</code>, then upload with <code>npm run push -- --profile ${escapeXml(id)}</code>.</li></ol><p class="hint">Full commands and the worker configuration are in README → Deployment.</p></details>
      
      <details><summary>Static hosting</summary><p>Export feed files, then upload the generated directory to GitHub Pages, Cloudflare Pages, a NAS, or another static host.</p><div class="actions"><code id="export-command">${escapeXml(exportCommand)}</code><button type="button" class="secondary" data-copy="#export-command">Copy command</button></div></details>
      </div></section>

      ${service.supported ? `<section class="section card step"><div class="step-number">5</div><div><h2>Keep Sift running</h2><p class="muted">${service.installed
        ? service.running
          ? '<span class="good">Sift is running in the background.</span> It starts when you log in, keeps your feeds available, and restarts itself if it stops. You can close this window.'
          : '<span class="warning">Set up to run in the background, but not running right now.</span>'
        : 'Right now Sift only runs while a Terminal window is open. Turning this on keeps it running quietly in the background, starting again whenever you log in.'}</p>
      <form method="post" action="/profile/${id}/action"${service.installed ? ' data-confirm="Stop running Sift in the background? Your feeds stop updating until you start it again."' : ''}>${hiddenCsrf(csrf)}<input type="hidden" name="action" value="${service.installed ? 'service_uninstall' : 'service_install'}"><button type="submit"${service.installed ? ' class="secondary"' : ''}${running ? ' disabled title="A run is already in progress"' : ''}>${escapeXml(service.installed ? ACTIONS.service_uninstall.label : ACTIONS.service_install.label)}</button></form></div></section>` : ''}

      <section class="section card"><h2>Your feed links</h2><p class="muted">Paste any of these into a reading app to subscribe. Each link contains a private key — treat it like a password and do not post it anywhere.</p>${localPublishing && !serverUp ? '<p class="warning">Start the feed server first (step 4) or these links will return nothing.</p>' : ''}${feedRows}</section>
      <section class="section card"><h2>Advanced</h2><p class="muted">Stored at ${escapeXml(profile.databasePath)}</p><div class="actions"><form method="post" action="/profile/${id}/action">${hiddenCsrf(csrf)}<input type="hidden" name="action" value="doctor"><button class="secondary" type="submit"${running ? ' disabled title="A run is already in progress"' : ''}>${escapeXml(ACTIONS.doctor.label)}</button></form><a class="button secondary" href="${escapeXml(`${profile.publicUrl}/admin${token}`)}">Open diagnostics</a></div></section>`));
    } catch (error) {
      return c.html(errorPage(error), 404);
    }
  });

  app.post('/profile/:id/ai', async (c) => {
    try {
      const id = validateProfileId(c.req.param('id'));
      const body = await parseForm(c);
      const provider = field(body, 'provider').trim().toLowerCase();
      if (!PROVIDERS.includes(provider as Provider)) throw new Error('Choose a supported AI provider.');
      const selected = provider as Provider;
      const apiKey = safeEnvValue(field(body, 'api_key'), 'API key');
      const baseUrl = safeEnvValue(field(body, 'base_url'), 'Base URL');
      if (selected === 'custom' && !baseUrl) throw new Error('Custom provider requires a base URL.');
      if (selected === 'custom') {
        const parsed = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Custom base URL must use HTTP or HTTPS.');
      }
      const updates: Record<string, string> = {
        SIFT_AI_PROVIDER: selected,
        SIFT_TRIAGE_MODEL: safeEnvValue(field(body, 'triage_model'), 'Triage model', 200),
        SIFT_DEEP_MODEL: safeEnvValue(field(body, 'deep_model'), 'Deep model', 200),
        SIFT_EMBEDDING_MODEL: safeEnvValue(field(body, 'embedding_model'), 'Embedding model', 200),
        OPENAI_BASE_URL: selected === 'custom' ? baseUrl : '',
      };
      const keyName = providerKeyName(selected);
      if (keyName && (apiKey || checked(body, 'clear_api_key'))) updates[keyName] = checked(body, 'clear_api_key') ? '' : apiKey;
      updateEnv(resolve(profileDirectory(id, home), '.env'), updates);
      return c.redirect(`/profile/${encodeURIComponent(id)}?saved=ai`, 303);
    } catch (error) {
      return c.html(errorPage(error), 400);
    }
  });

  app.post('/profile/:id/action', async (c) => {
    try {
      const id = validateProfileId(c.req.param('id'));
      const body = await parseForm(c);
      const action = field(body, 'action') as UiAction;
      if (!['db_setup', 'pipeline_dry', 'pipeline', 'source_discover', 'doctor', 'service_install', 'service_uninstall'].includes(action)) throw new Error('Unsupported action.');
      if (action === 'pipeline' && !profileSummary(projectRoot, home, id).aiReady) {
        throw new Error('Configure an AI provider and API key before running a real recommendation update.');
      }
      const job = runner.start(id, action);
      return c.redirect(`/job/${job.id}`, 303);
    } catch (error) {
      // Show the run that is already going rather than refusing with no exit.
      if (error instanceof JobBusyError) return c.redirect(`/job/${error.job.id}?busy=1`, 303);
      return c.html(errorPage(error), 400);
    }
  });

  app.post('/job/:id/stop', async (c) => {
    try {
      const body = await parseForm(c);
      void body;
      const job = runner.get(c.req.param('id'));
      if (!job) throw new Error('That run no longer exists.');
      runner.stop(job.id);
      return c.redirect(`/job/${job.id}`, 303);
    } catch (error) {
      return c.html(errorPage(error), 400);
    }
  });

  /** Everything the job page needs, so it can update without reloading. */
  const jobView = (jobId: string) => {
    const job = runner.get(jobId);
    if (!job) return null;
    const profile = profileSummary(projectRoot, home, job.profileId);
    const progress = readJobProgress(profile.databasePath, {
      staged: job.action === 'pipeline' || job.action === 'pipeline_dry',
      startedAt: new Date(job.startedAt).getTime(),
    });
    const elapsed = Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000);
    const takes = ACTIONS[job.action]?.takes;
    const status = job.status === 'running'
      ? `Running for ${elapsed < 90 ? `${elapsed} seconds` : `${Math.round(elapsed / 60)} minutes`}${takes ? ` · usually takes ${takes}` : ''}.`
      : job.status === 'succeeded'
        ? 'Finished successfully.'
        : `Stopped with exit code ${job.exitCode ?? 1}. The details below say why.`;
    return { job, progress, status };
  };

  // Polled by the job page. Same-origin, so the page's own CSP allows it.
  app.get('/job/:id/progress', (c) => {
    const view = jobView(c.req.param('id'));
    if (!view) return c.json({ error: 'not found' }, 404);
    return c.json({
      status: view.job.status,
      statusText: view.status,
      progressHtml: progressHtml(view.progress),
      output: view.job.output || 'Starting…',
      done: view.job.status !== 'running',
    });
  });

  app.get('/job/:id', (c) => {
    const view = jobView(c.req.param('id'));
    if (!view) return c.html(errorPage('That run no longer exists. It may have finished before Sift restarted.'), 404);
    const { job, progress, status } = view;
    const busy = c.req.query('busy') === '1';
    const banner = busy && job.status === 'running'
      ? '<div class="card"><strong>This is already running.</strong> Sift runs one job at a time for each reader, so it brought you here rather than starting a second one. When it finishes you can start the next step.</div>'
      : '';
    // The log is the least useful thing on this page for most readers, so it is
    // present but folded away rather than being the whole page.
    return c.html(page(job.label, `<p class="eyebrow" id="job-state">${escapeXml(job.status)}</p><h1>${escapeXml(job.label)}</h1><p class="lede" id="job-status">${escapeXml(status)}</p>${banner}
      <div class="card" id="job-progress">${progressHtml(progress)}</div>
      <details class="section"><summary>Technical output</summary><pre id="job-output">${escapeXml(job.output || 'Starting…')}</pre></details>
      <div class="actions"><a class="button secondary" href="/profile/${encodeURIComponent(job.profileId)}">Back to ${escapeXml(job.profileId)}</a>${job.status === 'running' ? `<form method="post" action="/job/${encodeURIComponent(job.id)}/stop" data-confirm="Stop this run? Nothing already saved is lost.">${hiddenCsrf(csrf)}<button class="danger" type="submit">Stop this run</button></form>` : ''}</div>
      ${job.status === 'running' ? `<script>
      (function(){
        var id=${JSON.stringify(job.id)};
        // Updates in place rather than reloading, so the page does not jump
        // while the reader is reading it.
        function tick(){
          fetch('/job/'+encodeURIComponent(id)+'/progress',{headers:{accept:'application/json'}})
            .then(function(r){return r.ok?r.json():null})
            .then(function(d){
              if(!d)return;
              document.getElementById('job-state').textContent=d.status;
              document.getElementById('job-status').textContent=d.statusText;
              document.getElementById('job-progress').innerHTML=d.progressHtml;
              document.getElementById('job-output').textContent=d.output;
              if(d.done){location.reload();return}
              setTimeout(tick,2000);
            })
            .catch(function(){setTimeout(tick,4000)});
        }
        setTimeout(tick,2000);
      })();
      </script>` : ''}`));
  });

  app.get('/profile/:id/calibration', (c) => {
    try {
      const id = validateProfileId(c.req.param('id'));
      const directory = profileDirectory(id, home);
      if (!existsSync(resolve(directory, 'taste-profile.yaml'))) throw new Error('Profile not found.');
      const profile = profileSummary(projectRoot, home, id);
      if (!profile.databaseExists) throw new Error('Run the first recommendation update before calibrating.');
      const db = new DatabaseSync(profile.databasePath, { readOnly: true });
      const items = rankedCalibrationItems(db);
      db.close();
      if (items.length === 0) throw new Error(`Sift has not chosen any articles yet. Press “${ACTIONS.pipeline.label}” on the dashboard first, then come back once you have read a few.`);
      const previous = new Map<string, RankedCalibrationLabel>();
      const calibrationPath = resolve(directory, 'calibration.json');
      if (existsSync(calibrationPath)) {
        try {
          const saved = JSON.parse(readFileSync(calibrationPath, 'utf8')) as RankedCalibrationAnswers;
          for (const answer of saved.answers ?? []) previous.set(answer.item_id, answer.label);
        } catch {
          // A malformed old calibration file should not block a fresh review.
        }
      }
      const cards = items.map((item, index) => {
        const url = safeHttpUrl(item.url);
        const selected = previous.get(item.item_id) ?? 'not_read';
        const radio = (value: RankedCalibrationLabel, label: string) => `<label><input type="radio" name="rating_${index}" value="${value}"${selected === value ? ' checked' : ''}> ${label}</label>`;
        return `<article class="card article-card"><input type="hidden" name="item_${index}" value="${escapeXml(item.item_id)}"><p class="article-meta">${index + 1} of ${items.length} · ${escapeXml(item.source)} · ranked ${Math.round(item.score * 100)}%</p><h3>${url ? `<a href="${escapeXml(url)}" target="_blank" rel="noopener noreferrer">${escapeXml(item.title)} ↗</a>` : escapeXml(item.title)}</h3>${item.why_it_surfaced ? `<p class="muted">Why Sift chose it: ${escapeXml(item.why_it_surfaced)}</p>` : ''}<div class="rating">${radio('glad', 'Glad I read it')}${radio('fine', 'Fine')}${radio('not_for_me', 'Not for me')}${radio('not_read', 'Not read yet')}</div></article>`;
      }).join('');
      return c.html(page('Calibration', `<p class="eyebrow">Optional · after ranking</p><h1>Judge the real recommendations.</h1><p class="lede">Open anything you have not read, then rate the actual article—not its premise. Unread items do not affect Sift. You can return after reading more.</p><form class="stack" method="post" action="/profile/${id}/calibration">${hiddenCsrf(csrf)}<input type="hidden" name="item_count" value="${items.length}">${cards}<div class="actions"><button type="submit">Save article feedback</button><a class="button secondary" href="/profile/${id}">Back without saving</a></div></form>`));
    } catch (error) {
      return c.html(errorPage(error), 404);
    }
  });

  app.post('/profile/:id/calibration', async (c) => {
    try {
      const id = validateProfileId(c.req.param('id'));
      const body = await parseForm(c);
      const count = Number(field(body, 'item_count'));
      if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Calibration form is invalid or expired.');
      const answers: RankedCalibrationAnswers = {
        version: 2,
        answers: Array.from({ length: count }, (_, index) => {
          const item_id = field(body, `item_${index}`);
          const label = field(body, `rating_${index}`);
          if (!item_id || !['glad', 'fine', 'not_for_me', 'not_read'].includes(label)) throw new Error('Please label every displayed article.');
          return { item_id, label: label as RankedCalibrationLabel };
        }),
      };
      const profile = profileSummary(projectRoot, home, id);
      if (!profile.databaseExists) throw new Error('Profile database not found.');
      const db = new DatabaseSync(profile.databasePath);
      try {
        applyRankedCalibration(profileDirectory(id, home), db, answers);
      } finally {
        db.close();
      }
      return c.redirect(`/profile/${encodeURIComponent(id)}?saved=calibration`, 303);
    } catch (error) {
      return c.html(errorPage(error), 400);
    }
  });

  return app;
}
