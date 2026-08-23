import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { fetchText, politeDelay } from '../util/http.js';
import { canonicalizeUrl, resolveUrl } from '../util/url.js';
import { collapseWhitespace, stripHtml, estimateReadingMinutes } from '../util/text.js';
import { parseDate, DAY_MS } from '../util/time.js';
import { mapPool } from '../util/pool.js';
import { checkRobots } from './robots.js';
import { recordError } from '../pipeline/journal.js';
import { logger } from '../util/log.js';

const log = logger('extract');

/**
 * Full-article extraction (§12).
 *
 * Fetch the page, run Readability, keep the structured data that matters
 * (including anything that hints at an audio version), and fall back to the
 * RSS content whenever anything goes wrong. Paywalls, logins and robots
 * restrictions are respected, never circumvented.
 */

export interface AudioLink {
  url: string;
  kind: 'enclosure' | 'audio_tag' | 'link' | 'structured_data' | 'embed';
  title?: string | null;
  publisher?: string | null;
  durationMinutes?: number | null;
  platform?: string | null;
}

export interface ExtractedArticle {
  fetchedUrl: string;
  canonicalUrl: string | null;
  title: string | null;
  subtitle: string | null;
  author: string | null;
  publishedAt: number | null;
  bodyText: string;
  siteName: string | null;
  leadImageUrl: string | null;
  structuredData: unknown[];
  audioLinks: AudioLink[];
  method: 'readability' | 'rss_fallback' | 'failed';
  httpStatus: number | null;
  error?: string;
}

const PODCAST_HOST_PATTERNS: Array<[RegExp, string]> = [
  [/open\.spotify\.com/i, 'spotify'],
  [/podcasts\.apple\.com/i, 'apple'],
  [/overcast\.fm/i, 'overcast'],
  [/pocketcasts\.com/i, 'pocketcasts'],
  [/megaphone\.fm|simplecast|libsyn|buzzsprout|transistor\.fm|acast|podbean|anchor\.fm|captivate\.fm|fireside\.fm/i, 'host'],
  [/youtube\.com|youtu\.be/i, 'youtube'],
];

function detectPlatform(url: string): string | null {
  for (const [re, name] of PODCAST_HOST_PATTERNS) if (re.test(url)) return name;
  return null;
}

