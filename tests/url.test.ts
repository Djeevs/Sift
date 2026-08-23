import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, hostOf, publisherDomain, sameArticle } from '../src/util/url.js';

describe('canonicalizeUrl', () => {
  it('normalises scheme, host and trailing slash', () => {
    expect(canonicalizeUrl('http://WWW.Example.com/post/')).toBe('https://example.com/post');
    expect(canonicalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_source=rss&utm_medium=feed&id=7')).toBe(
      'https://example.com/a?id=7',
    );
    expect(canonicalizeUrl('https://example.com/a?fbclid=xyz')).toBe('https://example.com/a');
    expect(canonicalizeUrl('https://example.com/p?page=2')).toBe('https://example.com/p?page=2');
  });

  it('sorts query parameters so ordering cannot create duplicates', () => {
    expect(canonicalizeUrl('https://example.com/a?b=2&a=1')).toBe(canonicalizeUrl('https://example.com/a?a=1&b=2'));
  });

  it('drops fragments but keeps hashbang routes', () => {
    expect(canonicalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
    expect(canonicalizeUrl('https://example.com/a#!/deep')).toBe('https://example.com/a#!/deep');
  });

  it('repairs protocol-relative and scheme-less URLs', () => {
    expect(canonicalizeUrl('//example.com/x')).toBe('https://example.com/x');
    expect(canonicalizeUrl('example.com/x')).toBe('https://example.com/x');
  });

  it('rejects unusable input', () => {
    expect(canonicalizeUrl(null)).toBeNull();
    expect(canonicalizeUrl('')).toBeNull();
    expect(canonicalizeUrl('   ')).toBeNull();
    expect(canonicalizeUrl('mailto:a@b.com')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('collapses duplicate slashes in paths', () => {
    expect(canonicalizeUrl('https://example.com//a//b')).toBe('https://example.com/a/b');
  });

  it('is idempotent', () => {
    const once = canonicalizeUrl('http://www.Example.com/Post/?utm_source=x#frag');
    expect(canonicalizeUrl(once)).toBe(once);
  });
});

describe('hostOf / publisherDomain', () => {
  it('extracts hosts without www', () => {
    expect(hostOf('https://www.theverge.com/2024/1/1/x')).toBe('theverge.com');
  });

  it('reduces subdomains to a publisher domain', () => {
    expect(publisherDomain('https://daily.bandcamp.com/features/x')).toBe('bandcamp.com');
    expect(publisherDomain('https://news.bbc.co.uk/story')).toBe('bbc.co.uk');
    expect(publisherDomain('https://example.com/x')).toBe('example.com');
  });
});

describe('sameArticle', () => {
  it('sees through tracking noise', () => {
    expect(sameArticle('https://a.com/p?utm_source=rss', 'http://www.a.com/p/')).toBe(true);
    expect(sameArticle('https://a.com/p', 'https://a.com/q')).toBe(false);
    expect(sameArticle(null, 'https://a.com/p')).toBe(false);
  });
});
