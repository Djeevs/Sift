/**
 * Guided Cloudflare provisioning through the `wrangler` CLI.
 *
 * `npm run cloud:setup` used to be three manual steps -- create a KV
 * namespace, create a D1 database, paste both ids into `wrangler.toml` by
 * hand, deploy, then copy the deployed URL into `.env` -- each one a chance
 * for a non-technical reader to mistype an id or edit the wrong file. This
 * module does the parsing and file-patching so the CLI script only has to
 * narrate what is happening.
 *
 * `worker/wrangler.toml` is a single, gitignored file describing whichever
 * reader's deployment is currently checked out (see README "Separate
 * personal profiles"), so every function here operates on that one file --
 * never on a per-profile copy.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';
import { atomicWrite } from '../onboarding/index.js';
import { logger } from '../util/log.js';
import { WORKER_DIR } from './kv.js';

const log = logger('cloudflare-setup');
const run = promisify(execFile);
const TOML_PATH = resolve(WORKER_DIR, 'wrangler.toml');
const EXAMPLE_PATH = resolve(WORKER_DIR, 'wrangler.example.toml');

const wrangler = (args: string[], options: { input?: string; timeoutMs?: number } = {}) =>
  new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], { cwd: WORKER_DIR });
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`wrangler ${args[0]} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(Object.assign(new Error(`wrangler ${args.join(' ')} exited with code ${code}`), { stdout, stderr }));
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });

/** Whether `wrangler` resolves at all -- a missing `worker/node_modules` install is the usual cause. */
export async function wranglerAvailable(): Promise<boolean> {
  try {
    await run('npx', ['--no-install', 'wrangler', '--version'], { cwd: WORKER_DIR });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses `wrangler whoami` output. Wrangler prints "You are logged in with an
 * OAuth Token, associated with the email 'x@example.com'!" or a table naming
 * the account. Either way, "You are not authenticated" is the one string that
 * means "log in first."
 */
export function parseWhoami(wranglerOutput: string): string | null {
  if (/not authenticated|not logged in/i.test(wranglerOutput)) return null;
  const account = /associated with the email '([^']+)'/i.exec(wranglerOutput)?.[1]
    ?? /Account Name[^\n]*\n[^\n]*│\s*([^\s│]+)/i.exec(wranglerOutput)?.[1];
  return account ?? 'your Cloudflare account';
}

/** Cloudflare account name if logged in via `wrangler login`, else null. */
export async function whoami(): Promise<string | null> {
  try {
    const { stdout } = await wrangler(['whoami'], { timeoutMs: 20_000 });
    return parseWhoami(stdout);
  } catch {
    return null;
  }
}

/**
 * Runs the interactive OAuth login, with the browser flow and prompts
 * visible in the reader's own terminal -- this is the one step nothing can
 * do on their behalf, since only they can approve it in their browser.
 */
export function login(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', 'login'], { cwd: WORKER_DIR, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`wrangler login exited with code ${code}`))));
  });
}

export interface WranglerTomlStatus {
  exists: boolean;
  name: string | null;
  kvNamespaceId: string | null;
  d1DatabaseName: string | null;
  d1DatabaseId: string | null;
}

function readToml(): string | null {
  return existsSync(TOML_PATH) ? readFileSync(TOML_PATH, 'utf8') : null;
}

const PLACEHOLDER = /^REPLACE_WITH_/;

/** Parses the handful of fields this module ever needs to read or patch. Pure, for testing without touching the filesystem. */
export function parseWranglerToml(text: string | null): WranglerTomlStatus {
  if (!text) return { exists: false, name: null, kvNamespaceId: null, d1DatabaseName: null, d1DatabaseId: null };
  const name = /^name\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null;
  const kvId = /^id\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null;
  const d1Name = /^database_name\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null;
  const d1Id = /^database_id\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null;
  return {
    exists: true,
    name,
    kvNamespaceId: kvId && !PLACEHOLDER.test(kvId) ? kvId : null,
    d1DatabaseName: d1Name,
    d1DatabaseId: d1Id && !PLACEHOLDER.test(d1Id) ? d1Id : null,
  };
}

/** Scopes the example config to one reader, without touching the filesystem. */
export function renderWranglerToml(exampleText: string, readerSlug: string): string {
  let text = exampleText.replace(/^name\s*=\s*"sift-reader-name"/m, `name = "sift-${readerSlug}"`);
  text = text.replace(/^database_name\s*=\s*"sift-reader-name-events"/m, `database_name = "sift-${readerSlug}-events"`);
  return text;
}

