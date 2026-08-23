import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { fetchText } from '../util/http.js';
import { parseFeed } from './../ingest/parseFeed.js';
import { canonicalizeUrl } from '../util/url.js';
import { titleSimilarity, collapseWhitespace } from '../util/text.js';
import { stableId } from '../util/hash.js';
import { recordError } from '../pipeline/journal.js';
import { logger } from '../util/log.js';

const log = logger('feedback');

/**
 * Explicit feedback from Reeder (§18).
 *
 * Reeder can publish a shared/starred feed for a tag. Point one such URL at
 * "Excellent" and another at "Not for me" in feedback-feeds.yaml (or via env)
 * and this module polls them and matches entries back to our items.
 *
 * Kept deliberately modular: matching works off tracked links, canonical URLs
 * and titles, so it survives Reeder changing what it exposes. If Reeder's
 * capabilities change, only `resolveFeedbackFeeds` and this file need edits.
 */

export type FeedbackSignal = 'excellent' | 'not_for_me';

export interface FeedbackFeed {
  url: string;
  signal: FeedbackSignal;
}

/**
 * Feedback feed URLs come from the environment so no secret or personal URL
 * lands in a config file that might be shared:
 *   SIFT_FEEDBACK_EXCELLENT_URL=...
 *   SIFT_FEEDBACK_NOT_FOR_ME_URL=...
 * Multiple URLs per signal can be comma-separated.
 */
export function resolveFeedbackFeeds(): FeedbackFeed[] {
  const feeds: FeedbackFeed[] = [];
  const add = (raw: string | undefined, signal: FeedbackSignal) => {
    for (const url of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      feeds.push({ url, signal });
    }
  };
  add(process.env.SIFT_FEEDBACK_EXCELLENT_URL, 'excellent');
  add(process.env.SIFT_FEEDBACK_NOT_FOR_ME_URL, 'not_for_me');
  return feeds;
}

export interface MatchCandidate {
  id: string;
  title: string;
  canonical_url: string | null;
  original_url: string | null;
}

export interface MatchOutcome {
  itemId: string | null;
  matchedBy: 'tracked_link' | 'url' | 'title' | null;
}

/**
 * Match a feedback entry back to one of our items.
 *
 * Reeder may hand back our tracked /open/<id> link, the publisher's URL, or
 * (for some export paths) only a title. All three are handled.
 */
export function matchFeedbackEntry(
  entry: { title: string; link: string | null },
  candidates: MatchCandidate[],
): MatchOutcome {
  // 1. Our own tracked link carries the item id directly.
  if (entry.link) {
    const tracked = /\/open\/([A-Za-z0-9_-]{8,})/.exec(entry.link);
    if (tracked) {
      const id = tracked[1]!;
      if (candidates.some((c) => c.id === id)) return { itemId: id, matchedBy: 'tracked_link' };
    }
  }

  // 2. Canonical URL.
  const canonical = canonicalizeUrl(entry.link);
  if (canonical) {
    const hit = candidates.find(
      (c) => c.canonical_url === canonical || canonicalizeUrl(c.original_url) === canonical,
    );
    if (hit) return { itemId: hit.id, matchedBy: 'url' };
  }

  // 3. Title, but only on a strong match: a weak title match producing a
  // *strong negative* signal on the wrong article would be worse than no
  // feedback at all.
  const title = collapseWhitespace(entry.title);
  if (title.length >= 12) {
    let best: { id: string; score: number } | null = null;
    for (const candidate of candidates) {
      const score = titleSimilarity(title, candidate.title);
      if (!best || score > best.score) best = { id: candidate.id, score };
    }
    if (best && best.score >= 0.75) return { itemId: best.id, matchedBy: 'title' };
  }

  return { itemId: null, matchedBy: null };
}

export interface FeedbackStats {
  feedsPolled: number;
  entriesSeen: number;
  matched: number;
  unmatched: number;
  newFeedback: number;
}

export async function pollFeedbackFeeds(
  db: Db,
  config: AppConfig,
  feeds: FeedbackFeed[] = resolveFeedbackFeeds(),
): Promise<FeedbackStats> {
  const stats: FeedbackStats = { feedsPolled: 0, entriesSeen: 0, matched: 0, unmatched: 0, newFeedback: 0 };
  if (feeds.length === 0) {
    log.info('no feedback feeds configured (SIFT_FEEDBACK_EXCELLENT_URL / SIFT_FEEDBACK_NOT_FOR_ME_URL)');
    return stats;
  }

  // Only items we have actually published can receive feedback.
  const candidates = db.all<MatchCandidate>(
    `SELECT DISTINCT fi.id, fi.title, fi.canonical_url, fi.original_url
     FROM feed_items fi
     JOIN published_feed_items p ON p.item_id = fi.id
     ORDER BY p.published_at DESC
     LIMIT 3000`,
  );

  for (const feed of feeds) {
    const res = await fetchText(feed.url, { retries: 2 });
    if (!res.ok) {
      recordError(db, feed.url, 'feedback', `fetch failed: ${res.status} ${res.error ?? ''}`);
      log.warn(`feedback feed failed: ${feed.url} (${res.status})`);
      continue;
    }
    stats.feedsPolled += 1;

    const parsed = parseFeed(res.body, feed.url);
    for (const entry of parsed.items) {
      stats.entriesSeen += 1;
      const outcome = matchFeedbackEntry({ title: entry.title, link: entry.link }, candidates);

      if (outcome.itemId) stats.matched += 1;
      else stats.unmatched += 1;

      // Deterministic id: repolling the same starred item cannot inflate the
      // signal, however many times cron runs.
      const id = stableId(
        'feedback',
        feed.signal,
        outcome.itemId ?? canonicalizeUrl(entry.link) ?? entry.title,
      );

      const before = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM explicit_feedback WHERE id = :id`, { id });
      db.run(
        `INSERT INTO explicit_feedback (id, item_id, signal, origin, matched_by, raw_title, raw_url, created_at)
         VALUES (:id, :item, :signal, 'reeder_feed', :matched, :title, :url, :ts)
         ON CONFLICT(id) DO NOTHING`,
        {
          id,
          item: outcome.itemId,
          signal: feed.signal,
          matched: outcome.matchedBy,
          title: entry.title.slice(0, 300),
          url: entry.link,
          ts: entry.publishedAt ?? Date.now(),
        },
      );
      if ((before?.c ?? 0) === 0) stats.newFeedback += 1;
    }
  }

  log.info(
    `feedback: ${stats.newFeedback} new signals (${stats.matched} matched, ${stats.unmatched} unmatched) from ${stats.feedsPolled} feeds`,
  );
  return stats;
}

/** Record feedback by hand, for the times a feed round-trip is not worth it. */
export function recordManualFeedback(
  db: Db,
  itemId: string,
  signal: FeedbackSignal,
  note?: string,
): void {
  db.run(
    `INSERT INTO explicit_feedback (id, item_id, signal, origin, matched_by, note, created_at)
     VALUES (:id, :item, :signal, 'manual', 'manual', :note, :ts)
     ON CONFLICT(id) DO UPDATE SET note = excluded.note`,
    { id: stableId('feedback', 'manual', signal, itemId), item: itemId, signal, note: note ?? null, ts: Date.now() },
  );
}
