import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { contentHash } from '../util/hash.js';
import {
  feedFileSchema,
  finalRankingFileSchema,
  freeRankingFileSchema,
  modelsFileSchema,
  pipelineFileSchema,
  budgetFileSchema,
  classicsFileSchema,
  type BudgetFile,
  type ModeConfig,
  sourcesFileSchema,
  tasteProfileSchema,
  type FeedConfig,
  type FinalRankingConfig,
  type FreeRankingConfig,
  type ModelsConfig,
  type PipelineConfig,
  type SourceConfig,
  type TasteProfile,
  type ClassicsConfig,
} from './schema.js';

export * from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '../..');

export interface Env {
  /** Stable local profile id when a private profile overlay is active. */
  profileId: string | null;
  /** Resolved OpenAI-compatible endpoint per pipeline role. */
  aiEndpoints: Record<'triage' | 'deep' | 'embedding', AiEndpoint>;
  /**
   * Optional per-role model overrides. Model ids normally live in models.yaml;
   * these exist only so a deployment can try a different model without editing
   * a file. Unset in normal use.
   */
  modelOverrides: { triage?: string; deep?: string; embedding?: string };
  maxSpendPerRun: number;
  dbPath: string;
  /** development | test | production. Decides the default database file. */
  environment: Environment;
  port: number;
  publicUrl: string;
  accessToken: string;
  userAgent: string;
  fetchConcurrency: number;
  dryRun: boolean;
}

export interface AiEndpoint {
  /** Human-readable preset name; recorded by diagnostics, never sent upstream. */
  provider: string;
  apiKey: string;
  baseUrl: string | undefined;
}

const PROVIDER_PRESETS: Record<string, { baseUrl?: string; keyEnv?: string; local?: boolean }> = {
  openai: { keyEnv: 'OPENAI_API_KEY' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyEnv: 'GEMINI_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1/', keyEnv: 'ANTHROPIC_API_KEY' },
};

