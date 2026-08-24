import type { Db } from '../db/index.js';
import type { AppConfig, FeedConfig } from '../config/index.js';
import { feedLength } from '../config/index.js';
import { alternatesForItem, type StoredAlternate } from '../alternate/index.js';
import { loadBriefingEditions, type BriefingEdition } from '../briefing/index.js';
import { escapeXml, truncate, collapseWhitespace } from '../util/text.js';
import { humanMinutes, toRfc822, toIso } from '../util/time.js';

/**
 * Generated Atom output (§16).
 *
 * The original publisher stays in front: their name is the author, their title
 * is the entry title, and the link goes to their article. Sift's contribution
 * is one short "why this surfaced" line and, when we have one, a direct link to
 * the audio version. No generated summaries.
 */

export interface RenderedItem {
  item_id: string;
  title: string;
  original_url: string | null;
  canonical_url: string | null;
  source_name: string;
  source_id: string;
  author: string | null;
  published_at: number;
  publication_time: number | null;
  why_it_surfaced: string | null;
  reading_minutes: number | null;
  score: number;
  rss_summary: string | null;
  feed_images_json: string;
  item_kind: string;
  lead_image_url: string | null;
  is_classic: number;
}

interface FeedImage {
  url: string;
  alt?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
}

export function loadFeedItems(db: Db, feedId: string, limit: number): RenderedItem[] {
  return db.all<RenderedItem>(
    `SELECT p.item_id, fi.title, fi.original_url, fi.canonical_url,
            COALESCE(cc.source_name, s.name) AS source_name,
            fi.source_id, COALESCE(cc.original_author, fi.author) AS author,
            p.published_at, COALESCE(cc.original_published_at, fi.publication_time) AS publication_time,
            COALESCE(p.why_it_surfaced, ce.why_picked, de.why_it_surfaced) AS why_it_surfaced,
            COALESCE(de.estimated_reading_minutes, ac.reading_minutes) AS reading_minutes,
            p.score, COALESCE(fi.rss_summary, ac.subtitle) AS rss_summary,
            fi.feed_images_json, fi.item_kind, ac.lead_image_url,
            CASE WHEN cc.item_id IS NULL THEN 0 ELSE 1 END AS is_classic
     FROM published_feed_items p
     JOIN feed_items fi ON fi.id = p.item_id
     JOIN sources s ON s.id = fi.source_id
     LEFT JOIN deep_evaluations de ON de.item_id = p.item_id
     LEFT JOIN article_content ac ON ac.item_id = p.item_id
     LEFT JOIN classics_candidates cc ON cc.item_id = p.item_id
     LEFT JOIN classics_evaluations ce ON ce.item_id = p.item_id
     WHERE p.feed_id = :feed
     ORDER BY p.published_at DESC, p.score DESC
     LIMIT :limit`,
    { feed: feedId, limit },
  );
}

const FORMAT_LABELS: Record<string, string> = {
  audio_version: 'Listen instead',
  podcast_version: 'Listen instead',
  companion_podcast: 'Companion podcast',
  video_version: 'Watch instead',
  transcript: 'Transcript',
};

export function renderAlternateLine(alt: StoredAlternate): string {
  const label = FORMAT_LABELS[alt.format_type] ?? 'Alternate version';
  const duration = humanMinutes(alt.duration_minutes);
  const icon = alt.format_type === 'video_version' ? '📺' : alt.format_type === 'transcript' ? '📄' : '🎧';
  const parts = [`${icon} ${label}`];
  if (duration) parts.push(duration);
  return parts.join(' — ');
}

