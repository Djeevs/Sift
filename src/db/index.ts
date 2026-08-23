import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PROJECT_ROOT, resolveDbPath, resolveEnvironment, resolveProfileId } from '../config/index.js';
import { logger } from '../util/log.js';

const log = logger('db');

/**
 * Warn when another populated database file is sitting next to the one in use.
 *
 * Two live files -- data/sift.db and data/dev.db -- once diverged for a whole
 * session, with the pipeline writing one and the admin server reading the other.
 * Nothing deletes anything here; the point is only that the situation stops being
 * silent.
 */
function warnAboutOtherDatabases(inUse: string): void {
  if (inUse === ':memory:') return;
  try {
    const dir = dirname(inUse);
    const others = readdirSync(dir)
      .filter((f) => f.endsWith('.db') && resolve(dir, f) !== resolve(inUse))
      .map((f) => ({ file: f, size: statSync(resolve(dir, f)).size }))
      .filter((f) => f.size > 65_536);
    if (others.length === 0) return;
    log.warn(
      `other populated database file(s) in ${dir}: ` +
      others.map((o) => `${o.file} (${(o.size / 1e6).toFixed(1)}MB)`).join(', ') +
      `. Only ${inUse} is in use. Archive or remove the others to avoid reading stale data.`,
    );
  } catch {
    // Diagnostics must never stop the database from opening.
  }
}

/**
 * Thin wrapper over node:sqlite.
 *
 * Everything else in the codebase talks to this interface rather than to the
 * driver, so swapping in better-sqlite3, libSQL or D1 later is a one-file job.
 */
export interface Db {
  run(sql: string, params?: Record<string, unknown> | unknown[]): void;
  get<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown> | unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown> | unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  raw: DatabaseSync;
}

function normalizeParams(params?: Record<string, unknown> | unknown[]): unknown[] {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(coerce);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) obj[k] = coerce(v);
  return [obj];
}

/** SQLite has no boolean or undefined; normalise before every bind. */
function coerce(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

/**
 * Which setting chose the database file, in the order resolveDbPath checks.
 *
 * Every CLI reaches openDb through `bootstrap()`, which passes
 * `config.env.dbPath` -- itself the output of resolveDbPath. Reporting that as
 * "an explicit argument" would be true and useless, so an argument that agrees
 * with the resolver is attributed to whatever the resolver actually used.
 */
function dbPathSelector(explicitArgument?: string): string {
  if (explicitArgument && explicitArgument !== resolveDbPath()) {
    return 'an explicit path argument';
  }
  if (process.env.SIFT_DB_PATH?.trim()) return 'SIFT_DB_PATH';
  const profileId = resolveProfileId();
  if (profileId) return `profile "${profileId}"`;
  return `environment "${resolveEnvironment()}"`;
}

export function openDb(path?: string): Db {
  // One resolver for every entry point -- pipeline, server, CLI and tests -- so
  // they cannot silently disagree about which database is the real one.
  const dbPath = path ?? resolveDbPath();

  // Logged on every start. The dev/prod database mix-up was invisible precisely
  // because nothing ever said which file was open.
  //
  // It reports what *selected* the path, not the environment name. Naming the
  // environment was actively misleading: SIFT_DB_PATH wins over it, so a
  // production run with SIFT_DB_PATH set and NODE_ENV unset logged
  // "environment: development" while correctly opening the production database
  // -- exactly the confusion this line exists to prevent.
  log.info(`database: ${dbPath} (selected by ${dbPathSelector(path)})`);
  warnAboutOtherDatabases(dbPath);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 8000;');

  let depth = 0;

  const db: Db = {
    run(sql, params) {
      raw.prepare(sql).run(...(normalizeParams(params) as never[]));
    },
    get(sql, params) {
      return raw.prepare(sql).get(...(normalizeParams(params) as never[])) as never;
    },
    all(sql, params) {
      return raw.prepare(sql).all(...(normalizeParams(params) as never[])) as never;
    },
    exec(sql) {
      raw.exec(sql);
    },
    transaction(fn) {
      // Nested calls join the outer transaction rather than starting a new one.
      if (depth > 0) return fn();
      depth += 1;
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* the transaction was already rolled back by SQLite */
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },
    close() {
      raw.close();
    },
    raw,
  };

  return db;
}

/**
 * Add a column to an existing table if it is missing.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which does nothing for a table
 * that already exists -- so new columns need this. Additive changes only:
 * anything destructive should be a deliberate, separate script.
 */
export function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.length === 0) return; // table does not exist yet; schema.sql will create it
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`migrated: added ${table}.${column}`);
}

