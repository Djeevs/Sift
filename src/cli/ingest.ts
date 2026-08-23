import { main, list } from './_bootstrap.js';
import { ingestAll } from '../ingest/index.js';
import { hardFilterPending } from '../filter/hardFilter.js';
import { startJob } from '../pipeline/journal.js';
import { printTable } from './_bootstrap.js';

/**
 * Fetch feeds and apply hard filters. No model calls, so this is free to run.
 *
 *   npm run ingest
 *   npm run ingest -- --sources quanta,aftermath
 */
await main(async ({ db, config }, args) => {
  const job = startJob(db, 'ingest');
  try {
    const stats = await ingestAll(db, config, { sourceIds: list(args.sources) });
    const filtered = hardFilterPending(db, config);
    job.finish({ ...stats, filtered: { ...filtered } });

    console.log('');
    printTable([stats]);
    console.log('');
    console.log(`hard filter: ${filtered.kept} kept, ${filtered.dropped} dropped (${filtered.thin} thin)`);
    if (Object.keys(filtered.byReason).length) {
      console.log('drop reasons:');
      for (const [reason, count] of Object.entries(filtered.byReason).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${count}x ${reason}`);
      }
    }
  } catch (err) {
    job.fail(err);
    throw err;
  }
});
