import { main, list } from './_bootstrap.js';
import { runPipeline } from '../pipeline/run.js';

/**
 * The whole pipeline, end to end. This is what cron runs.
 *
 *   npm run pipeline
 *   npm run pipeline -- --sources quanta,simon_willison
 *   npm run pipeline -- --max-deep 20 --skip-publish
 */
await main(async ({ db, config }, args) => {
  const result = await runPipeline(db, config, {
    sourceIds: list(args.sources),
    skipIngest: args['skip-ingest'] === true,
    skipPublish: args['skip-publish'] === true,
    maxDeep: typeof args['max-deep'] === 'string' ? Number(args['max-deep']) : undefined,
  });

  console.log('');
  console.log('=== pipeline summary ===');
  for (const [stage, stats] of Object.entries(result)) {
    if (stage === 'spendUsd') continue;
    console.log(`${stage}: ${JSON.stringify(stats)}`);
  }
  console.log(`estimated spend: $${result.spendUsd.toFixed(4)}`);
  console.log('');
  console.log(`Feeds: ${config.env.publicUrl}/feed/<slug>.xml  (npm run serve)`);
});
