import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseWranglerToml,
  renderWranglerToml,
  patchTomlText,
  extractNamespaceId,
  extractDatabaseId,
  extractWorkerUrl,
  parseWhoami,
} from '../src/cloudflare/wrangler.js';
import { PROJECT_ROOT } from '../src/config/index.js';

const EXAMPLE_TOML = readFileSync(resolve(PROJECT_ROOT, 'worker/wrangler.example.toml'), 'utf8');

/**
 * `npm run cloud:setup` exists so a non-technical reader never edits
 * wrangler.toml or copies an id out of terminal output by hand. All of that
 * rests on these parsers reading wrangler's actual output correctly, so they
 * are tested against real example output rather than only against
 * hand-written fixtures.
 */
describe('reading wrangler.toml', () => {
  it('reports nothing configured for a file that does not exist', () => {
    expect(parseWranglerToml(null)).toEqual({
      exists: false, name: null, kvNamespaceId: null, d1DatabaseName: null, d1DatabaseId: null,
    });
  });

  it('treats placeholder ids as not-yet-configured', () => {
    const status = parseWranglerToml(EXAMPLE_TOML);
    expect(status.exists).toBe(true);
    expect(status.kvNamespaceId).toBeNull();
    expect(status.d1DatabaseId).toBeNull();
    expect(status.d1DatabaseName).toBe('sift-reader-name-events');
  });

  it('reads real ids once they are filled in', () => {
    const filled = EXAMPLE_TOML
      .replace('REPLACE_WITH_KV_NAMESPACE_ID', 'abc123')
      .replace('REPLACE_WITH_D1_DATABASE_ID', '11111111-2222-3333-4444-555555555555');
    const status = parseWranglerToml(filled);
    expect(status.kvNamespaceId).toBe('abc123');
    expect(status.d1DatabaseId).toBe('11111111-2222-3333-4444-555555555555');
  });
});

describe('scoping the example config to one reader', () => {
  it('renames the worker and the database to match the reader', () => {
    const rendered = renderWranglerToml(EXAMPLE_TOML, 'alice');
    expect(parseWranglerToml(rendered).name).toBe('sift-alice');
    expect(parseWranglerToml(rendered).d1DatabaseName).toBe('sift-alice-events');
  });
});

describe('patching in a created resource id', () => {
  it('replaces the placeholder id with a real one', () => {
    const patched = patchTomlText(EXAMPLE_TOML, { id: 'abc123' });
    expect(parseWranglerToml(patched).kvNamespaceId).toBe('abc123');
  });

  it('refuses to patch a key the file does not have, rather than silently no-op', () => {
    expect(() => patchTomlText(EXAMPLE_TOML, { not_a_real_key: 'x' })).toThrow(/no ".*" line/);
  });

  it('leaves every other line untouched', () => {
    const patched = patchTomlText(EXAMPLE_TOML, { id: 'abc123' });
    expect(patched).toContain('binding = "SIFT_FEEDS"');
    expect(patched).toContain('compatibility_date = "2026-08-01"');
  });
});

describe('reading wrangler command output', () => {
  it('extracts a KV namespace id from a real creation reply', () => {
    const output = [
      '🌀 Creating namespace with title "sift-alice-SIFT_FEEDS"',
      '✨ Success!',
      'Add the following to your configuration file in your kv_namespaces array:',
      '[[kv_namespaces]]',
      'binding = "SIFT_FEEDS"',
      'id = "3f2504e04f8911d39a0c0305e82c3301"',
    ].join('\n');
    expect(extractNamespaceId(output)).toBe('3f2504e04f8911d39a0c0305e82c3301');
  });

  it('extracts a D1 database id from a real creation reply', () => {
    const output = [
      '✅ Successfully created DB \'sift-alice-events\'',
      '[[d1_databases]]',
      'binding = "SIFT_DB"',
      'database_name = "sift-alice-events"',
      'database_id = "11111111-2222-3333-4444-555555555555"',
    ].join('\n');
    expect(extractDatabaseId(output)).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('extracts the deployed workers.dev URL', () => {
    const output = 'Uploaded sift-alice (1.23 sec)\nPublished sift-alice (0.45 sec)\n  https://sift-alice.someone.workers.dev\nCurrent Version ID: abc';
    expect(extractWorkerUrl(output)).toBe('https://sift-alice.someone.workers.dev');
  });

  it('returns null rather than throwing when the shape is unrecognised', () => {
    expect(extractNamespaceId('nothing useful here')).toBeNull();
    expect(extractDatabaseId('nothing useful here')).toBeNull();
    expect(extractWorkerUrl('nothing useful here')).toBeNull();
  });
});

describe('reading wrangler whoami', () => {
  it('reports the account when logged in', () => {
    const output = "👋 You are logged in with an OAuth Token, associated with the email 'reader@example.com'!";
    expect(parseWhoami(output)).toBe('reader@example.com');
  });

  it('reports not logged in without guessing an account', () => {
    expect(parseWhoami('You are not authenticated. Please run `wrangler login`.')).toBeNull();
  });
});
