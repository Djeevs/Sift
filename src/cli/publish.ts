import { main, printTable } from './_bootstrap.js';
import { routeAndPublish } from '../route/index.js';
import { resolveAlternateFormats, suppressDuplicateEpisodes } from '../alternate/index.js';
import { feedStats } from '../pipeline/diagnostics.js';
import { startJob } from '../pipeline/journal.js';

/**
 * Route already-evaluated items into feeds and resolve alternate formats.
 * Safe to rerun: published items are never republished.
 */
await main(async ({ db, config }) => {
  const job = startJob(db, 'publish');
  try {
    const route = routeAndPublish(db, config);
    const alternate = resolveAlternateFormats(db, config, config.models.models.embeddings.model);
    const suppressed = suppressDuplicateEpisodes(db);
    job.finish({ route: { ...route }, alternate: { ...alternate }, suppressed });

    console.log('');
    printTable(feedStats(db, config));
    console.log('');
    console.log(`published ${route.published} placements; ${alternate.matchesFound} alternate formats found`);
    if (Object.keys(route.skipped).length) {
      console.log('not published because:');
      for (const [reason, count] of Object.entries(route.skipped).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`  ${count}x ${reason}`);
      }
    }
  } catch (err) {
    job.fail(err);
    throw err;
  }
});