/** Applies a `key = "value"` patch to existing TOML text. Throws if a key has no line to update. */
export function patchTomlText(text: string, patch: Record<string, string>): string {
  let next = text;
  for (const [key, value] of Object.entries(patch)) {
    const pattern = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, 'm');
    if (!pattern.test(next)) throw new Error(`worker/wrangler.toml has no "${key} = ..." line to update -- edit it by hand instead.`);
    next = next.replace(pattern, `${key} = "${value}"`);
  }
  return next;
}

/** Parses the handful of fields this module ever needs to read or patch. */
export function wranglerTomlStatus(): WranglerTomlStatus {
  return parseWranglerToml(readToml());
}

/** Creates `worker/wrangler.toml` from the example, scoped to this reader, if it does not exist yet. */
export function ensureWranglerToml(readerSlug: string): WranglerTomlStatus {
  if (!existsSync(TOML_PATH)) {
    if (!existsSync(EXAMPLE_PATH)) throw new Error('worker/wrangler.example.toml is missing; cannot create a config from it.');
    atomicWrite(TOML_PATH, renderWranglerToml(readFileSync(EXAMPLE_PATH, 'utf8'), readerSlug));
  }
  return wranglerTomlStatus();
}

function patchToml(patch: Record<string, string>): void {
  const text = readToml();
  if (!text) throw new Error('worker/wrangler.toml does not exist yet.');
  atomicWrite(TOML_PATH, patchTomlText(text, patch));
}

export function extractNamespaceId(wranglerOutput: string): string | null {
  return /id\s*=\s*"([a-f0-9]+)"/i.exec(wranglerOutput)?.[1] ?? null;
}

export function extractDatabaseId(wranglerOutput: string): string | null {
  return /database_id\s*=\s*"([0-9a-f-]+)"/i.exec(wranglerOutput)?.[1] ?? null;
}

export function extractWorkerUrl(wranglerOutput: string): string | null {
  return /https:\/\/[a-z0-9.-]+\.workers\.dev\S*/i.exec(wranglerOutput)?.[0]?.replace(/\/+$/, '') ?? null;
}

/** Creates the KV namespace and records its id in wrangler.toml. Safe to skip if one is already configured. */
export async function createKvNamespace(bindingTitle: string): Promise<string> {
  const { stdout } = await wrangler(['kv', 'namespace', 'create', bindingTitle], { timeoutMs: 60_000 });
  const id = extractNamespaceId(stdout);
  if (!id) throw new Error(`Could not find the new namespace id in wrangler's output:\n${stdout}`);
  patchToml({ id });
  return id;
}

/** Creates the D1 database and records its id in wrangler.toml. */
export async function createD1Database(databaseName: string): Promise<string> {
  const { stdout } = await wrangler(['d1', 'create', databaseName], { timeoutMs: 60_000 });
  const id = extractDatabaseId(stdout);
  if (!id) throw new Error(`Could not find the new database id in wrangler's output:\n${stdout}`);
  patchToml({ database_id: id });
  return id;
}

/** Applies schema.sql to the (already created) remote D1 database. */
export async function applyD1Schema(databaseName: string): Promise<void> {
  await wrangler(['d1', 'execute', databaseName, '--remote', '--file=./schema.sql'], { timeoutMs: 120_000 });
}

/** Regenerates worker-configuration.d.ts. Best-effort: a stale type file never breaks a live deployment. */
export async function regenerateTypes(): Promise<boolean> {
  try {
    await wrangler(['types'], { timeoutMs: 30_000 });
    return true;
  } catch (err) {
    log.warn('wrangler types failed (non-fatal)', err);
    return false;
  }
}

/**
 * Pushes the reader's own feed-access token to Cloudflare as a Worker
 * secret, piped straight into wrangler's stdin so it is never typed,
 * echoed, or placed in a shell command.
 */
export async function pushAccessTokenSecret(token: string): Promise<void> {
  if (!token) throw new Error('No access token to push -- this reader has none configured yet.');
  await wrangler(['secret', 'put', 'SIFT_ACCESS_TOKEN'], { input: token, timeoutMs: 60_000 });
}

/** Deploys the Worker and returns its public `workers.dev` URL. */
export async function deployWorker(): Promise<string> {
  const { stdout } = await wrangler(['deploy'], { timeoutMs: 120_000 });
  const url = extractWorkerUrl(stdout);
  if (!url) throw new Error(`Deployed, but could not find the Worker's URL in wrangler's output:\n${stdout}`);
  return url;
}
