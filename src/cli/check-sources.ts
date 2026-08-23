import { loadEnvFile } from './_bootstrap.js';
import { loadConfig } from '../config/index.js';
import { fetchText } from '../util/http.js';
import { parseFeed } from '../ingest/parseFeed.js';
import { mapPool } from '../util/pool.js';

/**
 * Verify every configured feed URL actually resolves to a parseable feed.
 * Run this after editing sources.yaml.
 */
loadEnvFile();
const config = loadConfig();
const sources = config.sources.filter((s) => s.enabled);

console.log(`checking ${sources.length} enabled sources...`);
console.log('');

let broken = 0;
await mapPool(sources, 8, async (source) => {
  const res = await fetchText(source.feed_url, { retries: 1, timeoutMs: 30_000, maxBytes: 24_000_000 });
  if (!res.ok) {
    broken += 1;
    console.log(`FAIL  ${source.id.padEnd(24)} HTTP ${res.status} ${res.error ?? ''}`);
    return;
  }
  if (source.discovery?.type === 'hacker_news') {
    try {
      const ids = JSON.parse(res.body) as unknown;
      if (Array.isArray(ids) && ids.some((id) => Number.isInteger(id))) {
        console.log(`ok    ${source.id.padEnd(24)} ${String(ids.length).padStart(3)} ids    json  official API`);
        return;
      }
    } catch {
      // Fall through to the explicit empty-source failure below.
    }
    broken += 1;
    console.log(`EMPTY ${source.id.padEnd(24)} official API returned no story ids`);
    return;
  }
  const feed = parseFeed(res.body, source.feed_url);
  if (feed.items.length === 0) {
    broken += 1;
    console.log(`EMPTY ${source.id.padEnd(24)} parsed 0 items (${res.body.length} bytes, kind=${feed.kind})`);
    return;
  }
  const dated = feed.items.filter((i) => i.publishedAt).length;
  const audio = feed.items.filter((i) => i.enclosure?.type?.startsWith('audio/')).length;
  console.log(
    `ok    ${source.id.padEnd(24)} ${String(feed.items.length).padStart(3)} items  ` +
      `${feed.kind.padEnd(5)} dated=${dated}${audio ? ` audio=${audio}` : ''}${feed.isPodcast ? ' [podcast]' : ''}`,
  );
});

console.log('');
console.log(broken === 0 ? 'all sources OK' : `${broken} source(s) need attention`);
process.exit(broken === 0 ? 0 : 1);
