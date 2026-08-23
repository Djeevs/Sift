import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { stableId } from '../util/hash.js';
import { dayKey } from '../util/time.js';

/**
 * Passive feedback (§17).
 *
 * An open is a weak positive signal and nothing more: it says the headline was
 * appealing, not that the article was good. Nothing about the device, browser,
 * IP address or referrer is recorded -- only that this item was opened.
 */

export function recordOpen(
  db: Db,
  config: AppConfig,
  itemId: string,
  feedId: string | null,
  originalUrl: string,
): void {
  // With deduping on, repeated opens of the same item on the same day collapse
  // into one event, so re-reading cannot inflate a signal.
  const id = config.pipeline.feedback.dedupe_opens
    ? stableId('open', itemId, feedId ?? '', dayKey(Date.now()))
    : stableId('open', itemId, feedId ?? '', String(Date.now()), String(Math.random()));

  db.run(
    `INSERT INTO open_events (id, item_id, feed_id, original_url, opened_at)
     VALUES (:id, :item, :feed, :url, :ts)
     ON CONFLICT(id) DO NOTHING`,
    { id, item: itemId, feed: feedId, url: originalUrl, ts: Date.now() },
  );
}

export function openCount(db: Db, itemId: string): number {
  const row = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM open_events WHERE item_id = :id`, { id: itemId });
  return row?.c ?? 0;
}
