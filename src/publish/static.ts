import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { allFeeds } from '../config/index.js';
import { renderFeedDocuments } from '../server/renderFeed.js';

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
  const result: StaticExportResult = { outputDir, files: 0, feeds: [] };

  for (const feed of allFeeds(config)) {
    const documents = renderFeedDocuments(db, config, feed, {
      tracked: false,
      publicUrl: base,
      accessToken: '',
    });
    const relative = {
      atom: `feed/${feed.slug}.xml`,
      rss: `feed/${feed.slug}.rss`,
      json: `feed/${feed.slug}.json`,
    };
    atomicWrite(join(outputDir, relative.atom), documents.atom);
    atomicWrite(join(outputDir, relative.rss), documents.rss);
    atomicWrite(join(outputDir, relative.json), documents.json);
    result.files += 3;
    result.feeds.push({ id: feed.id, ...relative, items: documents.entries });
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
