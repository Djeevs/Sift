import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { fetchHackerNewsItems } from '../src/ingest/hackerNews.js';

describe('Hacker News discovery adapter', () => {
  const previousPrivate = process.env.SIFT_ALLOW_PRIVATE_NETWORK;
  // These tests replace fetch with an in-memory response. Skipping DNS here is
  // the explicit test/local-network escape hatch, not a production default.
  beforeEach(() => { process.env.SIFT_ALLOW_PRIVATE_NETWORK = '1'; });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousPrivate === undefined) delete process.env.SIFT_ALLOW_PRIVATE_NETWORK;
    else process.env.SIFT_ALLOW_PRIVATE_NETWORK = previousPrivate;
  });

  it('turns strong recent stories into original article candidates with secondary discovery metadata', async () => {
    const config = loadConfig();
    const source = config.sources.find((candidate) => candidate.id === 'hacker_news')!;
    const now = Date.parse('2026-08-22T12:00:00Z');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain('/v0/item/123.json');
        return new Response(
          JSON.stringify({
            id: 123,
            type: 'story',
            by: 'reader',
            time: now / 1000 - 2 * 60 * 60,
            url: 'https://example.org/original-analysis',
            score: 240,
            descendants: 95,
            title: 'A careful English analysis of a surprising new interface',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const items = await fetchHackerNewsItems(source, '[123]', 1, now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      guid: 'hn:123',
      link: 'https://example.org/original-analysis',
      images: [],
      extra: {
        discovery_source: 'hacker_news',
        hn_id: 123,
        hn_points: 240,
        hn_comment_count: 95,
        discussion_url: 'https://news.ycombinator.com/item?id=123',
      },
    });
    expect(Number(items[0]!.extra.discovery_signal)).toBeGreaterThan(0.5);
  });

  it('ignores malformed top-story responses without making requests', async () => {
    const source = loadConfig().sources.find((candidate) => candidate.id === 'hacker_news')!;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchHackerNewsItems(source, '{not-json', 1)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
