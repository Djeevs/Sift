import { describe, expect, it } from 'vitest';
import { loadConfig, PROJECT_ROOT } from '../src/config/index.js';
import { resolve } from 'node:path';

/**
 * The three lanes want different things from a source, so tying them to one
 * list was wrong. A high-volume wire is too noisy to publish but ideal
 * summarised in ten lines; a slow essay site is the reverse; and classics is
 * different in kind, an archive to search rather than a feed to poll.
 *
 * Narrowing a source's lanes never changes what is ingested or evaluated —
 * only where an item may surface — so an item from a briefing-only source
 * still informs clustering and saturation for the feeds.
 */
describe('source lanes', () => {
  const config = loadConfig({ configDir: resolve(PROJECT_ROOT, 'config'), reload: true });

  it('gives every source a resolved lane list', () => {
    for (const source of config.sources) {
      expect(Array.isArray(source.lanes), `${source.id} has no lanes`).toBe(true);
      expect(source.lanes.length).toBeGreaterThan(0);
    }
  });

  // Existing source lists predate the field entirely, and adding it must not
  // quietly drop anyone out of the feeds they already appear in.
  it('defaults an unlabelled source to feeds and briefing', () => {
    const unlabelled = config.sources.filter((s) => !('lanes' in s) || s.lanes.length === 2);
    expect(unlabelled.length).toBeGreaterThan(0);
    for (const source of unlabelled) {
      expect(source.lanes).toContain('feeds');
      expect(source.lanes).toContain('briefing');
    }
  });

  it('does not put anything in the classics lane by default', () => {
    // Classics mines back catalogues; opting in is deliberate, never inherited.
    expect(config.sources.every((s) => !s.lanes.includes('classics'))).toBe(true);
  });
});
