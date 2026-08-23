import type { Db } from '../db/index.js';
import { stableId } from '../util/hash.js';
import { logger } from '../util/log.js';

const log = logger('journal');

/** Per-item, per-stage status transitions plus a durable error log. */

export function setStatus(db: Db, itemId: string, status: string, reason?: string | null): void {
  db.run(
    `UPDATE feed_items SET status = :s, status_reason = :r, status_updated_at = :ts WHERE id = :id`,
    { id: itemId, s: status, r: reason ?? null, ts: Date.now() },
  );
}

export function recordError(db: Db, scope: string, stage: string, message: string, detail?: unknown): void {
  db.run(
    `INSERT INTO processing_errors (scope, stage, message, detail, created_at)
     VALUES (:scope, :stage, :message, :detail, :ts)`,
    {
      scope,
      stage,
      message: message.slice(0, 500),
      detail: detail === undefined ? null : safeJson(detail).slice(0, 4000),
      ts: Date.now(),
    },
  );
}

export function markItemError(db: Db, itemId: string, stage: string, message: string): void {
  db.run(
    `UPDATE feed_items SET error_count = error_count + 1, status = 'error',
                           status_reason = :r, status_updated_at = :ts WHERE id = :id`,
    { id: itemId, r: `${stage}: ${message}`.slice(0, 300), ts: Date.now() },
  );
  recordError(db, itemId, stage, message);
}

export interface Job {
  id: string;
  kind: string;
  finish(stats: Record<string, unknown>): void;
  fail(error: unknown): void;
}

export function startJob(db: Db, kind: string): Job {
  const id = stableId(kind, String(Date.now()), String(Math.random()));
  const startedAt = Date.now();
  db.run(
    `INSERT INTO processing_jobs (id, kind, status, started_at) VALUES (:id, :kind, 'running', :ts)`,
    { id, kind, ts: startedAt },
  );
  log.info(`job ${kind} started`);

  return {
    id,
    kind,
    finish(stats) {
      db.run(
        `UPDATE processing_jobs SET status = 'ok', finished_at = :ts, stats_json = :stats WHERE id = :id`,
        { id, ts: Date.now(), stats: safeJson(stats) },
      );
      log.info(`job ${kind} ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`, stats);
    },
    fail(error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      db.run(
        `UPDATE processing_jobs SET status = 'failed', finished_at = :ts, error = :err WHERE id = :id`,
        { id, ts: Date.now(), err: message.slice(0, 2000) },
      );
      log.error(`job ${kind} failed`, message);
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}