export function migrate(db: Db): void {
  const schemaPath = resolve(PROJECT_ROOT, 'src/db/schema.sql');
  let sql: string;
  try {
    sql = readFileSync(schemaPath, 'utf8');
  } catch {
    // When running from dist/, the schema sits next to the compiled file.
    sql = readFileSync(resolve(dirname(new URL(import.meta.url).pathname), 'schema.sql'), 'utf8');
  }
  db.exec(sql);

  // Additive migrations for databases created by an earlier version. The funnel
  // refactor adds tables (handled by CREATE TABLE IF NOT EXISTS above) and these
  // columns on tables that already existed.
  ensureColumn(db, 'api_usage', 'cached_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  // Stage 4 now records what the free ranker had decided, so a Luna gate
  // decision can be read back without re-deriving it.
  ensureColumn(db, 'cheap_evaluations', 'free_score_at_gate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'cheap_evaluations', 'band_at_gate', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'cheap_evaluations', 'exploration_slot', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'cheap_evaluations', 'gate_components_json', "TEXT NOT NULL DEFAULT '{}'");
  // Terra's own view of how long the item takes, kept alongside the estimate.
  ensureColumn(db, 'deep_evaluations', 'argument_quality', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'storytelling', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'authorial_voice', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'critique', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'humor', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'obsessive_expertise', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'rabbit_hole', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'delight', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'deep_evaluations', 'headline_sufficiency', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'feed_items', 'feed_images_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'feed_items', 'item_kind', "TEXT NOT NULL DEFAULT 'article'");
  ensureColumn(db, 'free_score_components', 'discovery_signal', 'REAL NOT NULL DEFAULT 0.5');
  ensureColumn(db, 'story_cluster_members', 'signals_json', 'TEXT');
  ensureColumn(db, 'story_cluster_members', 'perspective_distance', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'audit_samples', 'audit_stage', 'TEXT');
  ensureColumn(db, 'audit_samples', 'audit_reason', 'TEXT');
  ensureColumn(db, 'audit_samples', 'would_have_qualified', 'INTEGER');
  ensureColumn(db, 'audit_samples', 'source_id', 'TEXT');
  ensureColumn(db, 'audit_samples', 'category', 'TEXT');
  ensureColumn(db, 'audit_samples', 'word_count', 'INTEGER');
  ensureColumn(db, 'audit_samples', 'source_prior', 'REAL');
  ensureColumn(db, 'audit_samples', 'semantic_interest', 'REAL');
  ensureColumn(db, 'audit_samples', 'is_serendipity', 'INTEGER');
  ensureColumn(db, 'audit_samples', 'content_type', 'TEXT');
  ensureColumn(db, 'sources', 'first_seen_at', 'INTEGER');
  // Classics v2 separates whether the reader will actually start an article from
  // how glad he is expected to be after reading it. Existing rows are
  // re-evaluated by prompt-version mismatch rather than guessed in migration.
  ensureColumn(db, 'classics_evaluations', 'predicted_read', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'classics_evaluations', 'predicted_payoff', 'REAL NOT NULL DEFAULT 0');

  db.run(
    `INSERT INTO schema_meta(key, value) VALUES('version', '3')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  log.debug('schema applied');
}

/** Convenience for scripts: open + migrate in one call. */
export function initDb(path?: string): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}

export const now = (): number => Date.now();
