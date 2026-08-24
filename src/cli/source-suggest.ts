/**
 * Ask Sift to propose sources from the reader's profile.
 *
 *   npm run sources:suggest -- --profile alice
 *   npm run sources:suggest -- --profile alice --max 20
 *
 * Proposals are written into the reader's candidate list. Nothing is followed
 * until the feed is validated and the reader approves it:
 *
 *   npm run sources:discover -- --profile alice     # check each one publishes a feed
 *   npm run sources:adopt    -- --profile alice     # review and follow
 */
import { AiClient } from '../ai/client.js';
import { loadConfig } from '../config/index.js';
import { profileDirectory } from '../onboarding/index.js';
import { suggestSources } from '../onboarding/suggestSources.js';
import { main } from './_bootstrap.js';

await main(async ({ db }, args) => {
  if (typeof args.profile !== 'string') throw new Error('Missing --profile YOUR_NAME');
  const directory = profileDirectory(args.profile);
  const config = loadConfig({ configDir: directory, reload: true });
  const ai = new AiClient(config, db);

  if (ai.dryRun) {
    console.log('No AI provider is configured, so there is nothing to ask.');
    console.log('Connect one in the dashboard, or set SIFT_DRY_RUN=0 with a key present.');
    return;
  }

  const max = typeof args.max === 'string' ? Number(args.max) : 12;
  if (!Number.isInteger(max) || max < 1 || max > 40) throw new Error('--max must be a whole number from 1 to 40.');

  console.log(`Asking ${ai.modelFor('deep')} for sources that suit ${args.profile}…`);
  const result = await suggestSources(db, ai, config, directory, { maxCandidates: max });

  if (result.usedObserved > 0) {
    console.log(`Grounded in ${result.usedObserved} domain(s) Sift has already watched perform.`);
  } else {
    console.log('No reading history yet, so these come from the reader profile alone.');
  }
  console.log('');

  for (const proposal of result.proposals) {
    console.log(`  ${proposal.name}  (${proposal.domain})  [${proposal.sourceType}]`);
    console.log(`    ${proposal.disposition.replaceAll('_', ' ')} · confidence ${proposal.confidence.toFixed(2)} · basis: ${proposal.basis.join(', ') || 'unstated'}`);
    // Per lane, because that is the judgement v2 actually makes.
    for (const lane of proposal.lanes) {
      console.log(`    ${lane.lane.padEnd(9)} fit ${lane.fit.toFixed(2)} · ${lane.role.replaceAll('_', ' ')}`);
      console.log(`      ${lane.reason}`);
    }
    if (proposal.incrementalValue) console.log(`    adds: ${proposal.incrementalValue}`);
    if (proposal.expectedYield) console.log(`    yield: ${proposal.expectedYield}`);
    for (const caveat of proposal.caveats) console.log(`    caution: ${caveat}`);
    console.log('');
  }

  if (result.proposals.length === 0) console.log('  Nothing new proposed — everything suggested is already followed.\n');
  if (result.skippedExisting > 0) console.log(`(${result.skippedExisting} proposal(s) dropped: already followed.)`);
  console.log(`Cost: $${result.spendUsd.toFixed(4)}`);
  console.log('');
  console.log('Nothing has been followed yet. Next:');
  console.log(`  npm run sources:discover -- --profile ${args.profile}`);
  console.log(`  npm run sources:adopt    -- --profile ${args.profile}`);
});
