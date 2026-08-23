import type { Db } from '../db/index.js';
import { sourceCategories } from '../config/index.js';
import type { AppConfig, SourceConfig } from '../config/index.js';
import { parseFeed, type ParsedItem } from './parseFeed.js';
import { fetchText, isPermanentFailure } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';
import { stableId } from '../util/hash.js';
import { collapseWhitespace, stripHtml, truncate } from '../util/text.js';
import { DAY_MS } from '../util/time.js';
import { mapPool } from '../util/pool.js';
import { logger } from '../util/log.js';
import { recordError } from '../pipeline/journal.js';
import { fetchHackerNewsItems } from './hackerNews.js';

const log = logger('ingest');

export interface IngestStats {
  sourcesPolled: number;
  sourcesFailed: number;
  sourcesNotModified: number;
  itemsSeen: number;
  itemsNew: number;
  itemsDuplicate: number;
  itemsTooOld: number;
  itemsMalformed: number;
}

/** Mirror sources.yaml into the database, preserving learned state. */
export function syncSources(db: Db, config: AppConfig): void {
  const ts = Date.now();
  db.transaction(() => {
    for (const s of config.sources) {
      db.run(
        `INSERT INTO sources (id, name, url, feed_type, language, enabled, publishable,
                              categories_json, config_prior, created_at, updated_at)
         VALUES (:id, :name, :url, :feed_type, :language, :enabled, :publishable,
                 :categories, :prior, :ts, :ts)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           url = excluded.url,
           feed_type = excluded.feed_type,
           language = excluded.language,
           enabled = excluded.enabled,
           publishable = excluded.publishable,
           categories_json = excluded.categories_json,
           config_prior = excluded.config_prior,
           updated_at = excluded.updated_at`,
        {
          id: s.id,
          name: s.name,
          url: s.feed_url,
          feed_type: s.feed_type,
          language: s.language,
          enabled: s.enabled ? 1 : 0,
          publishable: s.publishable ? 1 : 0,
          categories: JSON.stringify(sourceCategories(s)),
          prior: s.quality_prior,
          ts,
        },
      );
    }
  });
  log.debug(`synced ${config.sources.length} sources`);
}

interface SourceState {
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  disabled_until: number | null;
}

/** Deterministic item id: the same feed entry always maps to the same row. */
export function computeItemId(sourceId: string, item: ParsedItem): string {
  const canonical = canonicalizeUrl(item.link);
  // Prefer the feed's own guid; fall back to the URL; last resort title+date.
  const key = item.guid?.trim() || canonical || `${item.title}|${item.publishedAt ?? ''}`;
  return stableId(sourceId, key);
}

export interface NormalizedItem {
  id: string;
  source_id: string;
  guid: string | null;
  original_url: string | null;
  canonical_url: string | null;
  title: string;
  subtitle: string | null;
  rss_summary: string | null;
  rss_content: string | null;
  author: string | null;
  publication_time: number | null;
  feed_categories: string[];
  enclosure_url: string | null;
  enclosure_type: string | null;
  enclosure_length: number | null;
  duration_minutes: number | null;
  raw_feed_metadata: Record<string, unknown>;
  feed_images: ParsedItem['images'];
  item_kind: 'article' | 'product';
  language: string | null;
  is_podcast: boolean;
}

export function normalizeItem(
  source: SourceConfig,
  item: ParsedItem,
  feedIsPodcast: boolean,
  feedLanguage: string | null = null,
): NormalizedItem {
  const canonical = canonicalizeUrl(item.link);
  const summaryText = item.summary ? truncate(collapseWhitespace(stripHtml(item.summary)), 2000) : null;
  const isAudio = !!item.enclosure?.type?.startsWith('audio/');

  return {
    id: computeItemId(source.id, item),
    source_id: source.id,
    guid: item.guid ?? null,
    original_url: item.link ?? null,
    canonical_url: canonical,
    title: item.title || '(untitled)',
    subtitle: item.subtitle,
    rss_summary: summaryText,
    rss_content: item.content ?? null,
    author: item.author,
    publication_time: item.publishedAt,
    feed_categories: item.categories,
    enclosure_url: item.enclosure?.url ?? null,
    enclosure_type: item.enclosure?.type ?? null,
    enclosure_length: item.enclosure?.length ?? null,
    duration_minutes: item.durationMinutes,
    raw_feed_metadata: item.extra,
    feed_images: item.images,
    item_kind: source.item_kind,
    language: item.language ?? feedLanguage ?? source.language,
    is_podcast: source.feed_type === 'podcast' || (feedIsPodcast && isAudio),
  };
}