function itemHtml(
  item: RenderedItem,
  alternates: StoredAlternate[],
  linkUrl: string,
  originalUrl: string,
): string {
  const meta = [item.source_name, item.author, humanMinutes(item.reading_minutes)]
    .filter(Boolean)
    .join(' · ');

  const parts: string[] = [];
  parts.push(`<p style="color:#666;font-size:0.9em;margin:0 0 1em 0">${escapeXml(meta)}</p>`);

  if (item.is_classic) {
    const originalDate = item.publication_time
      ? new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
          new Date(item.publication_time),
        )
      : 'date unknown';
    parts.push(
      `<p style="margin:0 0 1em 0"><strong>⭐ Sift Classics</strong><br>` +
        `<span style="color:#666">Originally published: ${escapeXml(originalDate)}</span></p>`,
    );
  }

  if (item.item_kind === 'product') {
    parts.push('<p style="margin:0 0 1em 0"><strong>Product discovery</strong></p>');
  }

  for (const image of feedImages(item).slice(0, 6)) {
    const alt = escapeXml(image.alt ?? image.caption ?? '');
    const caption = image.caption
      ? `<figcaption style="color:#666;font-size:0.85em">${escapeXml(image.caption)}</figcaption>`
      : '';
    parts.push(
      `<figure style="margin:0 0 1em 0"><img src="${escapeXml(image.url)}" alt="${alt}" style="max-width:100%;height:auto">${caption}</figure>`,
    );
  }

  if (item.why_it_surfaced) {
    parts.push(
      `<p style="margin:0 0 1em 0"><strong>Why this surfaced:</strong><br>${escapeXml(item.why_it_surfaced)}</p>`,
    );
  }

  for (const alt of alternates) {
    const label = escapeXml(renderAlternateLine(alt));
    const extra =
      alt.spotify_url && alt.format_type !== 'video_version' && alt.format_type !== 'transcript'
        ? ` &nbsp;<a href="${escapeXml(alt.spotify_url)}">Find on Spotify</a>`
        : '';
    parts.push(`<p style="margin:0 0 1em 0"><a href="${escapeXml(alt.url)}"><strong>${label}</strong></a>${extra}</p>`);
  }

  // The RSS summary is the publisher's own words, never a generated one.
  if (item.rss_summary) {
    parts.push(`<p style="margin:0 0 1em 0">${escapeXml(truncate(collapseWhitespace(item.rss_summary), 400))}</p>`);
  }

  parts.push(`<p style="margin:0"><a href="${escapeXml(linkUrl)}">Original article</a>`);
  if (linkUrl !== originalUrl) {
    parts.push(` <span style="color:#999;font-size:0.85em">(${escapeXml(hostLabel(originalUrl))})</span>`);
  }
  parts.push('</p>');

  return parts.join('\n');
}

