import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { cosine, fromBlob } from '../embed/index.js';
import { titleSimilarity, collapseWhitespace } from '../util/text.js';
import { canonicalizeUrl, publisherDomain } from '../util/url.js';
import { stableId } from '../util/hash.js';
import { HOUR_MS } from '../util/time.js';
import type { AudioLink } from '../extract/index.js';
import { logger } from '../util/log.js';

const log = logger('alternate');

/**
 * Alternate-format resolution (§15).
 *
 * "This article also exists as a podcast episode" is the main case. Signals are
 * combined additively, each contributing its configured weight, and only
 * matches above a confidence threshold are ever surfaced. An article and its
 * audio version are never published as two separate recommendations: the audio
 * becomes a line inside the article's own entry.
 */

export type FormatType =
  | 'audio_version'
  | 'podcast_version'
  | 'companion_podcast'
  | 'video_version'
  | 'transcript';

export interface AlternateMatch {
  itemId: string;
  formatType: FormatType;
  url: string;
  title: string | null;
  publisher: string | null;
  durationMinutes: number | null;
  publishedAt: number | null;
  confidence: number;
  signals: Record<string, number>;
  spotifyUrl: string | null;
  sourceEpisodeItemId: string | null;
}

interface ArticleRow {
  id: string;
  source_id: string;
  title: string;
  canonical_url: string | null;
  publication_time: number | null;
  first_seen_at: number;
  enclosure_url: string | null;
  enclosure_type: string | null;
  duration_minutes: number | null;
  audio_links: string | null;
  structured_data: string | null;
}

interface EpisodeRow {
  id: string;
  source_id: string;
  source_name: string;
  title: string;
  canonical_url: string | null;
  original_url: string | null;
  rss_summary: string | null;
  publication_time: number | null;
  enclosure_url: string | null;
  duration_minutes: number | null;
}

/**
 * A public Spotify search deeplink. No Spotify API, account or SDK is involved;
 * this is the same URL you would get by typing the query into the app.
 */
export function spotifyEpisodeLink(title: string | null, publisher: string | null): string | null {
  const query = [title, publisher].filter(Boolean).join(' ').trim();
  if (!query) return null;
  return `https://open.spotify.com/search/${encodeURIComponent(query.slice(0, 120))}`;
}

function classify(link: { url: string; kind?: string; platform?: string | null }): FormatType {
  if (/youtube\.com|youtu\.be|vimeo\.com/i.test(link.url)) return 'video_version';
  if (/transcript/i.test(link.url)) return 'transcript';
  if (link.kind === 'audio_tag' || /\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(link.url)) return 'audio_version';
  return 'podcast_version';
}

function parseAudioLinks(json: string | null): AudioLink[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as AudioLink[]) : [];
  } catch {
    return [];
  }
}

/**
 * Score one candidate episode against one article. Pure, so the weighting can
 * be tuned and tested without a database.
 */
