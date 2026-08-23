import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseFeed } from '../ingest/parseFeed.js';
import { fetchText, type FetchResult } from '../util/http.js';
import { mapPool } from '../util/pool.js';
import { atomicWrite, sourceCandidateSchema } from './index.js';

const candidateFileSchema = z.object({
  version: z.literal(1),
  candidates: z.array(sourceCandidateSchema),
});

export interface DiscoveredFeed {
  feed_url: string;
  title: string | null;
  kind: 'rss' | 'atom' | 'rdf' | 'unknown';
  language: string | null;
  item_count: number;
  sample_titles: string[];
}

export interface SourceDiscoveryResult {
  candidate: z.output<typeof sourceCandidateSchema>;
  status: 'validated' | 'not_found' | 'skipped';
  feeds: DiscoveredFeed[];
  notes: string[];
}

type Fetcher = (url: string, options?: Parameters<typeof fetchText>[1]) => Promise<FetchResult>;

function homepageUrl(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function alternateFeeds(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw || !rel.split(/\s+/).includes('alternate') || !/(?:rss|atom|xml)/.test(type)) continue;
    try {
      urls.push(new URL(raw, baseUrl).toString());
    } catch {
      // Invalid discovery links are ignored; every accepted URL is fetched
      // through the outbound SSRF guard before validation.
    }
  }
  return [...new Set(urls)];
}

function commonFeedUrls(homepage: string): string[] {
  return ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml']
    .map((path) => new URL(path, homepage).toString());
}

async function validateFeed(url: string, fetcher: Fetcher): Promise<DiscoveredFeed | null> {
  const response = await fetcher(url, { retries: 0, timeoutMs: 12_000, maxBytes: 8_000_000 });
  if (!response.ok) return null;
  const parsed = parseFeed(response.body, response.finalUrl || url);
  if (parsed.kind === 'unknown' || parsed.items.length === 0) return null;
  return {
    feed_url: response.finalUrl || url,
    title: parsed.title,
    kind: parsed.kind,
    language: parsed.language,
    item_count: parsed.items.length,
    sample_titles: parsed.items.slice(0, 3).map((item) => item.title).filter(Boolean),
  };
}

export async function discoverCandidate(
  candidate: z.output<typeof sourceCandidateSchema>,
  fetcher: Fetcher = fetchText,
): Promise<SourceDiscoveryResult> {
  if (candidate.disposition === 'avoid') {
    return { candidate, status: 'skipped', feeds: [], notes: ['Avoid candidate; discovery intentionally skipped.'] };
  }
  const homepage = homepageUrl(candidate.domain);
  if (!homepage) {
    return { candidate, status: 'not_found', feeds: [], notes: ['No valid domain was supplied.'] };
  }

  const notes: string[] = [];
  const homepageResponse = await fetcher(homepage, { retries: 0, timeoutMs: 12_000, maxBytes: 2_000_000 });
  const urls = new Set(commonFeedUrls(homepage));
  if (homepageResponse.ok) {
    const homepageFeed = parseFeed(homepageResponse.body, homepageResponse.finalUrl || homepage);
    if (homepageFeed.kind !== 'unknown' && homepageFeed.items.length > 0) urls.add(homepageResponse.finalUrl || homepage);
    for (const url of alternateFeeds(homepageResponse.body, homepageResponse.finalUrl || homepage)) urls.add(url);
  } else {
    notes.push(`Homepage fetch failed: ${homepageResponse.error ?? `HTTP ${homepageResponse.status}`}`);
  }

  const feeds: DiscoveredFeed[] = [];
  for (const url of [...urls].slice(0, 12)) {
    const validated = await validateFeed(url, fetcher);
    if (validated && !feeds.some((feed) => feed.feed_url === validated.feed_url)) feeds.push(validated);
    if (feeds.length >= 3) break;
  }
  if (feeds.length === 0) notes.push('No parseable RSS, Atom, or RDF feed was found at advertised or common locations.');
  return { candidate, status: feeds.length > 0 ? 'validated' : 'not_found', feeds, notes };
}

export async function discoverProfileSources(
  profileDir: string,
  options: { fetcher?: Fetcher; concurrency?: number; now?: Date } = {},
): Promise<SourceDiscoveryResult[]> {
  const candidatePath = resolve(profileDir, 'source-candidates.json');
  if (!existsSync(candidatePath)) throw new Error(`Source candidates not found: ${candidatePath}`);
  const parsed = candidateFileSchema.parse(JSON.parse(readFileSync(candidatePath, 'utf8')));
  const settled = await mapPool(parsed.candidates, options.concurrency ?? 3, (candidate) =>
    discoverCandidate(candidate, options.fetcher ?? fetchText));
  const results: SourceDiscoveryResult[] = settled.map((result, index) => result.ok
    ? result.value
    : {
      candidate: parsed.candidates[index]!,
      status: 'not_found',
      feeds: [],
      notes: [`Discovery failed safely: ${result.error instanceof Error ? result.error.message : String(result.error)}`],
    });
  atomicWrite(resolve(profileDir, 'source-discovery.json'), `${JSON.stringify({
    version: 1,
    discovered_at: (options.now ?? new Date()).toISOString(),
    results,
    note: 'Validated feeds are proposals only. Review them before adding entries to sources.yaml.',
  }, null, 2)}\n`);
  return results;
}
