import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { profileDirectory } from '../onboarding/index.js';
import { discoverProfileSources } from '../onboarding/sourceDiscovery.js';

loadEnvFile();
const args = parseArgs();
if (typeof args.profile !== 'string') throw new Error('Missing --profile YOUR_NAME');
const directory = profileDirectory(args.profile);
const results = await discoverProfileSources(directory);

console.log(`Source discovery for ${args.profile}`);
for (const result of results) {
  console.log(`\n${result.status.toUpperCase()}  ${result.candidate.name}${result.candidate.domain ? ` (${result.candidate.domain})` : ''}`);
  for (const feed of result.feeds) {
    console.log(`  ${feed.kind.padEnd(4)} ${String(feed.item_count).padStart(3)} items  ${feed.feed_url}`);
  }
  for (const note of result.notes) console.log(`  note: ${note}`);
}
console.log(`\nReport saved: ${directory}/source-discovery.json`);
console.log('Nothing was added to sources.yaml. Review and approve validated feeds before configuration changes.');
