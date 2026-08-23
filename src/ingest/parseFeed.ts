import { XMLParser } from 'fast-xml-parser';
import { canonicalizeUrl, resolveUrl } from '../util/url.js';
import { parseDate, durationToMinutes } from '../util/time.js';
import { collapseWhitespace, stripHtml } from '../util/text.js';

/**
 * RSS 2.0 / RDF 1.0 / Atom 1.0 parsing, plus the podcast namespaces.
 *
 * Real feeds are messy: single items instead of arrays, HTML in titles, CDATA
 * everywhere, missing guids, dc:* instead of the standard elements, relative
 * links. Everything here is defensive by design; nothing throws on bad input.
 */

export interface ParsedEnclosure {
  url: string;
  type: string | null;
  length: number | null;
}

export interface ParsedImage {
  url: string;
  alt: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  source: 'media' | 'enclosure' | 'feed_content' | 'item_field';
}

export interface ParsedItem {
  guid: string | null;
  title: string;
  link: string | null;
  subtitle: string | null;
  summary: string | null;
  content: string | null;
  author: string | null;
  publishedAt: number | null;
  categories: string[];
  enclosure: ParsedEnclosure | null;
  durationMinutes: number | null;
  images: ParsedImage[];
  language: string | null;
  /** Anything else worth keeping, stored as raw_feed_metadata. */
  extra: Record<string, unknown>;
}

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'rdf' | 'unknown';
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  language: string | null;
  isPodcast: boolean;
  items: ParsedItem[];
}

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: '#cdata',
  textNodeName: '#text',
  // Namespace prefixes are kept: dc:creator and itunes:duration both matter.
  removeNSPrefix: false,
  isArray: (name: string) =>
    ['item', 'entry', 'category', 'link', 'enclosure', 'media:content', 'media:thumbnail'].includes(name),
  /**
   * The library's billion-laughs guard defaults to 1000 entity expansions per
   * document, which real feeds exceed routinely -- a full-text feed of
   * HTML-escaped posts blows past it and the whole source parses to nothing.
   * The limits are raised, not removed, and feed downloads are already capped
   * by maxBytes in the fetch layer.
   */
  processEntities: {
    enabled: true,
    maxEntitySize: 100_000,
    maxTotalExpansions: 2_000_000,
    maxExpandedLength: 20_000_000,
    maxEntityCount: 200_000,
  },
} as const;

const parser = new XMLParser(PARSER_OPTIONS);

/** Fallback for documents the strict parser rejects outright. */
const lenientParser = new XMLParser({ ...PARSER_OPTIONS, processEntities: false });

type Node = Record<string, unknown> | string | number | null | undefined;

/** Read a node's text no matter how the parser represented it. */
function text(node: Node): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = text(n as Node);
      if (t) return t;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const cdata = obj['#cdata'];
  if (typeof cdata === 'string' && cdata.trim()) return cdata.trim();
  if (Array.isArray(cdata)) {
    const joined = cdata.filter((c) => typeof c === 'string').join('').trim();
    if (joined) return joined;
  }
  const inner = obj['#text'];
  if (typeof inner === 'string' && inner.trim()) return inner.trim();
  if (typeof inner === 'number') return String(inner);
  return null;
}

function first<T = unknown>(node: unknown): T | undefined {
  return (Array.isArray(node) ? node[0] : node) as T | undefined;
}

function asArray<T>(node: unknown): T[] {
  if (node == null) return [];
  return (Array.isArray(node) ? node : [node]) as T[];
}

/** Pick the first present key from a node, tolerating namespace variants. */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return undefined;
}

function pickText(obj: Record<string, unknown>, keys: string[]): string | null {
  return text(pick(obj, keys) as Node);
}

function cleanTitle(raw: string | null): string {
  if (!raw) return '';
  // Titles legitimately contain entities; some feeds put whole HTML in them.
  return collapseWhitespace(stripHtml(raw)) || collapseWhitespace(raw);
}

