/**
 * Where Sift keeps its state, and how to move it.
 *
 *   npm run home                       # show what resolves where
 *   npm run home -- --move ~/Sift-data # copy state there, then print next steps
 *
 * PROJECT_ROOT holds what Sift reads: config defaults, prompts, the schema.
 * SIFT_HOME holds what it writes: databases, readers, tokens, logs. They are
 * the same directory in a checkout, and must be separable for a packaged
 * application, whose bundle is read-only and is replaced wholesale on update.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, resolveHome, resolveDbPath } from '../config/index.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';

loadEnvFile();
const args = parseArgs();
const home = resolveHome();

function readers(root: string): string[] {
  const dir = resolve(root, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'example')
    .map((entry) => entry.name)
    .sort();
}

const target = typeof args.move === 'string' ? resolve(args.move.replace(/^~/, process.env.HOME ?? '~')) : null;

if (!target) {
  console.log('Reads from (bundled with the code):');
  console.log(`  ${PROJECT_ROOT}`);
  console.log('');
  console.log(`Writes to${process.env.SIFT_HOME ? ' (SIFT_HOME)' : ' (default: same as above)'}:`);
  console.log(`  ${home}`);
  console.log('');
  // SIFT_DB_PATH outranks SIFT_HOME, correctly — an explicit path is explicit.
  // Saying so matters: printing a database path under a "Writes to SIFT_HOME"
  // heading when SIFT_HOME did not choose it is how you lose an afternoon.
  const dbPath = resolveDbPath();
  const overridden = Boolean(process.env.SIFT_DB_PATH?.trim());
  console.log(`  database  ${dbPath}${overridden ? '   <- set by SIFT_DB_PATH, not SIFT_HOME' : ''}`);
  console.log(`  readers   ${readers(home).join(', ') || '(none yet)'}`);
  console.log(`  logs      ${resolve(home, 'data', 'logs')}`);
  if (overridden && !dbPath.startsWith(home)) {
    console.log('');
    console.log('SIFT_DB_PATH points outside SIFT_HOME. That is allowed, but moving');
    console.log('SIFT_HOME will not move the database. Clear SIFT_DB_PATH to let');
    console.log('SIFT_HOME decide, or set both deliberately.');
  }
  if (home === PROJECT_ROOT) {
    console.log('');
    console.log('State lives inside the checkout. That is fine for a checkout, but a');
    console.log('packaged app must keep it elsewhere so an update cannot delete it.');
    console.log('Move it with:  npm run home -- --move ~/Library/Application\\ Support/Sift');
  }
  process.exit(0);
}

if (target === home) throw new Error('That is already where Sift keeps its state.');

// Copied, never moved. Feed tokens and databases are not things to relocate
// with a rename and hope: the original stays put until the reader deletes it.
let copied = 0;
for (const name of ['data', 'profiles']) {
  const from = resolve(home, name);
  if (!existsSync(from)) continue;
  const to = resolve(target, name);
  if (existsSync(to) && readdirSync(to).length > 0) {
    throw new Error(`${to} already exists and is not empty. Refusing to merge two sets of state.`);
  }
  mkdirSync(target, { recursive: true });
  // The example profile is a shipped asset, not state; it stays with the code.
  cpSync(from, to, { recursive: true, filter: (src) => !src.includes(`${resolve(home, 'profiles', 'example')}`) });
  copied += 1;
  console.log(`Copied ${from}`);
  console.log(`    to ${to}`);
}

if (copied === 0) {
  console.log('Nothing to copy: no data or profiles directory exists yet.');
  console.log(`Set SIFT_HOME=${target} and Sift will create them there.`);
  process.exit(0);
}

console.log('');
console.log('Nothing was deleted. To start using the copy, set:');
console.log(`  SIFT_HOME=${target}`);
console.log('');
console.log('Add it to .env, or export it before running Sift. Verify with `npm run home`,');
console.log('check your readers are listed, then delete the originals yourself.');