function aiEndpoint(role: 'triage' | 'deep' | 'embedding'): AiEndpoint {
  const prefix = role === 'embedding' ? 'EMBEDDING' : role.toUpperCase();
  const globalProvider = process.env.SIFT_AI_PROVIDER?.trim().toLowerCase();
  const provider =
    process.env[`SIFT_${prefix}_PROVIDER`]?.trim().toLowerCase() ??
    globalProvider ??
    (process.env.OPENAI_BASE_URL ? 'custom' : 'openai');
  const preset = PROVIDER_PRESETS[provider];
  const baseUrl =
    process.env[`SIFT_${prefix}_BASE_URL`]?.trim() ||
    preset?.baseUrl ||
    process.env.OPENAI_BASE_URL?.trim() ||
    undefined;
  const explicitKey = process.env[`SIFT_${prefix}_API_KEY`]?.trim();
  const presetKey = preset?.keyEnv ? process.env[preset.keyEnv]?.trim() : undefined;
  // The OpenAI SDK requires a non-empty string even when a local endpoint does
  // not authenticate. It is never transmitted anywhere except that endpoint.
  const apiKey = explicitKey || presetKey || process.env.OPENAI_API_KEY?.trim() || (preset?.local ? 'local' : '');
  return { provider, apiKey, baseUrl };
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


/**
 * Which environment this process is running as. There used to be two populated
 * database files -- data/sift.db and data/dev.db -- with the pipeline writing one
 * while the admin server read the other, so the UI showed a stale funnel and
 * nobody noticed. One name per environment, derived in one place, is what stops
 * that recurring.
 */
export type Environment = 'development' | 'test' | 'production';

export function resolveEnvironment(): Environment {
  const raw = (process.env.SIFT_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  if (raw.startsWith('prod')) return 'production';
  if (raw.startsWith('test')) return 'test';
  return 'development';
}

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function resolveProfileId(): string | null {
  const raw = process.env.SIFT_PROFILE?.trim().toLowerCase();
  if (!raw) return null;
  if (!PROFILE_ID.test(raw)) {
    throw new Error('SIFT_PROFILE must be 1-64 lowercase letters, numbers, hyphens, or underscores');
  }
  return raw;
}

/** Default database file per environment. */
export function defaultDbPath(env: Environment = resolveEnvironment()): string {
  if (env === 'test') return ':memory:';
  return resolve(PROJECT_ROOT, 'data', env === 'production' ? 'sift.db' : 'sift-dev.db');
}

/**
 * The single decision about which database this process uses. An explicit
 * SIFT_DB_PATH still wins -- it is how the replay and migration tools point at a
 * copy -- but everything else follows the environment.
 */
export function resolveDbPath(): string {
  const explicit = process.env.SIFT_DB_PATH?.trim();
  if (explicit) return explicit === ':memory:' ? explicit : resolve(PROJECT_ROOT, explicit);
  const profileId = resolveProfileId();
  if (profileId) return resolve(PROJECT_ROOT, 'data', 'profiles', `${profileId}.db`);
  return defaultDbPath();
}

export function loadEnv(): Env {
  return {
    profileId: resolveProfileId(),
    aiEndpoints: {
      triage: aiEndpoint('triage'),
      deep: aiEndpoint('deep'),
      embedding: aiEndpoint('embedding'),
    },
    modelOverrides: {
      triage: process.env.SIFT_TRIAGE_MODEL || undefined,
      deep: process.env.SIFT_DEEP_MODEL || undefined,
      embedding: process.env.SIFT_EMBEDDING_MODEL || undefined,
    },
    maxSpendPerRun: num(process.env.SIFT_MAX_SPEND_PER_RUN, 2),
    dbPath: resolveDbPath(),
    environment: resolveEnvironment(),
    port: num(process.env.PORT, 8787),
    publicUrl: (process.env.SIFT_PUBLIC_URL ?? 'http://localhost:8787').replace(/\/+$/, ''),
    accessToken: process.env.SIFT_ACCESS_TOKEN ?? '',
    userAgent: process.env.SIFT_USER_AGENT ?? 'SiftPersonalReader/0.1 (+personal RSS curation)',
    fetchConcurrency: num(process.env.SIFT_FETCH_CONCURRENCY, 6),
    dryRun: process.env.SIFT_DRY_RUN === '1' || process.env.SIFT_DRY_RUN === 'true',
  };
}

/**
 * The loaded configuration, organised by pipeline stage rather than by file:
 *
 *   free      stage 2 (rules) + stage 3 (free score)
 *   models    stage 4 + stage 5 models, semantic provider
 *   final     stage 4/5 gating + stage 6 portfolio construction
 *   feeds     the generated feeds (stage 7)
 *   pipeline  mechanics that decide nothing editorial
 */
export interface AppConfig {
  env: Env;
  sources: SourceConfig[];
  taste: TasteProfile;
  models: ModelsConfig;
  free: FreeRankingConfig;
  final: FinalRankingConfig;
  feeds: FeedConfig[];
  categories: string[];
  pipeline: PipelineConfig;
  classics: ClassicsConfig;
  /** Spend limits, audit rates and Terra-allocation settings for the active mode. */
  budget: BudgetFile['budget'];
  terraOpportunity: BudgetFile['terra_opportunity'];
  /** Name of the active operating mode, e.g. "calibration". */
  modeName: string;
  mode: ModeConfig;
  /**
   * Content hash per file, recorded with every AI judgement and every ranking
   * decision so results stay comparable across config changes.
   */
  hashes: {
    sources: string;
    taste: string;
    models: string;
    free: string;
    final: string;
    feeds: string;
    pipeline: string;
    budget: string;
    classics: string;
    /** Combined ranking identity: what a stored decision was made under. */
    ranking: string;
  };
  paths: Record<'sources' | 'taste' | 'models' | 'free' | 'final' | 'feeds' | 'pipeline' | 'budget' | 'classics' | 'prompts', string>;
}

function readYaml(path: string, name: string): { data: unknown; hash: string } {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}\nExpected ${name} in config/.`);
  }
  const raw = readFileSync(path, 'utf8');
  return { data: parseYaml(raw), hash: contentHash(raw) };
}

function parseOrThrow<T>(name: string, schema: { parse: (v: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    const zodError = error as { issues?: Array<{ path: (string | number)[]; message: string }> };
    if (zodError?.issues) {
      const lines = zodError.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new Error(`Invalid ${name}:\n${lines.join('\n')}`);
    }
    throw error;
  }
}

let cached: AppConfig | null = null;

export function loadConfig(options: { configDir?: string; reload?: boolean } = {}): AppConfig {
  if (cached && !options.reload && !options.configDir) return cached;

  const configuredDir = process.env.SIFT_CONFIG_DIR?.trim();
  const profileId = resolveProfileId();
  const baseConfigDir = resolve(PROJECT_ROOT, 'config');
  const configDir = options.configDir ?? (
    configuredDir
      ? resolve(PROJECT_ROOT, configuredDir)
      : profileId
        ? resolve(PROJECT_ROOT, 'profiles', profileId)
        : baseConfigDir
  );
  // Profile directories are overlays. A generated profile normally contains
  // only private taste/onboarding files and inherits versioned mechanics from
  // config/. Advanced users can override any individual YAML file explicitly.
  const file = (name: string): string => {
    const candidate = resolve(configDir, name);
    return existsSync(candidate) ? candidate : resolve(baseConfigDir, name);
  };
  const paths = {
    sources: file('sources.yaml'),
    taste: file('taste-profile.yaml'),
    models: file('models.yaml'),
    free: file('free-ranking.yaml'),
    final: file('final-ranking.yaml'),
    feeds: file('feed-config.yaml'),
    pipeline: file('pipeline.yaml'),
    budget: file('budget.yaml'),
    classics: file('classics.yaml'),
    prompts: resolve(PROJECT_ROOT, 'prompts'),
  };

  const raw = {
    sources: readYaml(paths.sources, 'sources.yaml'),
    taste: readYaml(paths.taste, 'taste-profile.yaml'),
    models: readYaml(paths.models, 'models.yaml'),
    free: readYaml(paths.free, 'free-ranking.yaml'),
    final: readYaml(paths.final, 'final-ranking.yaml'),
    feeds: readYaml(paths.feeds, 'feed-config.yaml'),
    pipeline: readYaml(paths.pipeline, 'pipeline.yaml'),
    budget: readYaml(paths.budget, 'budget.yaml'),
    classics: readYaml(paths.classics, 'classics.yaml'),
  };

  const sourcesFile = parseOrThrow('sources.yaml', sourcesFileSchema, raw.sources.data);
  const taste = parseOrThrow('taste-profile.yaml', tasteProfileSchema, raw.taste.data);
  const models = parseOrThrow('models.yaml', modelsFileSchema, raw.models.data);
  const free = parseOrThrow('free-ranking.yaml', freeRankingFileSchema, raw.free.data);
  const final = parseOrThrow('final-ranking.yaml', finalRankingFileSchema, raw.final.data);
  const feedFile = parseOrThrow('feed-config.yaml', feedFileSchema, raw.feeds.data);
  const pipeline = parseOrThrow('pipeline.yaml', pipelineFileSchema, raw.pipeline.data);
  const budgetFile = parseOrThrow('budget.yaml', budgetFileSchema, raw.budget.data);
  const classics = parseOrThrow('classics.yaml', classicsFileSchema, raw.classics.data);

  // The active mode may be overridden per-process, so a calibration run does not
  // require editing config.
  const modeName = process.env.SIFT_MODE ?? budgetFile.mode;
  const mode = budgetFile.modes[modeName];
  if (!mode) {
    throw new Error(
      `budget.yaml: mode "${modeName}" is not defined. Known modes: ${Object.keys(budgetFile.modes).join(', ')}`,
    );
  }

  // --- Sources: apply defaults, derive what the schema deliberately leaves off
  const defaults = sourcesFile.defaults;
  const seen = new Set<string>();
  const sources: SourceConfig[] = sourcesFile.sources.map((s) => {
    if (seen.has(s.id)) throw new Error(`Duplicate source id in sources.yaml: ${s.id}`);
    seen.add(s.id);
    const feedType = s.feed_type ?? defaults.feed_type;
    const access = s.access ?? defaults.access;
    const explicitlyGatedMixedSource =
      access === 'mixed' &&
      s.hard_rules?.require_explicit_free_article === true &&
      s.hard_rules?.require_readable_article === true;
    const sourceHost = (() => {
      try {
        return new URL(s.feed_url).hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const sourceName = s.name.trim().toLowerCase();
    const preference = taste.source_preferences.find((candidate) => {
      const candidateName = candidate.name.trim().toLowerCase();
      const candidateHost = candidate.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      return (candidateHost && (sourceHost === candidateHost || sourceHost.endsWith(`.${candidateHost}`))) ||
        candidateName === sourceName;
    });
    const roleMultiplier = preference
      ? ({ direct_follow: 1, selective: 0.5, discovery_only: 0, wildcard: 0 }[preference.role ?? 'direct_follow'])
      : 0;
    const priorAdjustment = preference
      ? ({ known_favorite: 0.08, recommended: 0.04, exploratory: 0, avoid: -0.08 }[preference.disposition] *
        preference.confidence *
        (preference.disposition === 'avoid' ? 1 : roleMultiplier))
      : 0;
    const qualityPrior = Math.max(0.05, Math.min(0.95, (s.quality_prior ?? defaults.quality_prior) + priorAdjustment));
    return {
      ...s,
      feed_type: feedType,
      language: s.language ?? defaults.language,
      enabled: s.enabled ?? defaults.enabled,
      access,
      item_kind: s.item_kind ?? defaults.item_kind,
      // Podcast feeds exist for alternate-format matching, not for reading.
      publishable:
        s.publishable ??
        ((s.enabled ?? defaults.enabled) &&
          (access === 'free' || explicitlyGatedMixedSource) &&
          feedType !== 'podcast'),
      quality_prior: qualityPrior,
      volume_budget: s.volume_budget ?? defaults.volume_budget,
      exploration_floor: s.exploration_floor ?? defaults.exploration_floor,
      category_priors: { ...defaults.category_priors, ...s.category_priors },
      feed_weights: { ...defaults.feed_weights, ...s.feed_weights },
      hard_rules: s.hard_rules ?? {},
    } as SourceConfig;
  });

  // Operational preferences tune only bounded mechanics. The taste hash is
  // part of the ranking identity, so these derived changes remain auditable.
  const freshnessMultiplier = {
    timely: 1.3,
    balanced: 1,
    evergreen: 0.6,
  }[taste.reader_preferences.freshness_balance];
  free.free_ranking.weights.freshness_score *= freshnessMultiplier;
  const serendipity = taste.reader_preferences.serendipity;
  final.final_ranking.exploration.fraction = Math.min(0.4, serendipity * 0.04);
  final.final_ranking.exploration.min_slots_per_day = serendipity === 0 ? 0 : serendipity >= 8 ? 2 : 1;
  final.final_ranking.exploration.min_serendipity = Math.max(0.35, Math.min(0.75, 0.75 - serendipity * 0.04));

  // --- Cross-file validation. Catching these at load beats a silent zero later.
  const categories = feedFile.categories;
  const feedIds = new Set(feedFile.feeds.map((f) => f.id));

  const unknownCategories = new Set<string>();
  for (const s of sources) {
    for (const c of Object.keys(s.category_priors)) {
      if (c !== 'default' && !categories.includes(c)) unknownCategories.add(`${s.id}:${c}`);
    }
    for (const f of Object.keys(s.feed_weights)) {
      if (f !== 'default' && !feedIds.has(f)) unknownCategories.add(`${s.id}:feed_weights.${f}`);
    }
  }
  if (unknownCategories.size > 0) {
    throw new Error(
      `sources.yaml references unknown categories/feeds: ${[...unknownCategories].join(', ')}\n` +
        `Known categories: ${categories.join(', ')}\nKnown feeds: ${[...feedIds].join(', ')}`,
    );
  }

  for (const feed of feedFile.feeds) {
    for (const c of feed.categories) {
      if (!categories.includes(c)) {
        throw new Error(`Feed "${feed.id}" references unknown category "${c}"`);
      }
    }
  }
  for (const id of final.final_ranking.feed_priority) {
    if (!feedIds.has(id)) throw new Error(`final-ranking.yaml feed_priority lists unknown feed "${id}"`);
  }

  const hashes = {
    sources: raw.sources.hash,
    taste: raw.taste.hash,
    models: raw.models.hash,
    free: raw.free.hash,
    final: raw.final.hash,
    feeds: raw.feeds.hash,
    pipeline: raw.pipeline.hash,
    budget: raw.budget.hash,
    classics: raw.classics.hash,
    // Everything that can change a ranking outcome, in one identifier.
    ranking: contentHash(
      [raw.taste.hash, raw.free.hash, raw.final.hash, raw.feeds.hash, raw.sources.hash, raw.classics.hash].join('|'),
    ),
  };

  const config: AppConfig = {
    env: loadEnv(),
    sources,
    taste,
    models,
    free,
    final,
    feeds: feedFile.feeds,
    categories,
    pipeline,
    classics,
    budget: budgetFile.budget,
    terraOpportunity: budgetFile.terra_opportunity,
    modeName,
    mode,
    hashes,
    paths,
  };

  if (!options.configDir) cached = config;
  return config;
}

export function feedById(config: AppConfig, id: string): FeedConfig | undefined {
  return config.feeds.find((f) => f.id === id);
}

export function sourceById(config: AppConfig, id: string): SourceConfig | undefined {
  return config.sources.find((s) => s.id === id);
}

/** A source's prior for a category, falling back to its `default`. */
export function categoryPrior(source: SourceConfig | undefined, category: string): number {
  if (!source) return 0.45;
  return source.category_priors[category] ?? source.category_priors['default'] ?? 0.45;
}

/**
 * The categories a source actually declares, strongest prior first. Replaces the
 * old flat `categories` list: the priors carry the same information plus weight.
 */
export function sourceCategories(source: SourceConfig | undefined): string[] {
  if (!source) return [];
  return Object.entries(source.category_priors)
    .filter(([k]) => k !== 'default')
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

/** A source's weight in a feed, falling back to its `default`. */
export function feedWeight(source: SourceConfig | undefined, feedId: string): number {
  if (!source) return 0.6;
  return source.feed_weights[feedId] ?? source.feed_weights['default'] ?? 0.6;
}

/** Feeds in configured priority order; unlisted feeds go last. */
export function orderedFeeds(config: AppConfig): FeedConfig[] {
  const priority = config.final.final_ranking.feed_priority;
  return [...config.feeds].sort((a, b) => {
    const ia = priority.indexOf(a.id);
    const ib = priority.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}
