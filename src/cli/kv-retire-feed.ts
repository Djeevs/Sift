/**
 * Remove a retired feed's keys from Cloudflare KV.
 *
 * `push` never deletes — it only writes changed keys — so a feed that no
 * longer exists in config (Classics and the Briefing, both removed) stays
 * live on the edge forever unless something explicitly takes it down. This
 * is that something: a rare, deliberate action, not part of the normal push
 * cycle.
 *
 * Deletes only the feed's own documents (`feed:<slug>`, `feed:<slug>:rss`,
 * `feed:<slug>:json`) and its per-feed freshness marker. It does not touch
 * `item:<id>` redirect keys: an item can appear in more than one feed, so a
 * redirect must not be assumed to belong only to the feed being retired.
 *
 *   npm run kv:retire -- --slug classics
 *   npm run kv:retire -- --slug briefing --dry
 */
import { resolve } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { loadCloudflareConfig, kvBulkDelete } from '../cloudflare/kv.js';
import { loadConfig, resolveHome } from '../config/index.js';

loadEnvFile();
const args = parseArgs();
const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
if (!slug) throw new Error('Missing --slug (e.g. --slug classics)');

const cf = loadCloudflareConfig();
if (!cf) {
  console.log('Cloudflare credentials are missing. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and SIFT_KV_NAMESPACE_ID in .env.');
  process.exit(1);
}

const keys = [`feed:${slug}`, `feed:${slug}:rss`, `feed:${slug}:json`, `meta:pushed_at:${slug}`];

console.log(`Retiring feed "${slug}" from Cloudflare KV:`);
for (const key of keys) console.log(`  ${key}`);

if (args.dry) {
  console.log('\n--dry: nothing deleted.');
  process.exit(0);
}

const deleted = await kvBulkDelete(cf, keys);
console.log(`\nDeleted ${deleted} key(s).`);

// Keep the push state file honest, so a stray future push does not skip
// re-uploading these keys under the mistaken belief nothing changed.
try {
  const config = loadConfig({ reload: true });
  const statePath = resolve(resolveHome(), 'data', 'kv-state', `${config.env.profileId ?? 'default'}.json`);
  if (existsSync(statePath)) {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { keys?: Record<string, string> };
    const remaining = Object.fromEntries(Object.entries(parsed.keys ?? {}).filter(([key]) => !keys.includes(key)));
    writeFileSync(statePath, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), keys: remaining }, null, 2)}\n`);
  }
} catch {
  // Best-effort bookkeeping; the deletion itself already succeeded.
}
