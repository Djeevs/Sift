import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { initDb, type Db } from '../db/index.js';
import { loadConfig, PROJECT_ROOT, type AppConfig } from '../config/index.js';
import { syncSources } from '../ingest/index.js';
import { logger } from '../util/log.js';
import { onboardingReminder } from '../onboarding/index.js';

const log = logger('cli');

/** Load .env without a dependency (Node >= 20.12 has loadEnvFile). */
export function loadEnvFile(): void {
  const path = resolve(PROJECT_ROOT, '.env');
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
    } catch (err) {
      log.warn('could not read .env', err);
    }
  }

  // `--profile` must work for every npm command, including the standalone
  // diagnostics that call this helper without using `main()`.
  const argv = parseArgs();
  const requested = typeof argv.profile === 'string' ? argv.profile.trim().toLowerCase() : undefined;
  if (requested) process.env.SIFT_PROFILE = requested;

  const profileId = process.env.SIFT_PROFILE?.trim().toLowerCase();
  if (!profileId) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId)) {
    throw new Error('--profile/SIFT_PROFILE must be 1-64 lowercase letters, numbers, hyphens, or underscores');
  }
  const profileEnv = resolve(PROJECT_ROOT, 'profiles', profileId, '.env');
  if (!existsSync(profileEnv)) return;
  try {
    // Profile-specific publication URLs and tokens intentionally override the
    // checkout-wide provider defaults. The file lives in a gitignored folder.
    Object.assign(process.env, parseEnv(readFileSync(profileEnv, 'utf8')));
    process.env.SIFT_PROFILE = profileId;
  } catch (err) {
    log.warn(`could not read profile environment ${profileEnv}`, err);
  }
}

export interface Context {
  db: Db;
  config: AppConfig;
}

export function bootstrap(options: { syncSources?: boolean } = {}): Context {
  loadEnvFile();
  const config = loadConfig();
  const db = initDb(config.env.dbPath);
  if (options.syncSources !== false) syncSources(db, config);
  if (config.env.profileId) {
    const reminder = onboardingReminder(config.env.profileId);
    if (reminder) log.warn(reminder);
  }
  return { db, config };
}

/** Minimal flag parsing: --key=value, --key value, --flag. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = true;
    }
  }
  return out;
}

export function list(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Consistent exit behaviour for every CLI entry point. */
export async function main(fn: (ctx: Context, args: Record<string, string | boolean>) => Promise<void> | void): Promise<void> {
  const args = parseArgs();
  let ctx: Context | null = null;
  try {
    ctx = bootstrap({ syncSources: !args['no-sync'] });
    await fn(ctx, args);
    ctx.db.close();
    process.exit(0);
  } catch (err) {
    log.error('command failed', err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    ctx?.db.close();
    process.exit(1);
  }
}

export function printTable(rows: ReadonlyArray<object>): void {
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  const records = rows as ReadonlyArray<Record<string, unknown>>;
  const keys = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const widths = keys.map((k) =>
    Math.max(k.length, ...records.map((r) => String(r[k] ?? '').slice(0, 60).length)),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(keys));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of records) {
    console.log(line(keys.map((k) => String(row[k] ?? '').slice(0, 60))));
  }
}