export async function ingestAll(db: Db, config: AppConfig, opts: { sourceIds?: string[] } = {}): Promise<IngestStats> {
  syncSources(db, config);

  const enabled = config.sources.filter(
    (s) => s.enabled && (!opts.sourceIds || opts.sourceIds.includes(s.id)),
  );

  const stats: IngestStats = {
    sourcesPolled: 0,
    sourcesFailed: 0,
    sourcesNotModified: 0,
    itemsSeen: 0,
    itemsNew: 0,
    itemsDuplicate: 0,
    itemsTooOld: 0,
    itemsMalformed: 0,
  };

  const results = await mapPool(enabled, config.env.fetchConcurrency, async (source) => {
    const state = db.get<SourceState>(
      `SELECT etag, last_modified, consecutive_failures, disabled_until FROM sources WHERE id = :id`,
      { id: source.id },
    );

    // A feed that has been broken for a while is polled less often, but is
    // never abandoned permanently.
    if (state?.disabled_until && state.disabled_until > Date.now()) {
      log.debug(`${source.id}: in backoff until ${new Date(state.disabled_until).toISOString()}`);
      return null;
    }

    const res = await fetchText(source.feed_url, {
      etag: state?.etag ?? null,
      lastModified: state?.last_modified ?? null,
      retries: 2,
      // Long-running podcast archives run to several megabytes.
      maxBytes: 24_000_000,
    });

    const ts = Date.now();
    if (!res.ok) {
      const failures = (state?.consecutive_failures ?? 0) + 1;
      // Exponential backoff, capped at ~12 hours; permanent errors back off hard.
      const backoffHours = isPermanentFailure(res.status)
        ? Math.min(24, 2 ** Math.min(failures, 5))
        : Math.min(12, 0.5 * 2 ** Math.min(failures, 5));
      db.run(
        `UPDATE sources SET last_fetch_at = :ts, consecutive_failures = :f,
                            last_error = :err, disabled_until = :until, updated_at = :ts
         WHERE id = :id`,
        {
          id: source.id,
          ts,
          f: failures,
          err: `${res.status} ${res.error ?? ''}`.trim(),
          until: ts + backoffHours * 3_600_000,
        },
      );
      recordError(db, source.id, 'ingest', `fetch failed: ${res.status} ${res.error ?? ''}`);
      stats.sourcesFailed += 1;
      log.warn(`${source.id}: fetch failed (${res.status} ${res.error ?? ''})`);
      return null;
    }

    if (res.notModified) {
      db.run(
        `UPDATE sources SET last_fetch_at = :ts, last_success_at = :ts, consecutive_failures = 0,
                            last_error = NULL, disabled_until = NULL, updated_at = :ts WHERE id = :id`,
        { id: source.id, ts },
      );
      stats.sourcesNotModified += 1;
      stats.sourcesPolled += 1;
      return null;
    }

    const feed = source.discovery
      ? {
          kind: 'unknown' as const,
          title: source.name,
          siteUrl: null,
          description: null,
          language: null,
          isPodcast: false,
          items: await fetchHackerNewsItems(source, res.body, config.env.fetchConcurrency),
        }
      : parseFeed(res.body, source.feed_url);
    if (feed.items.length === 0) {
      recordError(db, source.id, 'ingest', 'feed parsed to zero items');
      log.warn(`${source.id}: parsed 0 items (${res.body.length} bytes)`);
    }

    db.run(
      `UPDATE sources SET etag = :etag, last_modified = :lm, last_fetch_at = :ts,
                          last_success_at = :ts, consecutive_failures = 0, last_error = NULL,
                          disabled_until = NULL, updated_at = :ts
       WHERE id = :id`,
      { id: source.id, etag: res.etag, lm: res.lastModified, ts },
    );

    stats.sourcesPolled += 1;
    const persisted = persistItems(db, config, source, feed.items, feed.isPodcast, feed.language);
    stats.itemsSeen += persisted.seen;
    stats.itemsNew += persisted.inserted;
    stats.itemsDuplicate += persisted.duplicate;
    stats.itemsTooOld += persisted.tooOld;
    stats.itemsMalformed += persisted.malformed;
    log.info(
      `${source.id}: ${persisted.inserted} new / ${persisted.seen} seen` +
        (persisted.tooOld ? ` (${persisted.tooOld} too old)` : ''),
    );
    return null;
  });

  for (const r of results) {
    if (!r.ok) log.error('source task threw', r.error);
  }

  return stats;
}

