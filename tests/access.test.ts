import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { evaluateArticleAccess, explicitFreeAccess } from '../src/extract/access.js';

describe('explicit article access', () => {
  it('reads schema.org access metadata from article nodes', () => {
    expect(
      explicitFreeAccess(
        JSON.stringify([
          {
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            isAccessibleForFree: true,
          },
        ]),
      ),
    ).toBe(true);
    expect(
      explicitFreeAccess(
        JSON.stringify({
          '@graph': [
            { '@type': 'WebSite', isAccessibleForFree: true },
            { '@type': 'BlogPosting', isAccessibleForFree: 'False' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('fails closed for missing or malformed metadata', () => {
    expect(explicitFreeAccess(null)).toBeNull();
    expect(explicitFreeAccess('{not-json')).toBeNull();
    expect(explicitFreeAccess(JSON.stringify({ '@type': 'Article' }))).toBeNull();
  });

  it('requires both an explicit free declaration and a readable full article', () => {
    const source = loadConfig().sources.find((candidate) => candidate.id === 'derek_thompson')!;
    const free = JSON.stringify([{ '@type': 'NewsArticle', isAccessibleForFree: true }]);
    const paid = JSON.stringify([{ '@type': 'NewsArticle', isAccessibleForFree: false }]);

    expect(
      evaluateArticleAccess(
        source,
        { extraction_method: 'readability', body_chars: 4_000, structured_data: free },
        1_000,
      ).eligible,
    ).toBe(true);
    expect(
      evaluateArticleAccess(
        source,
        { extraction_method: 'readability', body_chars: 4_000, structured_data: paid },
        1_000,
      ).reason,
    ).toMatch(/subscriber-only/);
    expect(
      evaluateArticleAccess(
        source,
        { extraction_method: 'rss_fallback', body_chars: 4_000, structured_data: free },
        1_000,
      ).reason,
    ).toMatch(/not verifiably fully readable/);
  });
});

describe('mixed-source configuration', () => {
  it('publishes only mixed sources with both access safeguards', () => {
    const config = loadConfig();
    expect(config.sources.find((source) => source.id === 'derek_thompson')?.publishable).toBe(true);
    expect(config.sources.find((source) => source.id === 'aftermath')?.publishable).toBe(false);
    expect(config.sources.find((source) => source.id === 'gamediscoverco')?.publishable).toBe(false);
  });
});
