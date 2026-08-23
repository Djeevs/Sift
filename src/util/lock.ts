/**
 * One pipeline run at a time, per database.
 *
 * The pipeline can be started from four places now: the dashboard button, the
 * scheduler inside the long-running server, `npm run pipeline` in a terminal,
 * and cron. Nothing stopped two of them overlapping. Concurrent runs against
 * one database do not merely waste effort -- they both pay for the same Terra
 * evaluations, so the failure is a doubled bill and a corrupted spend ledger
 * rather than a crash anyone would notice.
 *
 * The lock is a file, not a mutex, because the contending runs are separate
 * processes. It records the pid so a lock left behind by a crash can be told
 * apart from a run that is genuinely still going -- otherwise the first crash
 * would wedge the pipeline permanently, which is worse than the problem.
 *
 * The database path is the lock identity because the database is the resource
 * actually being contended. Two readers with different profiles have different
 * databases and never block each other.
 */
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { logger } from './log.js';

const log = logger('lock');

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  command: string;
}

export class LockedError extends Error {
  constructor(readonly holder: LockInfo, readonly path: string) {
    const started = new Date(holder.startedAt);
    const minutes = Math.round((Date.now() - started.getTime()) / 60_000);
    super(
      `Another Sift run is already using this database (process ${holder.pid}, started ${
        minutes < 1 ? 'less than a minute' : `${minutes} minute${minutes === 1 ? '' : 's'}`
      } ago). Wait for it to finish, or stop it first. Lock: ${path}`,
    );
    this.name = 'LockedError';
  }
}

export function lockPathFor(databasePath: string): string {
  return `${databasePath}.lock`;
}

/** Is a process still alive? Signal 0 checks without delivering anything. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else -- still running.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      host: String(parsed.host ?? ''),
      startedAt: String(parsed.startedAt ?? new Date().toISOString()),
      command: String(parsed.command ?? 'unknown'),
    };
  } catch {
    return null; // An unreadable lock is treated as stale rather than fatal.
  }
}

/**
 * Take the lock, or throw LockedError describing who holds it.
 *
 * Returns a release function. Releasing twice is safe, so callers can release
 * explicitly and still register it as an exit handler.
 */
export function acquireLock(databasePath: string, command = 'pipeline'): () => void {
  // Tests and dry inspection run against an in-memory database, which no other
  // process can contend for.
  if (databasePath === ':memory:') return () => {};

  const path = lockPathFor(databasePath);
  mkdirSync(dirname(resolve(path)), { recursive: true });

  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    command,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' fails when the file exists, which is what makes this atomic.
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          // Only remove a lock still describing this process, so a release
          // arriving late cannot delete someone else's.
          const current = readLock(path);
          if (!current || current.pid === process.pid) rmSync(path, { force: true });
        } catch {
          // Failing to clean up must not mask the real outcome of the run.
        }
      };

      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
          release();
          process.exit(signal === 'SIGINT' ? 130 : 143);
        });
      }
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readLock(path);
      if (holder && isRunning(holder.pid)) throw new LockedError(holder, path);
      // The holder is gone: a crash or a kill -9. Clear it and try once more.
      log.warn(`removing a stale lock left by process ${holder?.pid ?? 'unknown'}`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the run lock at ${lockPathFor(databasePath)}.`);
}

/** Run `fn` holding the lock, releasing it however the call ends. */
export async function withLock<T>(
  databasePath: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = acquireLock(databasePath, command);
  try {
    return await fn();
  } finally {
    release();
  }
}