interface PersistCounts {
  seen: number;
  inserted: number;
  duplicate: number;
  tooOld: number;
  malformed: number;
}

export function persistItems(
  db: Db,
  config: AppConfig,
  source: SourceConfig,
  items: ParsedItem[],
  feedIsPodcast: boolean,
  feedLanguage: string | null = null,
): PersistCounts {
  const counts: PersistCounts = { seen: 0, inserted: 0, duplicate: 0, tooOld: 0, malformed: 0 };
  const maxAgeDays = source.hard_rules?.max_age_days ?? config.pipeline.ingest.max_item_age_days;
  const cutoff = Date.now() - maxAgeDays * DAY_MS;
  const limit = config.pipeline.ingest.max_items_per_source_per_poll;
  const ts = Date.now();

  const candidates = items.slice(0, limit);

  db.transaction(() => {
    for (const raw of candidates) {
      counts.seen += 1;
      const item = normalizeItem(source, raw, feedIsPodcast, feedLanguage);

      if (!item.title || item.title === '(untitled)') {
        if (!item.canonical_url) {
          counts.malformed += 1;
          continue;
        }
      }

      // An item with no date is treated as new: better to evaluate it than to
      // silently discard a feed that omits pubDate.
      if (item.publication_time !== null && item.publication_time < cutoff) {
        counts.tooOld += 1;
        continue;
      }
      // Guard against feeds with clocks in the future.
      if (item.publication_time !== null && item.publication_time > ts + 2 * DAY_MS) {
        item.publication_time = ts;
      }

      const existing = db.get<{ id: string }>(`SELECT id FROM feed_items WHERE id = :id`, { id: item.id });
      if (existing) {
        counts.duplicate += 1;
        continue;
      }

      // The same article syndicated by two sources: keep the row, but mark it
      // so it never reaches the model twice.
      let status = 'new';
      let statusReason: string | null = null;
      if (item.canonical_url && config.free.rule_filter.drop_duplicate_urls) {
        const twin = db.get<{ id: string; source_id: string }>(
          `SELECT id, source_id FROM feed_items WHERE canonical_url = :u LIMIT 1`,
          { u: item.canonical_url },
        );
        if (twin) {
          status = 'skipped_duplicate';
          statusReason = `same canonical URL as ${twin.id} (${twin.source_id})`;
          counts.duplicate += 1;
        }
      }

      db.run(
        `INSERT INTO feed_items (
            id, source_id, guid, original_url, canonical_url, title, subtitle,
            rss_summary, rss_content, author, publication_time, feed_categories_json,
            enclosure_url, enclosure_type, enclosure_length, duration_minutes,
            raw_feed_metadata, feed_images_json, item_kind, language, is_podcast, first_seen_at, status,
            status_reason, status_updated_at)
         VALUES (
            :id, :source_id, :guid, :original_url, :canonical_url, :title, :subtitle,
            :rss_summary, :rss_content, :author, :publication_time, :feed_categories,
            :enclosure_url, :enclosure_type, :enclosure_length, :duration_minutes,
            :raw_feed_metadata, :feed_images, :item_kind, :language, :is_podcast, :ts, :status, :status_reason, :ts)
         ON CONFLICT(id) DO NOTHING`,
        {
          id: item.id,
          source_id: item.source_id,
          guid: item.guid,
          original_url: item.original_url,
          canonical_url: item.canonical_url,
          title: item.title,
          subtitle: item.subtitle,
          rss_summary: item.rss_summary,
          rss_content: item.rss_content,
          author: item.author,
          publication_time: item.publication_time,
          feed_categories: JSON.stringify(item.feed_categories),
          enclosure_url: item.enclosure_url,
          enclosure_type: item.enclosure_type,
          enclosure_length: item.enclosure_length,
          duration_minutes: item.duration_minutes,
          raw_feed_metadata: JSON.stringify(item.raw_feed_metadata),
          feed_images: JSON.stringify(item.feed_images),
          item_kind: item.item_kind,
          language: item.language,
          is_podcast: item.is_podcast ? 1 : 0,
          ts,
          status,
          status_reason: statusReason,
        },
      );
      if (status === 'new') counts.inserted += 1;
    }
  });

  return counts;
}
