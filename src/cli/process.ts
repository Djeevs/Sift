import { main } from './_bootstrap.js';
import { runPipeline } from '../pipeline/run.js';

/**
 * Everything except ingestion: embed, triage, cluster, extract, score, route.
 *
 *   npm run process
 *   npm run process -- --max-deep 10
 */
await main(async ({ db, config }, args) => {
  const result = await runPipeline(db, config, {
    skipIngest: true,
    maxDeep: typeof args['max-deep'] === 'string' ? Number(args['max-deep']) : undefined,
  });
  console.log('');
  for (const [stage, stats] of Object.entries(result)) {
    if (stage === 'spendUsd') continue;
    console.log(`${stage}: ${JSON.stringify(stats)}`);
  }
  console.log(`estimated spend: $${result.spendUsd.toFixed(4)}`);
});