export function scoreEpisodeMatch(
  article: {
    title: string;
    canonicalUrl: string | null;
    publishedAt: number | null;
    sourceName: string;
  },
  episode: {
    title: string;
    description: string | null;
    publisher: string;
    publishedAt: number | null;
  },
  semanticSimilarity: number | null,
  config: AppConfig,
): { confidence: number; signals: Record<string, number> } {
  const cfg = config.pipeline.alternate_formats;
  const w = cfg.weights;
  const signals: Record<string, number> = {};
  let confidence = 0;

  // Strongest signal: the episode description links to the article itself.
  if (article.canonicalUrl && episode.description) {
    const canonical = article.canonicalUrl.replace(/^https?:\/\//, '');
    const bare = canonical.replace(/\/$/, '');
    if (episode.description.includes(bare) || episode.description.includes(canonical)) {
      const weight = w['url_mentioned_in_episode'] ?? 0.45;
      signals['url_mentioned_in_episode'] = weight;
      confidence += weight;
    }
  }

  const titleSim = titleSimilarity(article.title, episode.title);
  if (titleSim >= cfg.title_match_threshold) {
    const weight = (w['title_match'] ?? 0.3) * titleSim;
    signals['title_match'] = weight;
    confidence += weight;
  }

  if (
    article.sourceName &&
    episode.publisher &&
    normalisePublisher(article.sourceName) === normalisePublisher(episode.publisher)
  ) {
    const weight = w['publisher_match'] ?? 0.2;
    signals['publisher_match'] = weight;
    confidence += weight;
  }

  if (semanticSimilarity !== null && semanticSimilarity >= cfg.semantic_similarity_threshold) {
    const weight = (w['semantic_similarity'] ?? 0.3) * semanticSimilarity;
    signals['semantic_similarity'] = weight;
    confidence += weight;
  }

  if (article.publishedAt && episode.publishedAt) {
    const hours = Math.abs(article.publishedAt - episode.publishedAt) / HOUR_MS;
    if (hours <= cfg.max_date_distance_hours) {
      // Closer in time is stronger, tapering to zero at the limit.
      const weight = (w['date_proximity'] ?? 0.15) * (1 - hours / cfg.max_date_distance_hours);
      signals['date_proximity'] = weight;
      confidence += weight;
    } else {
      // Outside the window this is evidence against, not merely absent.
      signals['date_too_far'] = -0.25;
      confidence -= 0.25;
    }
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), signals };
}

function normalisePublisher(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|podcast|show|magazine|media|daily|weekly)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface AlternateStats {
  articlesChecked: number;
  matchesFound: number;
  byType: Record<string, number>;
  /**
   * Precision matters far more than recall here: a wrong "this is also a podcast"
   * link is worse than no link, because it sends the reader to the wrong thing.
   * These counters exist so that trade-off is measured before the feature is
   * expanded -- 2 matches from 20 checks says nothing about whether it works.
   */
  explicitAudioLinks: number;
  candidateMatches: number;
  highConfidenceMatches: number;
  belowThreshold: number;
}

/**
 * Find alternate formats for items that are about to be (or have just been)
 * published. Runs after routing so it only pays attention to things the reader
 * will actually see.
 */
