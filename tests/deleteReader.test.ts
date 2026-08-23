import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteReader, listReaders } from '../src/onboarding/deleteReader.js';

function home(readers: string[] = ['alice']): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sift-del-'));
  for (const id of [...readers, 'example']) {
    mkdirSync(resolve(root, 'profiles', id), { recursive: true });
    writeFileSync(resolve(root, 'profiles', id, 'taste-profile.yaml'), 'version: 2\n');
    writeFileSync(resolve(root, 'profiles', id, '.env'), 'SIFT_ACCESS_TOKEN="secret"\n');
  }
  mkdirSync(resolve(root, 'data', 'profiles'), { recursive: true });
  for (const id of readers) {
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(resolve(root, 'data', 'profiles', `${id}.db${suffix}`), 'x');
  }
  return root;
}

/**
 * The only destructive thing the dashboard can do. A reader's directory holds a
 * feed key and its database holds everything they have read, so "delete" moves
 * rather than erases: emptying data/deleted/ is a separate, deliberate act by
 * someone who has already seen the path.
 */
describe('removing a reader', () => {
  it('moves the profile and database instead of erasing them', () => {
    const root = home();
    const result = deleteReader('alice', { home: root });
    expect(existsSync(resolve(root, 'profiles', 'alice'))).toBe(false);
    expect(existsSync(resolve(root, 'data', 'profiles', 'alice.db'))).toBe(false);
    expect(existsSync(resolve(result.archivePath!, 'profile', 'taste-profile.yaml'))).toBe(true);
    expect(existsSync(resolve(result.archivePath!, 'alice.db'))).toBe(true);
  });

  // SQLite keeps content in the write-ahead log; leaving it behind would strand
  // fragments of a reader's articles on disk after they asked for removal.
  it('takes the write-ahead log and shared-memory files too', () => {
    const root = home();
    const result = deleteReader('alice', { home: root });
    expect(readdirSync(result.archivePath!).sort()).toContain('alice.db-wal');
    expect(readdirSync(result.archivePath!).sort()).toContain('alice.db-shm');
    expect(readdirSync(resolve(root, 'data', 'profiles'))).toHaveLength(0);
  });

  it('leaves every other reader alone', () => {
    const root = home(['alice', 'bob']);
    deleteReader('alice', { home: root });
    expect(listReaders(root)).toEqual(['bob']);
    expect(existsSync(resolve(root, 'profiles', 'bob', '.env'))).toBe(true);
  });

  // It ships with the code and is the template new readers are built from.
  it('refuses to delete the example reader', () => {
    const root = home();
    expect(() => deleteReader('example', { home: root })).toThrow(/cannot be deleted/);
    expect(existsSync(resolve(root, 'profiles', 'example'))).toBe(true);
  });

  it('refuses a name that would escape the profiles directory', () => {
    const root = home();
    expect(() => deleteReader('../../etc', { home: root })).toThrow();
  });

  it('refuses a reader that does not exist', () => {
    expect(() => deleteReader('nobody', { home: home() })).toThrow(/No reader named/);
  });

  it('never lists the example reader as one of yours', () => {
    expect(listReaders(home(['alice']))).toEqual(['alice']);
  });

  it('keeps two deletions of the same name apart', () => {
    const root = home();
    const first = deleteReader('alice', { home: root, now: new Date('2026-08-23T10:00:00Z') });
    mkdirSync(resolve(root, 'profiles', 'alice'), { recursive: true });
    writeFileSync(resolve(root, 'profiles', 'alice', 'taste-profile.yaml'), 'version: 2\n');
    const second = deleteReader('alice', { home: root, now: new Date('2026-08-23T11:00:00Z') });
    expect(second.archivePath).not.toBe(first.archivePath);
    expect(existsSync(first.archivePath!)).toBe(true);
  });
});
