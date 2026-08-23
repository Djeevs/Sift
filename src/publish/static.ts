import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { loadFeedItems, renderAtomFeed, renderJsonFeed, renderRssFeed } from '../server/renderFeed.js';

export interface StaticExportResult {
  outputDir: string;
  files: number;
  feeds: Array<{ id: string; atom: string; rss: string; json: string; items: number }>;
}

function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o644 });
  renameSync(temporary, path);
}

/**
 * Materialise every feed as static files. Static feeds intentionally use direct
 * publisher links: without an application server there is nowhere safe to
 * record opens, and emitting dead /open routes would break reading.
 */
export function exportStaticFeeds(
  db: Db,
  config: AppConfig,
  outputDir: string,
  publicUrl: string,
): StaticExportResult {
  const base = publicUrl.replace(/\/+$/, '');
  const feeds = [...config.feeds, config.classics.feed];
  const result: StaticExportResult = { outputDir, files: 0, feeds: [] };

  for (const feed of feeds) {
    const limit = feed.id === config.classics.feed.id
      ? config.classics.publishing.feed_length
      : config.final.final_ranking.feed_length;
    const items = loadFeedItems(db, feed.id, limit);
    const options = { tracked: false, publicUrl: base, accessToken: '' };
    const relative = {
      atom: `feed/${feed.slug}.xml`,
      rss: `feed/${feed.slug}.rss`,
      json: `feed/${feed.slug}.json`,
    };
    atomicWrite(join(outputDir, relative.atom), renderAtomFeed(db, config, feed, items, options));
    atomicWrite(join(outputDir, relative.rss), renderRssFeed(db, config, feed, items, options));
    atomicWrite(join(outputDir, relative.json), renderJsonFeed(db, config, feed, items, options));
    result.files += 3;
    result.feeds.push({ id: feed.id, ...relative, items: items.length });
  }

  const index = [
    'Sift static feeds',
    '',
    ...result.feeds.flatMap((feed) => [
      `${feed.id}:`,
      `  ${base}/${feed.atom}`,
      `  ${base}/${feed.rss}`,
      `  ${base}/${feed.json}`,
    ]),
    '',
    'Static publication is public and does not record opens. Explicit Reeder feedback can still be polled separately.',
  ].join('\n');
  atomicWrite(join(outputDir, 'index.txt'), index);
  result.files += 1;
  return result;
}