export function resolveAlternateFormats(
  db: Db,
  config: AppConfig,
  embeddingModel: string,
  itemIds?: string[],
): AlternateStats {
  const stats: AlternateStats = {
    articlesChecked: 0,
    matchesFound: 0,
    byType: {},
    explicitAudioLinks: 0,
    candidateMatches: 0,
    highConfidenceMatches: 0,
    belowThreshold: 0,
  };
  if (!config.pipeline.alternate_formats.enabled) return stats;

  const cfg = config.pipeline.alternate_formats;
  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));

  const where = itemIds?.length
    ? `fi.id IN (${itemIds.map((_, i) => `:id${i}`).join(',')})`
    : `EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = fi.id)
       AND NOT EXISTS (SELECT 1 FROM alternate_formats a WHERE a.item_id = fi.id)`;

  const articles = db.all<ArticleRow>(
    `SELECT fi.id, fi.source_id, fi.title, fi.canonical_url, fi.publication_time, fi.first_seen_at,
            fi.enclosure_url, fi.enclosure_type, fi.duration_minutes,
            ac.audio_links, ac.structured_data
     FROM feed_items fi
     LEFT JOIN article_content ac ON ac.item_id = fi.id
     WHERE fi.is_podcast = 0 AND ${where}
     LIMIT 300`,
    itemIds?.length ? Object.fromEntries(itemIds.map((id, i) => [`id${i}`, id])) : {},
  );

  if (articles.length === 0) return stats;

  // Candidate episodes: everything from ingested podcast feeds in the window.
  const windowMs = cfg.max_date_distance_hours * HOUR_MS;
  const oldest = Math.min(...articles.map((a) => a.publication_time ?? a.first_seen_at));
  const episodes = db.all<EpisodeRow>(
    `SELECT fi.id, fi.source_id, s.name AS source_name, fi.title, fi.canonical_url, fi.original_url,
            fi.rss_summary, fi.publication_time, fi.enclosure_url, fi.duration_minutes
     FROM feed_items fi
     JOIN sources s ON s.id = fi.source_id
     WHERE fi.is_podcast = 1
       AND COALESCE(fi.publication_time, fi.first_seen_at) >= :since`,
    { since: oldest - windowMs },
  );

  const episodeVectors = new Map<string, Float32Array>();
  for (const row of db.all<{ owner_id: string; vector: Uint8Array }>(
    `SELECT owner_id, vector FROM embeddings WHERE owner_type = 'item' AND model = :m`,
    { m: embeddingModel },
  )) {
    episodeVectors.set(row.owner_id, fromBlob(row.vector));
  }

  const ts = Date.now();

  db.transaction(() => {
    for (const article of articles) {
      stats.articlesChecked += 1;
      const source = sourceMap.get(article.source_id);
      const sourceName = source?.name ?? article.source_id;
      const matches: AlternateMatch[] = [];

      // --- Signal 1: the feed item carries its own audio enclosure ---------
      if (article.enclosure_url && article.enclosure_type?.startsWith('audio/')) {
        matches.push({
          itemId: article.id,
          formatType: 'audio_version',
          url: article.enclosure_url,
          title: article.title,
          publisher: sourceName,
          durationMinutes: article.duration_minutes,
          publishedAt: article.publication_time,
          confidence: 1,
          signals: { enclosure: 1 },
          spotifyUrl: cfg.spotify_links ? spotifyEpisodeLink(article.title, sourceName) : null,
          sourceEpisodeItemId: null,
        });
      }

      // --- Signals 2-3: audio discovered inside the article page -----------
      const audioLinks = parseAudioLinks(article.audio_links);
      stats.explicitAudioLinks += audioLinks.length;
      for (const link of audioLinks) {
        const weightKey = link.kind === 'structured_data' ? 'structured_metadata' : link.kind === 'embed' ? 'embedded_player' : 'explicit_audio_link';
        const weight = cfg.weights[weightKey] ?? 0.4;
        // An audio file on the publisher's own domain is almost certainly the
        // audio version of this very article.
        const sameDomain =
          publisherDomain(link.url) && publisherDomain(article.canonical_url) === publisherDomain(link.url);
        const confidence = Math.min(1, weight + (sameDomain ? 0.3 : 0));
        matches.push({
          itemId: article.id,
          formatType: classify(link),
          url: link.url,
          title: link.title ?? article.title,
          publisher: link.publisher ?? sourceName,
          durationMinutes: link.durationMinutes ?? null,
          publishedAt: article.publication_time,
          confidence,
          signals: { [weightKey]: weight, ...(sameDomain ? { same_domain: 0.3 } : {}) },
          spotifyUrl: cfg.spotify_links ? spotifyEpisodeLink(link.title ?? article.title, sourceName) : null,
          sourceEpisodeItemId: null,
        });
      }

      // --- Signals 4-8: match against ingested podcast feeds ---------------
      const articleVector = episodeVectors.get(article.id) ?? null;
      for (const episode of episodes) {
        const episodeVector = episodeVectors.get(episode.id) ?? null;
        const semantic =
          articleVector && episodeVector ? cosine(articleVector, episodeVector) : null;

        const { confidence, signals } = scoreEpisodeMatch(
          {
            title: article.title,
            canonicalUrl: article.canonical_url,
            publishedAt: article.publication_time ?? article.first_seen_at,
            sourceName,
          },
          {
            title: episode.title,
            description: episode.rss_summary,
            publisher: episode.source_name,
            publishedAt: episode.publication_time,
          },
          semantic,
          config,
        );

        if (confidence < cfg.min_confidence) continue;

        const isSamePublisher = normalisePublisher(sourceName) === normalisePublisher(episode.source_name);
        matches.push({
          itemId: article.id,
          formatType: isSamePublisher ? 'podcast_version' : 'companion_podcast',
          url: episode.canonical_url ?? episode.original_url ?? episode.enclosure_url ?? '',
          title: episode.title,
          publisher: episode.source_name,
          durationMinutes: episode.duration_minutes,
          publishedAt: episode.publication_time,
          confidence,
          signals,
          spotifyUrl: cfg.spotify_links ? spotifyEpisodeLink(episode.title, episode.source_name) : null,
          sourceEpisodeItemId: episode.id,
        });
      }

      // Keep only confident matches, best first, one per format type.
      stats.candidateMatches += matches.length;
      const byType = new Map<FormatType, AlternateMatch>();
      for (const match of matches) {
        if (!match.url) continue;
        if (match.confidence < cfg.min_confidence) {
          stats.belowThreshold += 1;
          continue;
        }
        stats.highConfidenceMatches += 1;
        const existing = byType.get(match.formatType);
        if (!existing || match.confidence > existing.confidence) byType.set(match.formatType, match);
      }

      for (const match of byType.values()) {
        const id = stableId('alt', match.itemId, match.formatType, canonicalizeUrl(match.url) ?? match.url);
        db.run(
          `INSERT INTO alternate_formats (
              id, item_id, format_type, url, title, publisher, duration_minutes, published_at,
              confidence, signals_json, spotify_url, source_episode_item_id, created_at)
           VALUES (:id, :item, :type, :url, :title, :pub, :dur, :at, :conf, :signals, :spotify, :ep, :ts)
           ON CONFLICT(id) DO UPDATE SET
             confidence = excluded.confidence, signals_json = excluded.signals_json,
             duration_minutes = excluded.duration_minutes, spotify_url = excluded.spotify_url`,
          {
            id,
            item: match.itemId,
            type: match.formatType,
            url: match.url,
            title: match.title ? collapseWhitespace(match.title).slice(0, 300) : null,
            pub: match.publisher,
            dur: match.durationMinutes,
            at: match.publishedAt,
            conf: match.confidence,
            signals: JSON.stringify(match.signals),
            spotify: match.spotifyUrl,
            ep: match.sourceEpisodeItemId,
            ts,
          },
        );
        stats.matchesFound += 1;
        stats.byType[match.formatType] = (stats.byType[match.formatType] ?? 0) + 1;
      }
    }
  });

  log.info(`alternate formats: ${stats.matchesFound} matches for ${stats.articlesChecked} articles`, stats.byType);
  return stats;
}

