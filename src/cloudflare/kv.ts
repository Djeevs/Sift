import { resolve } from 'node:path';
import { logger } from '../util/log.js';
import { chunk } from '../util/pool.js';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT } from '../config/index.js';

/** wrangler must run where wrangler.toml and its own node_modules live. */
const WORKER_DIR = resolve(PROJECT_ROOT, 'worker');

const log = logger('cloudflare');

/**
 * Minimal Cloudflare REST client for pushing feeds to KV.
 *
 * Deliberately not using the wrangler CLI: `npm run push` should work from cron
 * without an interactive login, so it authenticates with a scoped API token.
 */

export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  kvNamespaceId: string;
  /** Upload through the wrangler CLI rather than the REST API. */
  useWrangler: boolean;
}

export function loadCloudflareConfig(): CloudflareConfig | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const kvNamespaceId = process.env.SIFT_KV_NAMESPACE_ID;
  if (!kvNamespaceId) return null;

  // An API token is one more long-lived credential to create in a dashboard and
  // then keep out of git. Wrangler is already authenticated for anyone who
  // deployed the Worker, so it is used when no token is configured -- same
  // result, one less secret in .env.
  if (!apiToken) return { accountId: accountId ?? '', apiToken: '', kvNamespaceId, useWrangler: true };
  if (!accountId) return null;
  return { accountId, apiToken, kvNamespaceId, useWrangler: false };
}

export interface KvEntry {
  key: string;
  value: string;
  /** Seconds. Item URL mappings expire; feed documents do not. */
  expiration_ttl?: number;
}

interface CloudflareResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
}

/** Write many keys at once. The bulk endpoint accepts up to 10,000 per call. */
export async function kvBulkWrite(config: CloudflareConfig, entries: KvEntry[]): Promise<number> {
  if (config.useWrangler) return kvBulkWriteViaWrangler(config, entries);

  let written = 0;

  for (const batch of chunk(entries, 5000)) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.kvNamespaceId}/bulk`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`KV bulk write failed: HTTP ${res.status} ${text.slice(0, 400)}`);
    }
    const body = (await res.json()) as CloudflareResponse;
    if (!body.success) {
      throw new Error(`KV bulk write rejected: ${JSON.stringify(body.errors ?? []).slice(0, 400)}`);
    }
    written += batch.length;
    log.debug(`wrote ${batch.length} KV keys`);
  }

  return written;
}

export interface EdgeOpenEvent {
  id: string;
  item_id: string;
  feed_id: string | null;
  original_url: string;
  opened_at: number;
}

/**
 * Pull open events recorded at the edge. Goes through the Worker's own
 * endpoint rather than the D1 API, so it needs no extra credential.
 */
export async function fetchEdgeEvents(
  workerUrl: string,
  accessToken: string,
  since: number,
): Promise<EdgeOpenEvent[]> {
  const url = new URL(`${workerUrl.replace(/\/+$/, '')}/events`);
  url.searchParams.set('since', String(since));
  if (accessToken) url.searchParams.set('t', accessToken);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`fetching edge events failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { events?: EdgeOpenEvent[] };
  return body.events ?? [];
}

/**
 * Upload through the wrangler CLI instead of the REST API, using the OAuth login
 * that deploying the Worker already required.
 *
 * Wrangler's bulk put takes a JSON file, so the batch is written to a temporary
 * file and removed afterwards -- it contains feed XML rather than anything
 * secret, but leaving it lying around in a repo would be untidy.
 */
async function kvBulkWriteViaWrangler(config: CloudflareConfig, entries: KvEntry[]): Promise<number> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const run = promisify(execFile);

  let written = 0;
  const dir = await mkdtemp(join(tmpdir(), 'sift-kv-'));

  try {
    for (const batch of chunk(entries, 5000)) {
      const file = join(dir, `batch-${written}.json`);
      await writeFile(
        file,
        JSON.stringify(
          batch.map((e) => ({
            key: e.key,
            value: e.value,
            ...(e.expiration_ttl ? { expiration_ttl: e.expiration_ttl } : {}),
          })),
        ),
      );

      try {
        await run(
          'npx',
          [
            '--no-install',
            'wrangler',
            'kv',
            'bulk',
            'put',
            file,
            `--namespace-id=${config.kvNamespaceId}`,
            '--remote',
          ],
          { cwd: WORKER_DIR, maxBuffer: 8 * 1024 * 1024 },
        );
      } catch (err) {
        const detail = err as { stderr?: string; stdout?: string; message?: string };
        throw new Error(
          `KV bulk write via wrangler failed: ${(detail.stderr || detail.stdout || detail.message || '').slice(0, 500)}`,
        );
      }

      written += batch.length;
      log.debug(`wrote ${batch.length} KV keys via wrangler`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  return written;
}


/**
 * Which entries actually need uploading.
 *
 * Every push rewrote every key regardless of whether its content had changed —
 * byte for byte identical when nothing new had published. At 105 keys and eight
 * pushes a day that is 840 writes against Cloudflare's free-tier limit of
 * 1,000, so ordinary use hit the daily cap on data that had not changed.
 */
export function selectChangedEntries(
  entries: KvEntry[],
  previous: Record<string, string>,
): { changed: KvEntry[]; hashes: Record<string, string>; skipped: number } {
  const hashes: Record<string, string> = {};
  const changed: KvEntry[] = [];
  for (const entry of entries) {
    const hash = createHash('sha256').update(entry.value).digest('hex').slice(0, 32);
    hashes[entry.key] = hash;
    if (previous[entry.key] !== hash) changed.push(entry);
  }
  return { changed, hashes, skipped: entries.length - changed.length };
}
