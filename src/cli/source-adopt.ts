/**
 * Adopt assistant-suggested sources from the terminal.
 *
 * The web UI grew a review screen for this first, which made it the only way to
 * do it — a reader who lives in a terminal had to hand-write YAML for something
 * the product does for everyone else. Every capability should exist here first;
 * the web UI is a face over the same commands, not a superset of them.
 *
 *   npm run sources:adopt -- --profile alice            # list what is on offer
 *   npm run sources:adopt -- --profile alice --all      # take everything offered
 *   npm run sources:adopt -- --profile alice --add 404media,aftermath
 */
import { loadConfig } from '../config/index.js';
import { loadEnvFile, list, parseArgs } from './_bootstrap.js';
import { profileDirectory } from '../onboarding/index.js';
import { adoptSources, adoptableSources } from '../onboarding/adoptSources.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile();
const args = parseArgs();
if (typeof args.profile !== 'string') throw new Error('Missing --profile YOUR_NAME');
const directory = profileDirectory(args.profile);

const reportPath = resolve(directory, 'source-discovery.json');
if (!existsSync(reportPath)) {
  console.log(`No discovery report for ${args.profile}.`);
  console.log(`Run:  npm run sources:discover -- --profile ${args.profile}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { results?: Parameters<typeof adoptableSources>[0] };
const config = loadConfig({ configDir: directory, reload: true });
const offered = adoptableSources(report.results ?? [], config);
const available = offered.filter((source) => !source.alreadyConfigured);

if (offered.length === 0) {
  console.log('Nothing to adopt. Candidates your assistant marked "avoid", and any whose feed could not be validated, are never offered.');
  process.exit(0);
}

const requested = list(args.add);
const takeAll = args.all === true;

// Without --all or --add this only reports, so the command is safe to explore
// with. Adoption is an explicit act in both surfaces.
if (!takeAll && !requested) {
  console.log(`Suggested sources for ${args.profile}\n`);
  for (const source of available) {
    console.log(`  ${source.id.padEnd(20)} ${source.name}`);
    console.log(`  ${' '.repeat(20)} ${source.feedUrl}`);
    console.log(`  ${' '.repeat(20)} lanes: ${source.lanes.join(', ')}`);
    console.log(`  ${' '.repeat(20)} ${source.disposition.replaceAll('_', ' ')} · ${source.role.replaceAll('_', ' ')} · prior ${source.qualityPrior}, volume ${source.volumeBudget}`);
    console.log(`  ${' '.repeat(20)} ${source.reason}`);
    for (const caveat of source.caveats) console.log(`  ${' '.repeat(20)} caution: ${caveat}`);
    console.log('');
  }
  const already = offered.filter((source) => source.alreadyConfigured);
  if (already.length > 0) console.log(`Already followed: ${already.map((source) => source.name).join(', ')}\n`);
  if (available.length === 0) console.log('Everything suggested is already in your sources.\n');
  else {
    console.log(`Adopt all:      npm run sources:adopt -- --profile ${args.profile} --all`);
    console.log(`Adopt some:     npm run sources:adopt -- --profile ${args.profile} --add ${available.slice(0, 2).map((source) => source.id).join(',')}`);
  }
  process.exit(0);
}

const chosen = takeAll
  ? available
  : available.filter((source) => requested!.includes(source.id));

const unknown = takeAll ? [] : requested!.filter((id) => !available.some((source) => source.id === id));
for (const id of unknown) console.log(`Skipped "${id}": not an available suggestion. Run without --add to see the list.`);

if (chosen.length === 0) {
  console.log('Nothing adopted.');
  process.exit(unknown.length > 0 ? 1 : 0);
}

const outcome = adoptSources(directory, config, chosen);
for (const id of outcome.added) console.log(`Added ${id}`);
for (const skip of outcome.skipped) console.log(`Skipped ${skip.id}: ${skip.reason}`);
console.log(`\nWritten to ${outcome.path}`);
console.log('config/sources.yaml was not modified. Delete an entry from that file to stop following a source.');
