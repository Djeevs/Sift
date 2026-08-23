import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';

/**
 * Attention cost.
 *
 * One article is not one article: a 35-minute essay costs far more than a
 * 4-minute post, so feeds are budgeted in minutes as well as items. The estimate
 * comes from the best source available, in order of trustworthiness:
 *
 *   extracted  word count from the fetched article body (most reliable)
 *   terra      the deep model's own estimate
 *   enclosure  podcast duration, for audio items
 *   default    the configured fallback
 */

export type AttentionSource = 'extracted' | 'terra' | 'enclosure' | 'default';

export interface AttentionEstimate {
  readingMinutes: number;
  listeningMinutes: number | null;
  wordCount: number | null;
  source: AttentionSource;
}

const WORDS_PER_MINUTE = 230;

export function estimateAttention(
  input: {
    wordCount?: number | null;
    extractedReadingMinutes?: number | null;
    terraReadingMinutes?: number | null;
    durationMinutes?: number | null;
  },
  config: AppConfig,
): AttentionEstimate {
  const fallback = config.final.final_ranking.attention.default_reading_minutes;

  if (input.wordCount && input.wordCount > 200) {
    return {
      readingMinutes: Math.max(1, Math.round(input.wordCount / WORDS_PER_MINUTE)),
      listeningMinutes: input.durationMinutes ?? null,
      wordCount: input.wordCount,
      source: 'extracted',
    };
  }
  if (input.extractedReadingMinutes && input.extractedReadingMinutes > 0) {
    return {
      readingMinutes: input.extractedReadingMinutes,
      listeningMinutes: input.durationMinutes ?? null,
      wordCount: input.wordCount ?? null,
      source: 'extracted',
    };
  }
  if (input.terraReadingMinutes && input.terraReadingMinutes > 0) {
    return {
      readingMinutes: input.terraReadingMinutes,
      listeningMinutes: input.durationMinutes ?? null,
      wordCount: null,
      source: 'terra',
    };
  }
  if (input.durationMinutes && input.durationMinutes > 0) {
    return {
      readingMinutes: input.durationMinutes,
      listeningMinutes: input.durationMinutes,
      wordCount: null,
      source: 'enclosure',
    };
  }
  return { readingMinutes: fallback, listeningMinutes: null, wordCount: null, source: 'default' };
}

/** Compute and store estimates for items that have reached deep evaluation. */
export function refreshAttentionEstimates(db: Db, config: AppConfig, itemIds?: string[]): number {
  const where = itemIds?.length
    ? `fi.id IN (${itemIds.map((_, i) => `:id${i}`).join(',')})`
    : `EXISTS (SELECT 1 FROM deep_evaluations de WHERE de.item_id = fi.id)`;

  const rows = db.all<{
    id: string;
    word_count: number | null;
    reading_minutes: number | null;
    terra_minutes: number | null;
    duration_minutes: number | null;
  }>(
    `SELECT fi.id, ac.word_count, ac.reading_minutes,
            de.estimated_reading_minutes AS terra_minutes, fi.duration_minutes
     FROM feed_items fi
     LEFT JOIN article_content ac ON ac.item_id = fi.id
     LEFT JOIN deep_evaluations de ON de.item_id = fi.id
     WHERE ${where}`,
    itemIds?.length ? Object.fromEntries(itemIds.map((id, i) => [`id${i}`, id])) : {},
  );

  const ts = Date.now();
  db.transaction(() => {
    for (const row of rows) {
      const estimate = estimateAttention(
        {
          wordCount: row.word_count,
          extractedReadingMinutes: row.reading_minutes,
          terraReadingMinutes: row.terra_minutes,
          durationMinutes: row.duration_minutes,
        },
        config,
      );
      db.run(
        `INSERT INTO attention_estimates (item_id, reading_minutes, listening_minutes, word_count, source, created_at)
         VALUES (:id, :read, :listen, :words, :src, :ts)
         ON CONFLICT(item_id) DO UPDATE SET
           reading_minutes = excluded.reading_minutes,
           listening_minutes = excluded.listening_minutes,
           word_count = excluded.word_count,
           source = excluded.source, created_at = excluded.created_at`,
        {
          id: row.id,
          read: estimate.readingMinutes,
          listen: estimate.listeningMinutes,
          words: estimate.wordCount,
          src: estimate.source,
          ts,
        },
      );
    }
  });
  return rows.length;
}

export function attentionMinutes(db: Db, itemIds: string[]): Map<string, number> {
  if (itemIds.length === 0) return new Map();
  const rows = db.all<{ item_id: string; reading_minutes: number | null }>(
    `SELECT item_id, reading_minutes FROM attention_estimates
     WHERE item_id IN (${itemIds.map((_, i) => `:id${i}`).join(',')})`,
    Object.fromEntries(itemIds.map((id, i) => [`id${i}`, id])),
  );
  return new Map(rows.map((r) => [r.item_id, r.reading_minutes ?? 0]));
}

/** Minutes already committed to a feed today. */
export function minutesSpentToday(db: Db, feedId: string, dayKey: string): number {
  const row = db.get<{ m: number }>(
    `SELECT COALESCE(SUM(a.reading_minutes), 0) AS m
     FROM published_feed_items p
     LEFT JOIN attention_estimates a ON a.item_id = p.item_id
     WHERE p.feed_id = :f AND p.day_key = :d`,
    { f: feedId, d: dayKey },
  );
  return row?.m ?? 0;
}