export interface StoredAlternate {
  format_type: FormatType;
  url: string;
  title: string | null;
  publisher: string | null;
  duration_minutes: number | null;
  confidence: number;
  spotify_url: string | null;
}

export function alternatesForItem(db: Db, itemId: string, minConfidence: number): StoredAlternate[] {
  return db.all<StoredAlternate>(
    `SELECT format_type, url, title, publisher, duration_minutes, confidence, spotify_url
     FROM alternate_formats WHERE item_id = :id AND confidence >= :c
     ORDER BY confidence DESC`,
    { id: itemId, c: minConfidence },
  );
}

/**
 * Podcast episodes matched to an article we already publish must not become
 * separate recommendations of their own.
 */
export function suppressDuplicateEpisodes(db: Db): number {
  const rows = db.all<{ id: string }>(
    `SELECT DISTINCT a.source_episode_item_id AS id
     FROM alternate_formats a
     JOIN published_feed_items p ON p.item_id = a.item_id
     WHERE a.source_episode_item_id IS NOT NULL`,
  );
  let suppressed = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (!row.id) continue;
      const result = db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`,
        { id: row.id },
      );
      if ((result?.c ?? 0) > 0) {
        db.run(`DELETE FROM published_feed_items WHERE item_id = :id`, { id: row.id });
        suppressed += 1;
      }
      db.run(
        `UPDATE feed_items SET status = 'skipped_duplicate',
             status_reason = 'surfaced as the audio version of an article already published',
             status_updated_at = :ts
         WHERE id = :id AND status != 'published'`,
        { id: row.id, ts: Date.now() },
      );
    }
  });
  return suppressed;
}