/** Parse a fetched HTML document. Exported so tests can run it without network. */
export function extractFromHtml(html: string, url: string): ExtractedArticle {
  const base: ExtractedArticle = {
    fetchedUrl: url,
    canonicalUrl: canonicalizeUrl(url),
    title: null,
    subtitle: null,
    author: null,
    publishedAt: null,
    bodyText: '',
    siteName: null,
    leadImageUrl: null,
    structuredData: [],
    audioLinks: [],
    method: 'failed',
    httpStatus: null,
  };

  // jsdom is noisy about CSS it cannot parse; none of that matters here.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('jsdomError', () => {});

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url, virtualConsole });
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const doc = dom.window.document;

  const meta = (selector: string): string | null => {
    const el = doc.querySelector(selector);
    const content = el?.getAttribute('content') ?? el?.textContent ?? null;
    return content ? collapseWhitespace(content) || null : null;
  };

  base.canonicalUrl =
    canonicalizeUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null) ?? base.canonicalUrl;
  base.siteName = meta('meta[property="og:site_name"]');
  base.leadImageUrl = meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]');
  base.subtitle =
    meta('meta[property="og:description"]') ?? meta('meta[name="description"]') ?? null;
  base.author =
    meta('meta[name="author"]') ??
    meta('meta[property="article:author"]') ??
    meta('[itemprop="author"]') ??
    null;
  base.publishedAt =
    parseDate(meta('meta[property="article:published_time"]')) ??
    parseDate(meta('meta[name="date"]')) ??
    parseDate(doc.querySelector('time[datetime]')?.getAttribute('datetime') ?? null);

  // --- Structured data, including podcast/audio metadata ---
  const structured: unknown[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      structured.push(parsed);
    } catch {
      /* malformed JSON-LD is extremely common; ignore it */
    }
  }
  base.structuredData = structured;

  const audio: AudioLink[] = [];
  const seenAudio = new Set<string>();
  const pushAudio = (link: AudioLink | null) => {
    if (!link) return;
    const canonical = canonicalizeUrl(link.url) ?? link.url;
    if (seenAudio.has(canonical)) return;
    seenAudio.add(canonical);
    audio.push({ ...link, platform: link.platform ?? detectPlatform(link.url) });
  };

  for (const node of structured) {
    for (const obj of flattenJsonLd(node)) {
      const type = String((obj['@type'] as string) ?? '').toLowerCase();
      if (!/podcastepisode|audioobject|episode/.test(type)) continue;
      const contentUrl =
        (obj['contentUrl'] as string) ?? (obj['url'] as string) ?? (obj['associatedMedia'] as { contentUrl?: string })?.contentUrl;
      if (typeof contentUrl !== 'string') continue;
      const duration = parseIso8601Duration(obj['duration'] as string | undefined);
      pushAudio({
        url: resolveUrl(url, contentUrl) ?? contentUrl,
        kind: 'structured_data',
        title: typeof obj['name'] === 'string' ? obj['name'] : null,
        publisher: extractPublisher(obj),
        durationMinutes: duration,
      });
    }
  }

  for (const el of doc.querySelectorAll('audio[src], audio source[src]')) {
    const src = el.getAttribute('src');
    if (src) pushAudio({ url: resolveUrl(url, src) ?? src, kind: 'audio_tag' });
  }

  for (const el of doc.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (!href) continue;
    const absolute = resolveUrl(url, href);
    if (!absolute) continue;
    const platform = detectPlatform(absolute);
    const isAudioFile = /\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(absolute);
    if (!platform && !isAudioFile) continue;
    // A site-wide "listen on Spotify" footer link is not an episode link.
    const text = collapseWhitespace(el.textContent ?? '').toLowerCase();
    const looksLikeEpisode =
      isAudioFile || /episode|listen|podcast|audio version|hear/.test(text) || /\/episode\//i.test(absolute);
    if (!looksLikeEpisode) continue;
    pushAudio({ url: absolute, kind: 'link', title: collapseWhitespace(el.textContent ?? '') || null, platform });
  }

  for (const el of doc.querySelectorAll('iframe[src], embed[src]')) {
    const src = el.getAttribute('src');
    if (!src) continue;
    const absolute = resolveUrl(url, src);
    if (!absolute) continue;
    const platform = detectPlatform(absolute);
    if (platform) pushAudio({ url: absolute, kind: 'embed', platform });
  }

  base.audioLinks = audio;

  // --- Article body ---
  try {
    // Readability mutates the document, so run it after everything else.
    const reader = new Readability(doc, { charThreshold: 250, keepClasses: false });
    const parsed = reader.parse();
    if (parsed?.textContent) {
      base.title = parsed.title ? collapseWhitespace(parsed.title) : base.title;
      base.author = parsed.byline ? collapseWhitespace(parsed.byline) : base.author;
      base.siteName = parsed.siteName ?? base.siteName;
      base.subtitle = parsed.excerpt ? collapseWhitespace(parsed.excerpt) : base.subtitle;
      base.bodyText = cleanBody(parsed.textContent);
      base.method = 'readability';
    }
  } catch (err) {
    log.debug(`readability failed for ${url}`, err);
  }

  if (!base.title) base.title = meta('meta[property="og:title"]') ?? (collapseWhitespace(doc.title ?? '') || null);

  return base;
}

/** Remove the boilerplate Readability leaves behind. */
function cleanBody(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((l) => collapseWhitespace(l))
    .filter(Boolean);

  const junk =
    /^(share this|share on|subscribe( now)?|sign up|newsletter|advertisement|related( stories| articles| reading)?|read more|follow us|comments?|tags?:|cookie|accept all|privacy policy|terms of (use|service)|copyright|all rights reserved|photo(graph)? by|image credit|getty images)\b/i;

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length < 40 && junk.test(line)) continue;
    // Repeated short lines are navigation remnants.
    if (line.length < 80) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    kept.push(line);
  }
  return kept.join('\n\n').trim();
}

