import type { AppConfig } from '../config/index.js';
import type { Db } from '../db/index.js';
import { stableId } from '../util/hash.js';
import { fetchText, politeDelay } from '../util/http.js';
import { mapPool } from '../util/pool.js';
import { collapseWhitespace, stripHtml } from '../util/text.js';
import { canonicalizeUrl, hostOf } from '../util/url.js';
import { DAY_MS } from '../util/time.js';
import { logger } from '../util/log.js';

const log = logger('classics-discovery');

export interface DiscoveredClassic {
  url: string;
  title: string;
  sourceName: string;
  author: string | null;
  publishedAt: number | null;
  discoverySource: string;
  externalId: string;
  signal: number;
  metadata: Record<string, unknown>;
}

interface HnHit {
  objectID?: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at_i?: number;
}

interface HnResponse {
  hits?: HnHit[];
}

interface WpPost {
  id?: number;
  date_gmt?: string;
  link?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
}

export interface DiscoveryStats {
  fetched: number;
  unique: number;
  inserted: number;
  attachedToExisting: number;
  alreadyKnown: number;
  previouslySurfaced: number;
  rejectedMalformed: number;
  bySource: Record<string, number>;
}

function sourceNameFor(url: string): string {
  const host = hostOf(url) ?? 'Unknown source';
  return host
    .replace(/\.(com|org|net|io|co\.uk)$/i, '')
    .split(/[.-]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function acceptableUrl(url: string): boolean {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return false;
  const parsed = new URL(canonical);
  if (/stratechery\.com$/i.test(parsed.hostname)) return false;
  if (
    /news\.ycombinator\.com|youtube\.com|youtu\.be|github\.com|wikipedia\.org|twitter\.com|x\.com|facebook\.com|reddit\.com|mail\.python\.org|mailman\.|lore\.kernel\.org$/i.test(
      parsed.hostname,
    )
  ) return false;
  if (/\.(pdf|epub|zip)(?:$|\?)/i.test(parsed.pathname)) return false;
  return true;
}

function hnSignal(points: number, comments: number, submissions: number): number {
  const pointScore = Math.min(1, Math.log1p(Math.max(0, points)) / Math.log(1200));
  const commentScore = Math.min(1, Math.log1p(Math.max(0, comments)) / Math.log(600));
  const repeatScore = Math.min(1, Math.max(0, submissions - 1) / 3);
  return Math.min(1, 0.12 + pointScore * 0.57 + commentScore * 0.23 + repeatScore * 0.08);
}

export async function discoverHistoricalHn(config: AppConfig, now = Date.now()): Promise<DiscoveredClassic[]> {
  const cfg = config.classics.discovery.historical_hn;
  if (!cfg.enabled) return [];
  const currentYear = new Date(now).getUTCFullYear();
  const endYear = Math.min(cfg.end_year ?? currentYear - 1, currentYear - 1);
  const years = Array.from({ length: Math.max(0, endYear - cfg.start_year + 1) }, (_, i) => cfg.start_year + i);

  const results = await mapPool(years, Math.min(4, config.env.fetchConcurrency), async (year) => {
    const start = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const end = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
    const params = new URLSearchParams({
      tags: 'story',
      numericFilters: `created_at_i>=${start},created_at_i<${end},points>=${cfg.min_points},num_comments>=${cfg.min_comments}`,
      hitsPerPage: String(cfg.hits_per_year),
    });
    const url = `https://hn.algolia.com/api/v1/search?${params}`;
    const response = await fetchText(url, { timeoutMs: 30_000, maxBytes: 4_000_000, retries: 2 });
    if (!response.ok) throw new Error(`HN ${year}: ${response.status} ${response.error ?? ''}`);
    const parsed = JSON.parse(response.body) as HnResponse;
    return parsed.hits ?? [];
  });

  const grouped = new Map<string, { hit: HnHit; points: number; comments: number; ids: string[] }>();
  for (const result of results) {
    if (!result.ok) {
      log.warn('historical HN window failed', result.error);
      continue;
    }
    for (const hit of result.value) {
      if (!hit.url || !hit.title || !acceptableUrl(hit.url)) continue;
      const canonical = canonicalizeUrl(hit.url);
      if (!canonical) continue;
      const existing = grouped.get(canonical);
      if (!existing) {
        grouped.set(canonical, {
          hit,
          points: hit.points ?? 0,
          comments: hit.num_comments ?? 0,
          ids: hit.objectID ? [hit.objectID] : [],
        });
      } else {
        existing.points = Math.max(existing.points, hit.points ?? 0);
        existing.comments = Math.max(existing.comments, hit.num_comments ?? 0);
        if (hit.objectID) existing.ids.push(hit.objectID);
      }
    }
  }

  return [...grouped.entries()].map(([url, group]) => {
    const submissions = Math.max(1, group.ids.length);
    return {
      url,
      title: collapseWhitespace(stripHtml(group.hit.title ?? '')),
      sourceName: sourceNameFor(url),
      author: null,
      publishedAt: group.hit.created_at_i ? group.hit.created_at_i * 1000 : null,
      discoverySource: 'hn_archive',
      externalId: group.ids.join(',') || stableId('hn-archive', url),
      signal: hnSignal(group.points, group.comments, submissions),
      metadata: {
        hn_points: group.points,
        hn_comments: group.comments,
        hn_submissions: submissions,
        hn_ids: group.ids,
      },
    };
  });
}

function firstExternalLink(html: string, wrapperUrl: string): string | null {
  const wrapperHost = hostOf(wrapperUrl);
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const candidate = canonicalizeUrl(match[1]);
    if (!candidate || !acceptableUrl(candidate)) continue;
    const host = hostOf(candidate);
    if (!host || host === wrapperHost || /longreads\.com$/i.test(host)) continue;
    if (/facebook|twitter|x\.com|instagram|pinterest|amazon/i.test(host)) continue;
    return candidate;
  }
  return null;
}

/** Longreads' public WordPress archive is editorial candidate generation only. */
export async function discoverLongreads(config: AppConfig, now = Date.now()): Promise<DiscoveredClassic[]> {
  const cfg = config.classics.discovery.longreads;
  if (!cfg.enabled) return [];
  const currentYear = new Date(now).getUTCFullYear();
  const endYear = Math.min(cfg.end_year ?? currentYear - 1, currentYear - 1);
  const years = Array.from({ length: Math.max(0, endYear - cfg.start_year + 1) }, (_, i) => cfg.start_year + i);
  const results = await mapPool(years, 1, async (year) => {
    const params = new URLSearchParams({
      per_page: String(cfg.hits_per_year),
      after: `${year}-01-01T00:00:00`,
      before: `${year + 1}-01-01T00:00:00`,
      orderby: 'date',
      order: 'desc',
      _fields: 'id,date_gmt,link,title,excerpt,content',
    });
    const endpoint = `https://longreads.com/wp-json/wp/v2/posts?${params}`;
    await politeDelay(endpoint, 650);
    const response = await fetchText(endpoint, {
      timeoutMs: 30_000,
      maxBytes: 8_000_000,
      retries: 2,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Longreads ${year}: ${response.status} ${response.error ?? ''}`);
    return JSON.parse(response.body) as WpPost[];
  });

  const discovered: DiscoveredClassic[] = [];
  for (const result of results) {
    if (!result.ok) {
      log.warn('Longreads archive window failed', result.error);
      continue;
    }
    for (const post of result.value) {
      if (!post.link) continue;
      const content = post.content?.rendered ?? '';
      const url = firstExternalLink(content, post.link) ?? canonicalizeUrl(post.link);
      if (!url || !acceptableUrl(url)) continue;
      discovered.push({
        url,
        title: collapseWhitespace(stripHtml(post.title?.rendered ?? '')),
        sourceName: sourceNameFor(url),
        author: null,
        publishedAt: post.date_gmt ? Date.parse(`${post.date_gmt}Z`) : null,
        discoverySource: 'longreads_archive',
        externalId: String(post.id ?? stableId('longreads', url)),
        // Editorial selection is meaningful but deliberately weaker than the
        // strongest repeat-linked HN candidates.
        signal: 0.68,
        metadata: {
          longreads_url: post.link,
          longreads_excerpt: collapseWhitespace(stripHtml(post.excerpt?.rendered ?? '')).slice(0, 800),
        },
      });
    }
  }
  return discovered;
}

export function configuredSeeds(config: AppConfig): DiscoveredClassic[] {
  return config.classics.discovery.curated_seeds.map((seed, index) => ({
    url: canonicalizeUrl(seed.url) ?? seed.url,
    title: seed.title,
    sourceName: seed.source,
    author: seed.author ?? null,
    publishedAt: seed.published_at ? Date.parse(seed.published_at) : null,
    discoverySource: seed.discovery_source,
    externalId: `seed:${index}:${stableId(seed.url)}`,
    signal: 0.72,
    metadata: {},
  }));
}

function wasAlreadySeen(db: Db, canonical: string): boolean {
  return !!db.get(
    `SELECT 1
     FROM feed_items fi
     WHERE fi.canonical_url = :url
       AND (
         EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = fi.id)
         OR EXISTS (SELECT 1 FROM open_events o WHERE o.item_id = fi.id)
       )
     LIMIT 1`,
    { url: canonical },
  );
}

function existingItemId(db: Db, canonical: string): string | null {
  return db.get<{ id: string }>(`SELECT id FROM feed_items WHERE canonical_url = :url ORDER BY first_seen_at LIMIT 1`, {
    url: canonical,
  })?.id ?? null;
}

function insertFeedItem(db: Db, candidate: DiscoveredClassic, canonical: string, now: number): string {
  const id = stableId('classics', canonical);
  db.run(
    `INSERT INTO feed_items (
       id, source_id, guid, original_url, canonical_url, title, subtitle, rss_summary,
       rss_content, author, publication_time, feed_categories_json, raw_feed_metadata,
       feed_images_json, item_kind, language, is_podcast, first_seen_at, status,
       status_reason, status_updated_at)
     VALUES (:id, 'classics_archive', :guid, :url, :canonical, :title, NULL, NULL,
             NULL, :author, :published, '[]', :metadata, '[]', 'article', NULL, 0,
             :now, 'classics_discovered', :reason, :now)
     ON CONFLICT(id) DO NOTHING`,
    {
      id,
      guid: candidate.externalId,
      url: candidate.url,
      canonical,
      title: candidate.title || canonical,
      author: candidate.author,
      published: candidate.publishedAt,
      metadata: JSON.stringify({ discovery_source: candidate.discoverySource, ...candidate.metadata }),
      reason: `archival candidate from ${candidate.discoverySource}`,
      now,
    },
  );
  return id;
}

export async function discoverClassics(db: Db, config: AppConfig, now = Date.now()): Promise<DiscoveryStats> {
  const stats: DiscoveryStats = {
    fetched: 0,
    unique: 0,
    inserted: 0,
    attachedToExisting: 0,
    alreadyKnown: 0,
    previouslySurfaced: 0,
    rejectedMalformed: 0,
    bySource: {},
  };
  if (!config.classics.enabled) return stats;

  const [hn, longreads] = await Promise.all([
    discoverHistoricalHn(config, now),
    discoverLongreads(config, now),
  ]);
  const all = [...hn, ...longreads, ...configuredSeeds(config)];
  stats.fetched = all.length;

  const cutoff = now - config.classics.discovery.min_age_days * DAY_MS;
  const grouped = new Map<string, DiscoveredClassic[]>();
  for (const candidate of all) {
    const canonical = canonicalizeUrl(candidate.url);
    if (!canonical || !candidate.title || (candidate.publishedAt && candidate.publishedAt > cutoff)) {
      stats.rejectedMalformed += 1;
      continue;
    }
    const group = grouped.get(canonical) ?? [];
    group.push({ ...candidate, url: canonical });
    grouped.set(canonical, group);
  }
  stats.unique = grouped.size;

  const ranked = [...grouped.entries()]
    .map(([url, discoveries]) => ({
      url,
      discoveries,
      best: discoveries.slice().sort((a, b) => b.signal - a.signal)[0]!,
    }))
    .sort((a, b) => b.best.signal - a.best.signal);

  // Popular HN links must not crowd editorial archives out before Sift reads
  // them. Reserve at least one third of each discovery refresh for non-HN
  // pools, then use spare capacity for whichever source has candidates left.
  const max = config.classics.discovery.max_candidates;
  const hnRanked = ranked.filter((entry) => entry.best.discoverySource === 'hn_archive');
  const editorialRanked = ranked.filter((entry) => entry.best.discoverySource !== 'hn_archive');
  const editorialTarget = Math.min(editorialRanked.length, Math.ceil(max * 0.34));
  const hnTarget = Math.min(hnRanked.length, max - editorialTarget);
  const selected = [...hnRanked.slice(0, hnTarget), ...editorialRanked.slice(0, editorialTarget)];
  if (selected.length < max) {
    selected.push(...[
      ...hnRanked.slice(hnTarget),
      ...editorialRanked.slice(editorialTarget),
    ].slice(0, max - selected.length));
  }

  db.transaction(() => {
    for (const { url, discoveries, best } of selected) {
      if (wasAlreadySeen(db, url)) {
        stats.previouslySurfaced += 1;
        continue;
      }

      let itemId = existingItemId(db, url);
      const candidateAlreadyKnown = itemId
        ? !!db.get(`SELECT 1 FROM classics_candidates WHERE item_id = :id`, { id: itemId })
        : false;
      if (!itemId) {
        itemId = insertFeedItem(db, best, url, now);
        stats.inserted += 1;
      } else if (!candidateAlreadyKnown) {
        stats.attachedToExisting += 1;
      } else {
        stats.alreadyKnown += 1;
      }

      const hnDiscoveries = discoveries.filter((entry) => entry.discoverySource === 'hn_archive');
      const hnPoints = Math.max(0, ...hnDiscoveries.map((entry) => Number(entry.metadata.hn_points ?? 0)));
      const hnComments = Math.max(0, ...hnDiscoveries.map((entry) => Number(entry.metadata.hn_comments ?? 0)));
      const hnSubmissions = hnDiscoveries.reduce(
        (sum, entry) => sum + Number(entry.metadata.hn_submissions ?? 0),
        0,
      );
      const sources = [...new Set(discoveries.map((entry) => entry.discoverySource))];

      db.run(
        `INSERT INTO classics_candidates (
           item_id, source_name, original_author, original_published_at,
           best_discovery_source, discovery_sources_json, historical_signal,
           hn_points, hn_comments, hn_submissions, status, first_discovered_at, updated_at)
         VALUES (:item, :source, :author, :published, :best, :sources, :signal,
                 :points, :comments, :submissions, 'discovered', :now, :now)
         ON CONFLICT(item_id) DO UPDATE SET
           source_name = CASE WHEN classics_candidates.source_name = '' THEN excluded.source_name ELSE classics_candidates.source_name END,
           original_author = COALESCE(classics_candidates.original_author, excluded.original_author),
           original_published_at = COALESCE(classics_candidates.original_published_at, excluded.original_published_at),
           best_discovery_source = CASE WHEN excluded.historical_signal > classics_candidates.historical_signal
                                        THEN excluded.best_discovery_source ELSE classics_candidates.best_discovery_source END,
           discovery_sources_json = excluded.discovery_sources_json,
           historical_signal = MAX(classics_candidates.historical_signal, excluded.historical_signal),
           hn_points = MAX(classics_candidates.hn_points, excluded.hn_points),
           hn_comments = MAX(classics_candidates.hn_comments, excluded.hn_comments),
           hn_submissions = MAX(classics_candidates.hn_submissions, excluded.hn_submissions),
           updated_at = excluded.updated_at`,
        {
          item: itemId,
          source: best.sourceName,
          author: best.author,
          published: best.publishedAt,
          best: best.discoverySource,
          sources: JSON.stringify(sources),
          signal: best.signal,
          points: hnPoints,
          comments: hnComments,
          submissions: hnSubmissions,
          now,
        },
      );

      for (const discovery of discoveries) {
        db.run(
          `INSERT INTO classics_candidate_discoveries (
             item_id, discovery_source, external_id, signal, metadata_json, discovered_at)
           VALUES (:item, :source, :external, :signal, :metadata, :now)
           ON CONFLICT(item_id, discovery_source, external_id) DO UPDATE SET
             signal = MAX(signal, excluded.signal), metadata_json = excluded.metadata_json`,
          {
            item: itemId,
            source: discovery.discoverySource,
            external: discovery.externalId,
            signal: discovery.signal,
            metadata: JSON.stringify(discovery.metadata),
            now,
          },
        );
        stats.bySource[discovery.discoverySource] = (stats.bySource[discovery.discoverySource] ?? 0) + 1;
      }
    }
  });

  log.info(
    `classics discovery: ${stats.unique} unique, ${stats.inserted} new, ` +
      `${stats.previouslySurfaced} already surfaced/read`,
  );
  return stats;
}
