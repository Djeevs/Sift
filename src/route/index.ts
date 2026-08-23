/**
 * Stage 6 entry point.
 *
 * The old hard-cap router lived here. It has been replaced by portfolio
 * construction in ../rank/: this module remains as the stable import path used by
 * the pipeline, CLI and tests, and as the place where the read-side helpers live.
 *
 * The behavioural change is worth stating plainly. The old router sorted by score
 * and applied caps ("never more than 3 from this source"), which meant an
 * excellent fourth item was discarded to make room for nothing. The new one uses
 * diminishing returns, so a source's fourth item competes at a discount and can
 * still win. Caps survive only as a final safety valve.
 */
export { publishEditions as routeAndPublish, type EditionStats as RouteStats } from '../rank/publishEdition.js';
export * from './score.js';

import type { Db } from '../db/index.js';
import { dayKey } from '../util/time.js';

/** Items published to a feed, newest first. */
export function recentPublished(db: Db, feedId: string, limit: number) {
  return db.all<{
    item_id: string;
    score: number;
    why_it_surfaced: string | null;
    published_at: number;
  }>(
    `SELECT item_id, score, why_it_surfaced, published_at
     FROM published_feed_items WHERE feed_id = :f
     ORDER BY published_at DESC LIMIT :l`,
    { f: feedId, l: limit },
  );
}

export function publishedTodayCount(db: Db, feedId: string): number {
  const row = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM published_feed_items WHERE feed_id = :f AND day_key = :d`,
    { f: feedId, d: dayKey(Date.now()) },
  );
  return row?.c ?? 0;
}
