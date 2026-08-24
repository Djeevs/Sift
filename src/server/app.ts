import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { allFeeds } from '../config/index.js';
import { renderFeedDocuments } from './renderFeed.js';
import { recordOpen } from '../feedback/opens.js';
import { adminRoutes } from './admin.js';
import { logger } from '../util/log.js';

const log = logger('server');

/**
 * The HTTP surface: generated feeds, tracked redirects, and a small admin view.
 * Deliberately not a reader UI -- Reeder is the frontend.
 */

export function createApp(db: Db, config: AppConfig): Hono {
  const app = new Hono();
  const token = config.env.accessToken;
  const feeds = allFeeds(config);

  /** Feeds and admin are token-protected; /open is not (see below). */
  const authorised = (provided: string | undefined): boolean => {
    if (!token || token === 'change-me-please') return true; // local development
    return provided === token;
  };

  app.get('/', (c) => {
    const urls = feeds.map((f) => {
      const suffix = token && token !== 'change-me-please' ? `?t=${encodeURIComponent(token)}` : '';
      return `${config.env.publicUrl}/feed/${f.slug}.xml${suffix}`;
    });
    return c.text(
      ['Sift — a private editorial desk.', '', 'Feeds:', ...urls.map((u) => `  ${u}`), '', 'Admin: /admin'].join('\n'),
    );
  });

  app.get('/health', (c) => {
    const counts = db.get<{ items: number; published: number }>(
      `SELECT (SELECT COUNT(*) FROM feed_items) AS items,
              (SELECT COUNT(*) FROM published_feed_items) AS published`,
    );
    return c.json({ ok: true, ...counts, time: new Date().toISOString() });
  });

  // --- Generated feeds ------------------------------------------------------
  app.get('/feed/:file', (c) => {
    const file = c.req.param('file');
    const match = /^(.+?)\.(xml|atom|rss|json)$/.exec(file);
    if (!match) return c.notFound();
    const [, slug, ext] = match;

    if (!authorised(c.req.query('t'))) return c.text('Not found', 404);

    const feed = feeds.find((f) => f.slug === slug || f.id === slug);
    if (!feed) return c.notFound();

    const documents = renderFeedDocuments(db, config, feed, {
      tracked: config.final.final_ranking.tracked_links,
      publicUrl: config.env.publicUrl,
      accessToken: token,
    });

    const body = ext === 'rss' ? documents.rss : ext === 'json' ? documents.json : documents.atom;

    return c.body(body, 200, {
      'content-type': ext === 'rss'
        ? 'application/rss+xml; charset=utf-8'
        : ext === 'json'
          ? 'application/feed+json; charset=utf-8'
          : 'application/atom+xml; charset=utf-8',
      'cache-control': 'max-age=600',
    });
  });

  // --- Tracked opens --------------------------------------------------------
  // Not token-gated: these URLs are opened by the reader app and sometimes by
  // its link preview. The id is unguessable, and the endpoint only ever
  // redirects to a URL already stored for that id.
  app.get('/open/:itemId', (c) => {
    const itemId = c.req.param('itemId');
    const feedId = c.req.query('feed') ?? null;

    const row = db.get<{ original_url: string | null; canonical_url: string | null }>(
      `SELECT original_url, canonical_url FROM feed_items WHERE id = :id`,
      { id: itemId },
    );
    if (!row) return c.text('Unknown item', 404);

    const target = row.original_url ?? row.canonical_url;
    if (!target) return c.text('No URL for this item', 404);

    try {
      recordOpen(db, config, itemId, feedId, target);
    } catch (err) {
      // Recording an open must never stop the reader from reaching the article.
      log.warn('failed to record open', err);
    }

    // no-referrer keeps our URLs (and the reading history they imply) out of
    // the publisher's logs.
    c.header('referrer-policy', 'no-referrer');
    c.header('cache-control', 'no-store');
    return c.redirect(target, 302);
  });

  // --- Admin ----------------------------------------------------------------
  app.route('/admin', adminRoutes(db, config, authorised));

  app.notFound((c) => c.text('Not found', 404));
  app.onError((err, c) => {
    log.error('request failed', err);
    return c.text('Internal error', 500);
  });

  return app;
}