function flattenJsonLd(node: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 6 || node == null) return [];
  if (Array.isArray(node)) return node.flatMap((n) => flattenJsonLd(n, depth + 1));
  if (typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const out: Array<Record<string, unknown>> = [obj];
  for (const key of ['@graph', 'itemListElement', 'associatedMedia', 'hasPart', 'mainEntity']) {
    if (obj[key]) out.push(...flattenJsonLd(obj[key], depth + 1));
  }
  return out;
}

function extractPublisher(obj: Record<string, unknown>): string | null {
  const publisher = obj['publisher'] ?? obj['partOfSeries'] ?? obj['author'];
  if (typeof publisher === 'string') return publisher;
  if (publisher && typeof publisher === 'object') {
    const name = (publisher as Record<string, unknown>)['name'];
    if (typeof name === 'string') return name;
  }
  return null;
}

/** ISO 8601 duration ("PT42M10S") to minutes. */
export function parseIso8601Duration(value: string | undefined): number | null {
  if (!value || typeof value !== 'string') return null;
  const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  const seconds = Number(m[3] ?? 0);
  const total = hours * 60 + minutes + seconds / 60;
  return total > 0 ? Math.round(total) : null;
}

export interface ExtractStats {
  attempted: number;
  extracted: number;
  cached: number;
  fallback: number;
  blocked: number;
  failed: number;
}

