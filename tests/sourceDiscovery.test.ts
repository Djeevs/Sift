import { describe, expect, it, vi } from 'vitest';
import { discoverCandidate } from '../src/onboarding/sourceDiscovery.js';
import type { FetchResult } from '../src/util/http.js';

function response(url: string, body: string, ok = true): FetchResult {
  return {
    ok,
    status: ok ? 200 : 404,
    notModified: false,
    body,
    finalUrl: url,
    etag: null,
    lastModified: null,
    contentType: ok ? 'application/xml' : null,
    error: ok ? undefined : 'HTTP 404',
  };
}

const candidate = {
  name: 'Example Review',
  domain: 'example.com',
  disposition: 'recommended' as const,
  role: 'selective' as const,
  content_areas: ['explanatory reporting'],
  caveats: [],
  reason: 'A strong candidate for explanatory reporting.',
  basis: 'inferred' as const,
  confidence: 0.8,
};

describe('onboarding source discovery', () => {
  it('discovers an advertised feed and validates that it contains parseable items', async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Review</title>
      <link>https://example.com/</link><item><title>A useful investigation</title>
      <link>https://example.com/article</link><guid>one</guid></item></channel></rss>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return response(url, '<html><head><link rel="alternate" type="application/rss+xml" href="/news.xml"></head></html>');
      }
      if (url === 'https://example.com/news.xml') return response(url, feed);
      return response(url, '', false);
    });
    const result = await discoverCandidate(candidate, fetcher);
    expect(result.status).toBe('validated');
    expect(result.feeds[0]?.feed_url).toBe('https://example.com/news.xml');
    expect(result.feeds[0]?.sample_titles).toContain('A useful investigation');
  });

  it('does not fetch candidates the assistant marked as avoid', async () => {
    const fetcher = vi.fn();
    const result = await discoverCandidate({ ...candidate, disposition: 'avoid' }, fetcher);
    expect(result.status).toBe('skipped');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
