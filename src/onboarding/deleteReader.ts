/**
 * Removing a reader.
 *
 * The only destructive thing the dashboard can do, so it is deliberately the
 * most conservative code here.
 *
 * Nothing is erased. A reader's directory and database are *moved* into
 * `data/deleted/<id>-<timestamp>/`, and the caller is told where they went.
 * That directory holds a feed token and a private database, so "delete" that
 * meant `rm -rf` would be both irreversible and the one mistake a reader could
 * make in two clicks. Emptying the folder afterwards is a deliberate act, taken
 * by someone who has already seen the path.
 *
 * What this cannot undo is stated rather than implied: feeds already pushed to
 * Cloudflare keep being served from KV until they are removed there, which is a
 * terminal operation on purpose.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveHome } from '../config/index.js';
import { profileDirectory, validateProfileId } from './index.js';

export interface DeletedReader {
  id: string;
  /** Where the reader's files were moved. Empty if there were none. */
  archivePath: string | null;
  movedProfile: boolean;
  movedDatabase: boolean;
}

/** Readers that exist right now, excluding the shipped example. */
export function listReaders(home = resolveHome()): string[] {
  const root = resolve(home, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'example')
    .filter((entry) => existsSync(resolve(root, entry.name, 'taste-profile.yaml')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Move one reader's files out of the way.
 *
 * `example` is refused explicitly: it ships with the code, it is the template a
 * new reader is built from, and nothing that walks a directory listing should
 * be able to remove it.
 */
export function deleteReader(
  profileId: string,
  options: { home?: string; now?: Date } = {},
): DeletedReader {
  const home = options.home ?? resolveHome();
  // Throws on anything that could escape the profiles directory.
  const id = validateProfileId(profileId);
  if (id === 'example') throw new Error('The example reader ships with Sift and cannot be deleted.');

  const directory = profileDirectory(id, home);
  const databasePath = resolve(home, 'data', 'profiles', `${id}.db`);
  if (!existsSync(directory) && !existsSync(databasePath)) {
    throw new Error(`No reader named “${id}”.`);
  }

  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath = resolve(home, 'data', 'deleted', `${id}-${stamp}`);
  mkdirSync(archivePath, { recursive: true });

  const result: DeletedReader = { id, archivePath, movedProfile: false, movedDatabase: false };

  if (existsSync(directory)) {
    move(directory, resolve(archivePath, 'profile'));
    result.movedProfile = true;
  }
  // SQLite's write-ahead log and shared-memory files are part of the database.
  // Leaving them behind would strand fragments of a reader's content on disk.
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${databasePath}${suffix}`;
    if (!existsSync(from)) continue;
    move(from, resolve(archivePath, `${id}.db${suffix}`));
    if (suffix === '') result.movedDatabase = true;
  }

  return result;
}

/** rename() first; fall back to copy-then-remove across filesystems. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}