/** Fetch and extract for a set of items, writing results into article_content. */
export async function extractForItems(
  db: Db,
  config: AppConfig,
  itemIds: string[],
): Promise<ExtractStats> {
  const stats: ExtractStats = { attempted: 0, extracted: 0, cached: 0, fallback: 0, blocked: 0, failed: 0 };
  if (!config.pipeline.extraction.enabled || itemIds.length === 0) return stats;

  const cfg = config.pipeline.extraction;
  const cacheCutoff = Date.now() - cfg.cache_ttl_days * DAY_MS;
  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));

  const rows = db.all<{
    id: string;
    source_id: string;
    canonical_url: string | null;
    original_url: string | null;
    title: string;
    rss_summary: string | null;
    rss_content: string | null;
    author: string | null;
    publication_time: number | null;
  }>(
    `SELECT id, source_id, canonical_url, original_url, title, rss_summary, rss_content, author, publication_time
     FROM feed_items WHERE id IN (${itemIds.map((_, i) => `:id${i}`).join(',')})`,
    Object.fromEntries(itemIds.map((id, i) => [`id${i}`, id])),
  );

  await mapPool(rows, cfg.concurrency, async (row) => {
    stats.attempted += 1;

    const cached = db.get<{ fetched_at: number; extraction_method: string }>(
      `SELECT fetched_at, extraction_method FROM article_content WHERE item_id = :id`,
      { id: row.id },
    );
    if (cached && cached.fetched_at > cacheCutoff && cached.extraction_method !== 'failed') {
      stats.cached += 1;
      return;
    }

    const url = row.canonical_url ?? row.original_url;
    const source = sourceMap.get(row.source_id);

    const writeFallback = (reason: string, status: number | null) => {
      const body = stripHtml(row.rss_content ?? row.rss_summary ?? '');
      saveContent(db, row.id, {
        fetchedUrl: url ?? '',
        canonicalUrl: row.canonical_url,
        title: row.title,
        subtitle: null,
        author: row.author,
        publishedAt: row.publication_time,
        bodyText: body,
        siteName: source?.name ?? null,
        leadImageUrl: null,
        structuredData: [],
        audioLinks: [],
        method: 'rss_fallback',
        httpStatus: status,
        error: reason,
      });
      stats.fallback += 1;
    };

    if (!url) return writeFallback('no URL to fetch', null);
    if (source?.hard_rules?.never_extract) return writeFallback('source rule: never_extract', null);

    if (cfg.respect_robots) {
      const verdict = await checkRobots(url, config.env.userAgent);
      if (!verdict.allowed) {
        stats.blocked += 1;
        log.info(`robots.txt disallows ${url}; using RSS content instead`);
        return writeFallback(`robots.txt: ${verdict.reason}`, null);
      }
      if (verdict.crawlDelayMs) await politeDelay(url, verdict.crawlDelayMs);
    }

    await politeDelay(url, cfg.per_host_delay_ms);

    const res = await fetchText(url, {
      timeoutMs: cfg.timeout_ms,
      maxBytes: cfg.max_bytes,
      retries: 1,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    if (!res.ok) {
      stats.failed += 1;
      recordError(db, row.id, 'extract', `fetch failed: ${res.status} ${res.error ?? ''}`);
      return writeFallback(`fetch failed: ${res.status}`, res.status);
    }

    const contentType = res.contentType ?? '';
    if (contentType && !/html|xml|text/i.test(contentType)) {
      return writeFallback(`unsupported content-type: ${contentType}`, res.status);
    }

    const article = extractFromHtml(res.body, res.finalUrl);
    article.httpStatus = res.status;

    if (article.bodyText.length < cfg.min_extracted_chars) {
      // Paywalled or JS-rendered pages land here. That is fine: fall back
      // rather than attempting to work around the restriction.
      const rssBody = stripHtml(row.rss_content ?? row.rss_summary ?? '');
      if (rssBody.length > article.bodyText.length) {
        saveContent(db, row.id, {
          ...article,
          bodyText: rssBody,
          method: 'rss_fallback',
          error: `extracted only ${article.bodyText.length} chars`,
        });
        stats.fallback += 1;
        return;
      }
    }

    saveContent(db, row.id, article);
    if (article.method === 'readability') stats.extracted += 1;
    else stats.fallback += 1;
  });

  log.info(
    `extraction: ${stats.extracted} full, ${stats.fallback} fallback, ${stats.cached} cached, ${stats.blocked} robots-blocked, ${stats.failed} failed`,
  );
  return stats;
}

function saveContent(db: Db, itemId: string, article: ExtractedArticle): void {
  const words = article.bodyText ? article.bodyText.trim().split(/\s+/).length : 0;
  db.run(
    `INSERT INTO article_content (
        item_id, fetched_url, canonical_url, title, subtitle, author, published_at, body_text,
        body_chars, word_count, reading_minutes, site_name, lead_image_url, structured_data,
        audio_links, extraction_method, http_status, error, fetched_at)
     VALUES (
        :item_id, :fetched_url, :canonical_url, :title, :subtitle, :author, :published_at, :body,
        :chars, :words, :minutes, :site, :image, :structured, :audio, :method, :status, :error, :ts)
     ON CONFLICT(item_id) DO UPDATE SET
        fetched_url = excluded.fetched_url, canonical_url = excluded.canonical_url,
        title = excluded.title, subtitle = excluded.subtitle, author = excluded.author,
        published_at = excluded.published_at, body_text = excluded.body_text,
        body_chars = excluded.body_chars, word_count = excluded.word_count,
        reading_minutes = excluded.reading_minutes, site_name = excluded.site_name,
        lead_image_url = excluded.lead_image_url, structured_data = excluded.structured_data,
        audio_links = excluded.audio_links, extraction_method = excluded.extraction_method,
        http_status = excluded.http_status, error = excluded.error, fetched_at = excluded.fetched_at`,
    {
      item_id: itemId,
      fetched_url: article.fetchedUrl,
      canonical_url: article.canonicalUrl,
      title: article.title,
      subtitle: article.subtitle,
      author: article.author,
      published_at: article.publishedAt,
      body: article.bodyText,
      chars: article.bodyText.length,
      words,
      minutes: estimateReadingMinutes(article.bodyText),
      site: article.siteName,
      image: article.leadImageUrl,
      structured: JSON.stringify(article.structuredData).slice(0, 100_000),
      audio: JSON.stringify(article.audioLinks),
      method: article.method,
      status: article.httpStatus,
      error: article.error ?? null,
      ts: Date.now(),
    },
  );
}
