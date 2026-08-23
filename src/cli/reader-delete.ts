/**
 * Remove a reader.
 *
 *   npm run reader:delete -- --profile alice          # says what it would do
 *   npm run reader:delete -- --profile alice --yes    # does it
 *
 * Nothing is erased: the reader's directory and database are moved into
 * data/deleted/ and the path is printed. Emptying that folder is a separate,
 * deliberate act.
 */
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { resolveHome } from '../config/index.js';
import { deleteReader, listReaders } from '../onboarding/deleteReader.js';
import { profileDirectory } from '../onboarding/index.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile();
const args = parseArgs();
const home = resolveHome();
const id = typeof args.profile === 'string' ? args.profile.trim().toLowerCase() : '';

if (!id) {
  const readers = listReaders(home);
  console.log('Missing --profile YOUR_READER');
  console.log(readers.length > 0 ? `\nReaders: ${readers.join(', ')}` : '\nThere are no readers yet.');
  process.exit(1);
}

if (!existsSync(profileDirectory(id, home)) && !existsSync(resolve(home, 'data', 'profiles', `${id}.db`))) {
  console.log(`No reader named “${id}”.`);
  console.log(`Readers: ${listReaders(home).join(', ') || '(none)'}`);
  process.exit(1);
}

// Deleting is a decision, so the default is to describe rather than act.
if (args.yes !== true) {
  console.log(`This would remove the reader “${id}”:`);
  console.log(`  ${profileDirectory(id, home)}`);
  console.log(`  ${resolve(home, 'data', 'profiles', `${id}.db`)}`);
  console.log('');
  console.log('Both are moved into data/deleted/, not erased.');
  console.log('Feeds already pushed to Cloudflare keep being served until you remove them there.');
  console.log('');
  console.log(`Run again with --yes to go ahead:  npm run reader:delete -- --profile ${id} --yes`);
  process.exit(0);
}

const result = deleteReader(id, { home });
console.log(`Removed reader “${result.id}”.`);
console.log(`  moved to ${result.archivePath}`);
if (!result.movedDatabase) console.log('  (no database existed)');
console.log('');
console.log('Delete that folder yourself when you are sure. If this reader was published');
console.log('to Cloudflare, its feeds keep being served until you remove the KV keys.');
