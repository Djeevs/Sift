import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockedError, acquireLock, lockPathFor, withLock } from '../src/util/lock.js';

function dbPath(): string {
  return resolve(mkdtempSync(resolve(tmpdir(), 'sift-lock-')), 'sift.db');
}

/**
 * Concurrent pipeline runs against one database both pay for the same Terra
 * evaluations, so the failure is a doubled bill rather than a crash. Four
 * things can start a run — dashboard, scheduler, terminal, cron — and until
 * this existed nothing stopped two of them overlapping.
 */
describe('run lock', () => {
  it('lets one holder in and keeps the next out', () => {
    const path = dbPath();
    const release = acquireLock(path);
    expect(existsSync(lockPathFor(path))).toBe(true);
    expect(() => acquireLock(path)).toThrow(LockedError);
    release();
    // Released, so the next run gets straight in.
    acquireLock(path)();
  });

  it('names the holder and how long it has been going', () => {
    const path = dbPath();
    const release = acquireLock(path);
    try {
      acquireLock(path);
    } catch (error) {
      expect(error).toBeInstanceOf(LockedError);
      expect((error as LockedError).message).toContain(String(process.pid));
      expect((error as LockedError).message).toContain('already using this database');
    } finally {
      release();
    }
  });

  /**
   * A lock left by a crash must not wedge the pipeline permanently — that would
   * be worse than the problem it solves. A dead pid means the lock is stale.
   */
  it('takes over a lock whose owner is gone', () => {
    const path = dbPath();
    writeFileSync(lockPathFor(path), JSON.stringify({
      pid: 999_999_999, host: 'old', startedAt: new Date().toISOString(), command: 'pipeline',
    }));
    const release = acquireLock(path);
    expect(JSON.parse(readFileSync(lockPathFor(path), 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('treats an unreadable lock as stale rather than fatal', () => {
    const path = dbPath();
    writeFileSync(lockPathFor(path), 'not json at all');
    acquireLock(path)();
  });

  it('releases when the guarded work throws', async () => {
    const path = dbPath();
    await expect(withLock(path, 'pipeline', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lockPathFor(path))).toBe(false);
    acquireLock(path)();
  });

  it('releasing twice is safe', () => {
    const path = dbPath();
    const release = acquireLock(path);
    release();
    release();
    expect(existsSync(lockPathFor(path))).toBe(false);
  });

  // Tests and dry inspection share no file, so there is nothing to contend for.
  it('does not lock an in-memory database', () => {
    acquireLock(':memory:')();
    acquireLock(':memory:')();
  });
});