function feedImages(item: RenderedItem): FeedImage[] {
  try {
    const parsed = JSON.parse(item.feed_images_json ?? '[]') as unknown;
    const feed = Array.isArray(parsed) ? parsed.filter(
      (image): image is FeedImage =>
        !!image && typeof image === 'object' && typeof (image as { url?: unknown }).url === 'string',
    ) : [];
    if (feed.length > 0) return feed;
    // Archive discovery has no RSS item. Use the canonical page's own lead
    // image, while rejecting obvious logos, avatars, icons and tracking pixels.
    if (item.lead_image_url && !/(?:logo|avatar|favicon|icon|tracking|pixel)[._/-]/i.test(item.lead_image_url)) {
      return [{ url: item.lead_image_url }];
    }
    return [];
  } catch {
    return item.lead_image_url && !/(?:logo|avatar|favicon|icon|tracking|pixel)[._/-]/i.test(item.lead_image_url)
      ? [{ url: item.lead_image_url }]
      : [];
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface RenderOptions {
  /** Route links through /open/<id> so opens can be recorded. */
  tracked: boolean;
  publicUrl: string;
  accessToken: string;
}

export function renderAtomFeed(
  db: Db,
  config: AppConfig,
  feed: FeedConfig,
  items: RenderedItem[],
  options: RenderOptions,
): string {
  // The self link has to carry the token. Feeds are gated by a token in the
  // query string, so a self link without one points at a 404 -- and readers that
  // refresh via rel="self" rather than the URL you subscribed with would silently
  // lose the feed. This is the one place the token belongs: it is the reader's
  // own subscription URL, not a link handed to a publisher.
  const self = `${options.publicUrl}/feed/${feed.slug}.xml${
    options.accessToken ? `?t=${encodeURIComponent(options.accessToken)}` : ''
  }`;
  const updated = items.length ? Math.max(...items.map((i) => i.published_at)) : Date.now();
  const minConfidence = config.pipeline.alternate_formats.min_confidence;

  const entries = items.map((item) => {
    const originalUrl = item.original_url ?? item.canonical_url ?? options.publicUrl;
    // No access token on /open links. The endpoint is not token-gated (the
    // item id is unguessable and it only ever redirects to a URL we already
    // stored), and putting the token here would ship it to every publisher in
    // the Referer header.
    const linkUrl = options.tracked
      ? `${options.publicUrl}/open/${item.item_id}?feed=${encodeURIComponent(feed.id)}`
      : originalUrl;

    const alternates = alternatesForItem(db, item.item_id, minConfidence);
    const html = itemHtml(item, alternates, linkUrl, originalUrl);
    const primaryImage = feedImages(item)[0];

    // A stable, globally unique entry id. Reeder uses this for read state, so
    // it must never change for an item that has already been delivered.
    const entryId = `urn:sift:item:${item.item_id}`;

    const enclosures = alternates
      .filter((a) => a.format_type === 'audio_version' || a.format_type === 'podcast_version')
      .slice(0, 1)
      .map(
        (a) =>
          `    <link rel="enclosure" type="audio/mpeg" href="${escapeXml(a.url)}"${
            a.duration_minutes ? ` title="${escapeXml(`${a.duration_minutes} min`)}"` : ''
          }/>`,
      );

    return [
      '  <entry>',
      `    <title type="text">${escapeXml(item.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(linkUrl)}"/>`,
      ...enclosures,
      primaryImage
        ? `    <media:content url="${escapeXml(primaryImage.url)}" medium="image"${
            primaryImage.width ? ` width="${primaryImage.width}"` : ''
          }${primaryImage.height ? ` height="${primaryImage.height}"` : ''}/>`
        : '',
      `    <id>${escapeXml(entryId)}</id>`,
      `    <published>${toIso(item.is_classic ? item.published_at : (item.publication_time ?? item.published_at))}</published>`,
      `    <updated>${toIso(item.published_at)}</updated>`,
      `    <author><name>${escapeXml(item.author ? `${item.author} (${item.source_name})` : item.source_name)}</name></author>`,
      `    <source><title>${escapeXml(item.source_name)}</title></source>`,
      item.why_it_surfaced
        ? `    <summary type="text">${escapeXml(truncate(item.why_it_surfaced, 400))}</summary>`
        : '',
      `    <content type="html">${escapeXml(html)}</content>`,
      '  </entry>',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    `  <title type="text">${escapeXml(feed.title)}</title>`,
    `  <subtitle type="text">${escapeXml(collapseWhitespace(feed.description))}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(options.publicUrl)}"/>`,
    `  <id>urn:sift:feed:${escapeXml(feed.id)}</id>`,
    `  <updated>${toIso(updated)}</updated>`,
    '  <generator uri="https://github.com/">Sift</generator>',
    ...entries,
    '</feed>',
  ].join('\n');
}

/** JSON Feed 1.1 output, including archival recommendation/original dates. */
export function renderJsonFeed(
  db: Db,
  config: AppConfig,
  feed: FeedConfig,
  items: RenderedItem[],
  options: RenderOptions,
): string {
  const feedUrl = `${options.publicUrl}/feed/${feed.slug}.json${
    options.accessToken ? `?t=${encodeURIComponent(options.accessToken)}` : ''
  }`;
  const minConfidence = config.pipeline.alternate_formats.min_confidence;
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: feed.title,
      home_page_url: options.publicUrl,
      feed_url: feedUrl,
      description: collapseWhitespace(feed.description),
      items: items.map((item) => {
        const originalUrl = item.original_url ?? item.canonical_url ?? options.publicUrl;
        const linkUrl = options.tracked
          ? `${options.publicUrl}/open/${item.item_id}?feed=${encodeURIComponent(feed.id)}`
          : originalUrl;
        const html = itemHtml(item, alternatesForItem(db, item.item_id, minConfidence), linkUrl, originalUrl);
        return {
          id: `urn:sift:item:${item.item_id}`,
          url: linkUrl,
          external_url: originalUrl,
          title: item.title,
          content_html: html,
          summary: item.why_it_surfaced ?? undefined,
          date_published: toIso(item.published_at),
          date_modified: toIso(item.published_at),
          authors: [{ name: item.author ? `${item.author} (${item.source_name})` : item.source_name }],
          image: feedImages(item)[0]?.url,
          _sift: item.is_classic
            ? {
                label: 'Sift Classics',
                recommended_at: toIso(item.published_at),
                original_published_at: item.publication_time ? toIso(item.publication_time) : null,
              }
            : undefined,
        };
      }),
    },
    null,
    2,
  );
}

/** RSS 2.0 output, for readers that prefer it. */
export function renderRssFeed(
  db: Db,
  config: AppConfig,
  feed: FeedConfig,
  items: RenderedItem[],
  options: RenderOptions,
): string {
  // The self link has to carry the token. Feeds are gated by a token in the
  // query string, so a self link without one points at a 404 -- and readers that
  // refresh via rel="self" rather than the URL you subscribed with would silently
  // lose the feed. This is the one place the token belongs: it is the reader's
  // own subscription URL, not a link handed to a publisher.
  const self = `${options.publicUrl}/feed/${feed.slug}.rss${
    options.accessToken ? `?t=${encodeURIComponent(options.accessToken)}` : ''
  }`;
  const minConfidence = config.pipeline.alternate_formats.min_confidence;

  const entries = items.map((item) => {
    const originalUrl = item.original_url ?? item.canonical_url ?? options.publicUrl;
    // No access token on /open links. The endpoint is not token-gated (the
    // item id is unguessable and it only ever redirects to a URL we already
    // stored), and putting the token here would ship it to every publisher in
    // the Referer header.
    const linkUrl = options.tracked
      ? `${options.publicUrl}/open/${item.item_id}?feed=${encodeURIComponent(feed.id)}`
      : originalUrl;
    const alternates = alternatesForItem(db, item.item_id, minConfidence);
    const html = itemHtml(item, alternates, linkUrl, originalUrl);
    const primaryImage = feedImages(item)[0];
    const audio = alternates.find((a) => a.format_type === 'audio_version' || a.format_type === 'podcast_version');

    return [
      '    <item>',
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${escapeXml(linkUrl)}</link>`,
      `      <guid isPermaLink="false">urn:sift:item:${escapeXml(item.item_id)}</guid>`,
      `      <pubDate>${toRfc822(item.published_at)}</pubDate>`,
      `      <dc:creator>${escapeXml(item.author ? `${item.author} (${item.source_name})` : item.source_name)}</dc:creator>`,
      audio ? `      <enclosure url="${escapeXml(audio.url)}" type="audio/mpeg" length="0"/>` : '',
      primaryImage ? `      <media:content url="${escapeXml(primaryImage.url)}" medium="image"/>` : '',
      `      <description>${escapeXml(html)}</description>`,
      '    </item>',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    '  <channel>',
    `    <title>${escapeXml(feed.title)}</title>`,
    `    <link>${escapeXml(options.publicUrl)}</link>`,
    `    <description>${escapeXml(collapseWhitespace(feed.description))}</description>`,
    `    <atom:link rel="self" type="application/rss+xml" href="${escapeXml(self)}"/>`,
    `    <lastBuildDate>${toRfc822(items.length ? Math.max(...items.map((i) => i.published_at)) : Date.now())}</lastBuildDate>`,
    ...entries,
    '  </channel>',
    '</rss>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The briefing
//
// Every other feed renders one entry per article. The briefing renders one
// entry per *edition*: ten numbered lines, each a headline, a link and a short
// summary, so the whole slot is read in one place rather than as ten items to
// triage. The individual links are still tracked, so opening a line from the
// briefing feeds the same learning signal as opening it from Essential.
// ---------------------------------------------------------------------------

/** "Morning briefing · Sat 23 August". */
export function briefingEntryTitle(edition: BriefingEdition): string {
  const [year, month, day] = edition.localDay.split('-').map(Number) as [number, number, number];
  // A date with no time in it, so UTC formatting cannot shift the day.
  const when = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
  const label = edition.slotLabel ? `${edition.slotLabel} briefing` : 'Briefing';
  return `${label} · ${when}`;
}

function briefingLinkUrl(
  edition: BriefingEdition,
  line: BriefingEdition['lines'][number],
  options: RenderOptions,
): string {
  // As everywhere else, no access token on /open links: the item id is
  // unguessable, the endpoint only redirects to a URL we already stored, and a
  // token here would reach every publisher in the Referer header.
  return options.tracked
    ? `${options.publicUrl}/open/${line.itemId}?feed=${encodeURIComponent(edition.feedId)}`
    : line.url;
}

export function briefingEntryHtml(
  edition: BriefingEdition,
  options: RenderOptions,
): string {
  const parts: string[] = [];
  for (const line of edition.lines) {
    const url = briefingLinkUrl(edition, line, options);
    // A numbered heading, then the summary as its own paragraph. Deliberately
    // an explicit "N." rather than an <ol>: readers vary in whether they render
    // list markers inside entry content, and the number is load-bearing here.
    parts.push(
      `<p style="margin:0 0 0.35em 0"><strong>${line.rank}. ` +
        `<a href="${escapeXml(url)}">${escapeXml(line.title)}</a></strong>` +
        `<br><span style="color:#666;font-size:0.85em">${escapeXml(line.sourceName)}</span></p>`,
    );
    if (line.summary) {
      parts.push(`<p style="margin:0 0 1.4em 0">${escapeXml(line.summary)}</p>`);
    } else {
      parts.push('<p style="margin:0 0 1.4em 0"></p>');
    }
  }
  return parts.join('\n');
}

/** The plain-text summary element: the headlines, without the summaries. */
function briefingSummaryText(edition: BriefingEdition): string {
  return truncate(edition.lines.map((line) => `${line.rank}. ${line.title}`).join(' · '), 400);
}

export function renderBriefingAtom(
  config: AppConfig,
  feed: FeedConfig,
  editions: BriefingEdition[],
  options: RenderOptions,
): string {
  const self = `${options.publicUrl}/feed/${feed.slug}.xml${
    options.accessToken ? `?t=${encodeURIComponent(options.accessToken)}` : ''
  }`;
  const updated = editions.length ? Math.max(...editions.map((e) => e.publishedAt)) : Date.now();

  const entries = editions.map((edition) => {
    const html = briefingEntryHtml(edition, options);
    return [
      '  <entry>',
      `    <title type="text">${escapeXml(briefingEntryTitle(edition))}</title>`,
      // A digest has no single article to open, so the entry points at the feed
      // home. Every real destination is a link inside the content, which is
      // where a reader taps from anyway.
      `    <link rel="alternate" type="text/html" href="${escapeXml(options.publicUrl)}"/>`,
      // Stable for the life of the edition, so a reader's read state survives a
      // rebuild of the same slot.
      `    <id>urn:sift:briefing:${escapeXml(edition.localDay)}:${escapeXml(edition.slot)}</id>`,
      `    <published>${toIso(edition.publishedAt)}</published>`,
      `    <updated>${toIso(edition.publishedAt)}</updated>`,
      // Sift compiled this one, unlike every other entry in every other feed,
      // where the author is deliberately the publisher.
      `    <author><name>${escapeXml(config.briefing.feed.title)}</name></author>`,
      `    <summary type="text">${escapeXml(briefingSummaryText(edition))}</summary>`,
      `    <content type="html">${escapeXml(html)}</content>`,
      '  </entry>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    `  <title type="text">${escapeXml(feed.title)}</title>`,
    `  <subtitle type="text">${escapeXml(collapseWhitespace(feed.description))}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(options.publicUrl)}"/>`,
    `  <id>urn:sift:feed:${escapeXml(feed.id)}</id>`,
    `  <updated>${toIso(updated)}</updated>`,
    '  <generator uri="https://github.com/">Sift</generator>',
    ...entries,
    '</feed>',
  ].join('\n');
}

export function renderBriefingRss(
  config: AppConfig,
  feed: FeedConfig,
  editions: BriefingEdition[],
  options: RenderOptions,
): string {
  const self = `${options.publicUrl}/feed/${feed.slug}.rss${
    options.accessToken ? `?t=${encodeURIComponent(options.accessToken)}` : ''
  }`;

  const entries = editions.map((edition) =>
    [
      '    <item>',
      `      <title>${escapeXml(briefingEntryTitle(edition))}</title>`,
      `      <link>${escapeXml(options.publicUrl)}</link>`,
      `      <guid isPermaLink="false">urn:sift:briefing:${escapeXml(edition.localDay)}:${escapeXml(edition.slot)}</guid>`,
      `      <pubDate>${toRfc822(edition.publishedAt)}</pubDate>`,
      `      <dc:creator>${escapeXml(config.briefing.feed.title)}</dc:creator>`,
      `      <description>${escapeXml(briefingEntryHtml(edition, options))}</description>`,
      '    </item>',
    ].join('\n'),
  );

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    '  <channel>',
    `    <title>${escapeXml(feed.title)}</title>`,
    `    <link>${escapeXml(options.publicUrl)}</link>`,
    `    <description>${escapeXml(collapseWhitespace(feed.description))}</description>`,
    `    <atom:link rel="self" type="application/rss+xml" href="${escapeXml(self)}"/>`,
    `    <lastBuildDate>${toRfc822(editions.length ? Math.max(...editions.map((e) => e.publishedAt)) : Date.now())}</lastBuildDate>`,
    ...entries,
    '  </channel>',
    '</rss>',
  ].join('\n');
}

export function renderBriefingJson(
  config: AppConfig,
  feed: FeedConfig,
  editions: BriefingEdition[],
  options: RenderOptions,
): string {
  const feedUrl = `${options.publicUrl}/feed/${feed.slug}.json${
    options.accessToken ? `?t=${encodeURIComponent(options.accessToken)}` : ''
  }`;
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: feed.title,
      home_page_url: options.publicUrl,
      feed_url: feedUrl,
      description: collapseWhitespace(feed.description),
      items: editions.map((edition) => ({
        id: `urn:sift:briefing:${edition.localDay}:${edition.slot}`,
        url: options.publicUrl,
        title: briefingEntryTitle(edition),
        content_html: briefingEntryHtml(edition, options),
        summary: briefingSummaryText(edition),
        date_published: toIso(edition.publishedAt),
        date_modified: toIso(edition.publishedAt),
        authors: [{ name: config.briefing.feed.title }],
        _sift: {
          label: 'Sift Briefing',
          slot: edition.slot,
          local_day: edition.localDay,
          // Machine-readable lines, so a consumer that is not a reader app does
          // not have to parse the HTML back apart.
          lines: edition.lines.map((line) => ({
            rank: line.rank,
            title: line.title,
            url: briefingLinkUrl(edition, line, options),
            external_url: line.url,
            source: line.sourceName,
            summary: line.summary,
          })),
        },
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------

export interface FeedDocuments {
  atom: string;
  rss: string;
  json: string;
  /** How many entries the feed contains. */
  entries: number;
  /**
   * Every item the feed links to, mapped to its destination. `push` needs this
   * to write the `item:<id>` keys the Worker resolves `/open/<id>` against; a
   * briefing whose items were missing from that map would render ten links that
   * all 404 at the edge.
   */
  itemUrls: Map<string, string>;
}

/**
 * Render one feed in all three formats.
 *
 * The single place that knows a feed might not be a list of articles. The feed
 * server, `push` and the static export all go through here, so a new kind of
 * feed cannot be served but not pushed.
 */
export function renderFeedDocuments(
  db: Db,
  config: AppConfig,
  feed: FeedConfig,
  options: RenderOptions,
): FeedDocuments {
  const limit = feedLength(config, feed);

  if (feed.id === config.briefing.feed.id) {
    const editions = loadBriefingEditions(db, config, limit);
    const itemUrls = new Map<string, string>();
    for (const edition of editions) {
      for (const line of edition.lines) if (line.url) itemUrls.set(line.itemId, line.url);
    }
    return {
      atom: renderBriefingAtom(config, feed, editions, options),
      rss: renderBriefingRss(config, feed, editions, options),
      json: renderBriefingJson(config, feed, editions, options),
      entries: editions.length,
      itemUrls,
    };
  }

  const items = loadFeedItems(db, feed.id, limit);
  const itemUrls = new Map<string, string>();
  for (const item of items) {
    const target = item.original_url ?? item.canonical_url;
    if (target) itemUrls.set(item.item_id, target);
  }
  return {
    atom: renderAtomFeed(db, config, feed, items, options),
    rss: renderRssFeed(db, config, feed, items, options),
    json: renderJsonFeed(db, config, feed, items, options),
    entries: items.length,
    itemUrls,
  };
}
