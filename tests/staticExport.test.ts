import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { exportStaticFeeds } from '../src/publish/static.js';
import { allFeeds } from '../src/config/index.js';

describe('static feed export', () => {
  it('atomically writes every format and uses direct, public feed URLs', () => {
    const { db, config } = testDb();
    const output = mkdtempSync(join(tmpdir(), 'sift-static-'));
    const result = exportStaticFeeds(db, config, output, 'https://reader.example/sift/');
    // Every feed a reader can subscribe to, not just the always-on ones: the
    // optional lanes were exported but silently untested until the count came
    // from the same helper the exporter uses.
    expect(result.feeds).toHaveLength(allFeeds(config).length);
    expect(result.files).toBe(result.feeds.length * 3 + 1);

    const first = result.feeds[0]!;
    const atom = readFileSync(join(output, first.atom), 'utf8');
    expect(atom).toContain(`https://reader.example/sift/${first.atom}`);
    expect(atom).not.toContain('?t=');
    expect(readFileSync(join(output, first.rss), 'utf8')).toContain('<rss version="2.0"');
    expect(JSON.parse(readFileSync(join(output, first.json), 'utf8')).version).toContain('jsonfeed.org');
    db.close();
  });
});