function extractAtomLink(entry: Record<string, unknown>, baseUrl: string | null): string | null {
  const links = asArray<Record<string, unknown> | string>(entry['link']);
  let fallback: string | null = null;
  for (const link of links) {
    if (typeof link === 'string') {
      fallback ??= link;
      continue;
    }
    const href = typeof link['@href'] === 'string' ? link['@href'] : null;
    if (!href) continue;
    const rel = typeof link['@rel'] === 'string' ? link['@rel'] : 'alternate';
    const type = typeof link['@type'] === 'string' ? link['@type'] : '';
    if (rel === 'alternate' && (!type || type.includes('html'))) return resolveUrl(baseUrl, href) ?? href;
    if (rel === 'self' || rel === 'enclosure') continue;
    fallback ??= resolveUrl(baseUrl, href) ?? href;
  }
  return fallback;
}

function extractEnclosure(node: Record<string, unknown>, baseUrl: string | null): ParsedEnclosure | null {
  // RSS <enclosure>, Atom <link rel="enclosure">, and media:content.
  for (const enc of asArray<Record<string, unknown>>(node['enclosure'])) {
    const url = typeof enc['@url'] === 'string' ? enc['@url'] : text(enc as Node);
    if (!url) continue;
    return {
      url: resolveUrl(baseUrl, url) ?? url,
      type: typeof enc['@type'] === 'string' ? enc['@type'] : null,
      length: Number.isFinite(Number(enc['@length'])) ? Number(enc['@length']) : null,
    };
  }
  for (const link of asArray<Record<string, unknown>>(node['link'])) {
    if (typeof link !== 'object' || link === null) continue;
    if (link['@rel'] !== 'enclosure') continue;
    const href = typeof link['@href'] === 'string' ? link['@href'] : null;
    if (!href) continue;
    return {
      url: resolveUrl(baseUrl, href) ?? href,
      type: typeof link['@type'] === 'string' ? link['@type'] : null,
      length: Number.isFinite(Number(link['@length'])) ? Number(link['@length']) : null,
    };
  }
  const media = first<Record<string, unknown>>(node['media:content']);
  if (media && typeof media === 'object') {
    const url = typeof media['@url'] === 'string' ? media['@url'] : null;
    const type = typeof media['@type'] === 'string' ? media['@type'] : null;
    if (url && (type?.startsWith('audio/') || type?.startsWith('video/'))) {
      return { url: resolveUrl(baseUrl, url) ?? url, type, length: null };
    }
  }
  return null;
}

function numericAttribute(node: Record<string, unknown>, key: string): number | null {
  const value = Number(node[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function imageCandidate(
  url: string | null,
  baseUrl: string | null,
  meta: Partial<ParsedImage> & Pick<ParsedImage, 'source'>,
): ParsedImage | null {
  if (!url) return null;
  const absolute = resolveUrl(baseUrl, url) ?? url;
  if (!/^https?:\/\//i.test(absolute)) return null;
  const width = meta.width ?? null;
  const height = meta.height ?? null;
  if ((width !== null && width <= 32) || (height !== null && height <= 32)) return null;
  if (/(?:^|[\/_\-.])(tracking|tracker|pixel|beacon|spacer|avatar|author|logo|icon)(?:[\/_\-.]|$)/i.test(absolute)) {
    return null;
  }
  return {
    url: absolute,
    alt: meta.alt ? collapseWhitespace(stripHtml(meta.alt)) || null : null,
    caption: meta.caption ? collapseWhitespace(stripHtml(meta.caption)) || null : null,
    width,
    height,
    source: meta.source,
  };
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function imagesFromHtml(html: string | null, baseUrl: string | null): ParsedImage[] {
  if (!html) return [];
  const images: ParsedImage[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    let src = htmlAttribute(tag, 'src') ?? htmlAttribute(tag, 'data-src') ?? htmlAttribute(tag, 'data-original');
    if (!src) {
      const srcset = htmlAttribute(tag, 'srcset') ?? htmlAttribute(tag, 'data-srcset');
      src = srcset?.split(',').at(-1)?.trim().split(/\s+/)[0] ?? null;
    }
    const image = imageCandidate(src, baseUrl, {
      source: 'feed_content',
      alt: htmlAttribute(tag, 'alt'),
      width: numericAttribute({ width: htmlAttribute(tag, 'width') }, 'width'),
      height: numericAttribute({ height: htmlAttribute(tag, 'height') }, 'height'),
    });
    if (image) images.push(image);
  }
  return images;
}

function extractImages(
  node: Record<string, unknown>,
  baseUrl: string | null,
  summary: string | null,
  content: string | null,
): ParsedImage[] {
  const images: ParsedImage[] = [];
  const push = (image: ParsedImage | null) => {
    if (!image || images.some((existing) => existing.url === image.url)) return;
    images.push(image);
  };

  const mediaNodes = [
    ...asArray<Record<string, unknown>>(node['media:content']),
    ...asArray<Record<string, unknown>>(node['media:thumbnail']),
    ...asArray<Record<string, unknown>>((first<Record<string, unknown>>(node['media:group']) ?? {})['media:content']),
    ...asArray<Record<string, unknown>>((first<Record<string, unknown>>(node['media:group']) ?? {})['media:thumbnail']),
  ];
  for (const media of mediaNodes) {
    const url = typeof media['@url'] === 'string' ? media['@url'] : null;
    const type = typeof media['@type'] === 'string' ? media['@type'] : '';
    const medium = typeof media['@medium'] === 'string' ? media['@medium'] : '';
    if (type && !type.startsWith('image/') && medium !== 'image') continue;
    push(
      imageCandidate(url, baseUrl, {
        source: 'media',
        alt: pickText(media, ['media:title', 'title']),
        caption: pickText(media, ['media:description', 'description']),
        width: numericAttribute(media, '@width'),
        height: numericAttribute(media, '@height'),
      }),
    );
  }

  for (const enc of asArray<Record<string, unknown>>(node['enclosure'])) {
    const type = typeof enc['@type'] === 'string' ? enc['@type'] : '';
    const url = typeof enc['@url'] === 'string' ? enc['@url'] : text(enc as Node);
    if (!type.startsWith('image/') && !/\.(?:avif|gif|jpe?g|png|webp)(?:\?|$)/i.test(url ?? '')) continue;
    push(imageCandidate(url, baseUrl, { source: 'enclosure' }));
  }

  const imageField = first<Record<string, unknown> | string>(node['image'] ?? node['itunes:image']);
  if (typeof imageField === 'string') {
    push(imageCandidate(imageField, baseUrl, { source: 'item_field' }));
  } else if (imageField && typeof imageField === 'object') {
    push(
      imageCandidate(
        (typeof imageField['@href'] === 'string' ? imageField['@href'] : null) ?? pickText(imageField, ['url']),
        baseUrl,
        { source: 'item_field' },
      ),
    );
  }

  for (const image of [...imagesFromHtml(content, baseUrl), ...imagesFromHtml(summary, baseUrl)]) push(image);
  return images.slice(0, 8);
}

function extractCategories(node: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const cat of asArray<unknown>(node['category'])) {
    if (typeof cat === 'string') {
      const v = cat.trim();
      if (v) out.add(v);
      continue;
    }
    if (cat && typeof cat === 'object') {
      const obj = cat as Record<string, unknown>;
      const term = typeof obj['@term'] === 'string' ? obj['@term'] : null;
      const label = typeof obj['@label'] === 'string' ? obj['@label'] : null;
      const inner = text(obj as Node);
      for (const v of [term, label, inner]) if (v?.trim()) out.add(v.trim());
    }
  }
  for (const tag of asArray<unknown>(node['dc:subject'])) {
    const v = text(tag as Node);
    if (v) out.add(v);
  }
  return [...out].slice(0, 25);
}

/** Some CMSes put a numeric user id in dc:creator; that is not a byline. */
function usableAuthor(value: string | null): string | null {
  if (!value) return null;
  const clean = collapseWhitespace(value);
  if (!clean || /^\d+$/.test(clean) || clean.length > 120) return null;
  return clean;
}

function extractAuthor(node: Record<string, unknown>): string | null {
  const direct = pickText(node, ['dc:creator', 'author', 'itunes:author', 'creator']);
  if (direct && !direct.includes('<')) {
    // RSS <author> is often "email (Name)".
    const m = /\(([^)]+)\)\s*$/.exec(direct);
    return usableAuthor(m ? m[1]! : direct.replace(/^[^\s@]+@[^\s@]+\s*/, ''));
  }
  const authorObj = first<Record<string, unknown>>(node['author']);
  if (authorObj && typeof authorObj === 'object') {
    const name = pickText(authorObj, ['name', '#text']);
    const usable = usableAuthor(name);
    if (usable) return usable;
  }
  return usableAuthor(direct ? stripHtml(direct) : null);
}

function parseEntry(
  node: Record<string, unknown>,
  kind: ParsedFeed['kind'],
  baseUrl: string | null,
  feedAuthor: string | null = null,
): ParsedItem | null {
  const title = cleanTitle(pickText(node, ['title', 'itunes:title']));

  const link =
    kind === 'atom'
      ? extractAtomLink(node, baseUrl)
      : (() => {
          const raw = pickText(node, ['link', 'guid', 'feedburner:origLink', 'id']);
          if (raw && /^https?:\/\//i.test(raw)) return resolveUrl(baseUrl, raw) ?? raw;
          const origin = pickText(node, ['feedburner:origLink']);
          return origin ?? (raw && raw.startsWith('/') ? resolveUrl(baseUrl, raw) : null);
        })();

  const guidNode = pick(node, ['guid', 'id', 'atom:id']);
  const guid = text(guidNode as Node) ?? null;

  const summaryRaw = pickText(node, ['description', 'summary', 'itunes:summary', 'itunes:subtitle', 'media:description']);
  const contentRaw = pickText(node, ['content:encoded', 'content', 'contentEncoded']);

  const publishedAt =
    parseDate(pickText(node, ['pubDate', 'published', 'dc:date', 'updated', 'lastBuildDate', 'date'])) ?? null;

  const subtitle = pickText(node, ['itunes:subtitle', 'subtitle']);
  const enclosure = extractEnclosure(node, baseUrl);
  const duration = durationToMinutes(pickText(node, ['itunes:duration', 'duration']));
  const itemBase = link ?? baseUrl;
  const images = extractImages(node, itemBase, summaryRaw, contentRaw);
  const language =
    (typeof node['@xml:lang'] === 'string' ? node['@xml:lang'] : null) ??
    pickText(node, ['language', 'dc:language']);

  if (!title && !link && !summaryRaw) return null;

  const extra: Record<string, unknown> = {};
  for (const key of ['itunes:episode', 'itunes:season', 'itunes:episodeType', 'comments', 'slash:comments']) {
    const v = pickText(node, [key]);
    if (v) extra[key] = v;
  }

  return {
    guid,
    title,
    link: link ? (canonicalizeUrl(link) ? link : null) : null,
    subtitle: subtitle && subtitle !== summaryRaw ? collapseWhitespace(stripHtml(subtitle)) : null,
    summary: summaryRaw,
    content: contentRaw,
    author: extractAuthor(node) ?? feedAuthor,
    publishedAt,
    categories: extractCategories(node),
    enclosure,
    durationMinutes: duration,
    images,
    language,
    extra,
  };
}

export function parseFeed(xml: string, feedUrl?: string): ParsedFeed {
  const empty: ParsedFeed = {
    kind: 'unknown',
    title: null,
    siteUrl: null,
    description: null,
    language: null,
    isPodcast: false,
    items: [],
  };
  if (!xml || !xml.trim()) return empty;

  // Strip a BOM and anything before the first tag (some feeds leak whitespace,
  // PHP warnings or stylesheet instructions ahead of the document).
  let doc = xml.replace(/^\uFEFF/, '');
  const firstTag = doc.indexOf('<');
  if (firstTag > 0) doc = doc.slice(firstTag);

  // A feed larger than the fetch byte cap arrives truncated mid-element, which
  // makes the whole document unparseable. Cutting back to the last complete
  // item and closing the tags salvages everything that did arrive.
  if (!isBalanced(doc)) {
    const salvaged = salvageTruncated(doc);
    if (salvaged) doc = salvaged;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(doc) as Record<string, unknown>;
  } catch {
    // Entity handling is the usual culprit. Retry without it and let
    // decodeEntities/stripHtml deal with the escapes downstream, rather than
    // throwing away an entire source's worth of items.
    try {
      parsed = lenientParser.parse(doc) as Record<string, unknown>;
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  const rss = first<Record<string, unknown>>(parsed['rss']);
  const rdf = first<Record<string, unknown>>(parsed['rdf:RDF'] ?? parsed['RDF']);
  const atom = first<Record<string, unknown>>(parsed['feed']);

  if (rss) {
    const channel = first<Record<string, unknown>>(rss['channel']) ?? {};
    const siteUrl = pickText(channel, ['link']);
    const channelAuthor = extractAuthor(channel);
    const items = asArray<Record<string, unknown>>(channel['item'])
      .map((i) => parseEntry(i, 'rss', siteUrl, channelAuthor))
      .filter((i): i is ParsedItem => i !== null);
    return {
      kind: 'rss',
      title: cleanTitle(pickText(channel, ['title'])) || null,
      siteUrl,
      description: pickText(channel, ['description', 'itunes:summary']),
      language: pickText(channel, ['language', 'dc:language']),
      isPodcast: detectPodcast(channel, items),
      items,
    };
  }

  if (rdf) {
    const channel = first<Record<string, unknown>>(rdf['channel']) ?? {};
    const siteUrl = pickText(channel, ['link']);
    const channelAuthor = extractAuthor(channel);
    const items = asArray<Record<string, unknown>>(rdf['item'])
      .map((i) => parseEntry(i, 'rdf', siteUrl, channelAuthor))
      .filter((i): i is ParsedItem => i !== null);
    return {
      kind: 'rdf',
      title: cleanTitle(pickText(channel, ['title'])) || null,
      siteUrl,
      description: pickText(channel, ['description']),
      language: pickText(channel, ['dc:language']),
      isPodcast: detectPodcast(channel, items),
      items,
    };
  }

  if (atom) {
    const siteUrl = extractAtomLink(atom, feedUrl ?? null);
    // Single-author Atom blogs declare the author once, on the feed.
    const feedAuthor = extractAuthor(atom);
    const items = asArray<Record<string, unknown>>(atom['entry'])
      .map((i) => parseEntry(i, 'atom', siteUrl, feedAuthor))
      .filter((i): i is ParsedItem => i !== null);
    return {
      kind: 'atom',
      title: cleanTitle(pickText(atom, ['title'])) || null,
      siteUrl,
      description: pickText(atom, ['subtitle', 'summary']),
      language: typeof atom['@xml:lang'] === 'string' ? (atom['@xml:lang'] as string) : null,
      isPodcast: detectPodcast(atom, items),
      items,
    };
  }

  return empty;
}

/** Cheap check for a document that ends mid-element. */
function isBalanced(doc: string): boolean {
  const root = /<(rss|feed|rdf:RDF)[\s>]/.exec(doc);
  if (!root) return true;
  return new RegExp(`</${root[1]!.replace(':', ':')}\\s*>\\s*$`).test(doc.trimEnd());
}

function salvageTruncated(doc: string): string | null {
  const rootMatch = /<(rss|feed|rdf:RDF)[\s>]/.exec(doc);
  if (!rootMatch) return null;
  const root = rootMatch[1]!;
  const itemTag = root === 'feed' ? 'entry' : 'item';

  const lastClose = doc.lastIndexOf(`</${itemTag}>`);
  if (lastClose === -1) return null;

  let salvaged = doc.slice(0, lastClose + itemTag.length + 3);
  // RSS and RDF wrap items in <channel>; Atom does not.
  if (root === 'rss') salvaged += '</channel>';
  salvaged += `</${root}>`;
  return salvaged;
}

function detectPodcast(channel: Record<string, unknown>, items: ParsedItem[]): boolean {
  const hasItunes = Object.keys(channel).some((k) => k.startsWith('itunes:'));
  const audioItems = items.filter((i) => i.enclosure?.type?.startsWith('audio/')).length;
  return hasItunes && audioItems > items.length / 2;
}
