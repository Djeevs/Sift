import { main, printTable } from './_bootstrap.js';
import { AiClient } from '../ai/client.js';
import { runClassics } from '../classics/index.js';
import { startJob } from '../pipeline/journal.js';

await main(async ({ db, config }, args) => {
  const job = startJob(db, 'classics');
  try {
    const ai = new AiClient(config, db, job.id);
    const result = await runClassics(db, config, ai, {
      forceDiscovery: args['force-discovery'] === true,
      publish: args['no-publish'] !== true,
      publishOnly: args['publish-only'] === true,
      top: typeof args.top === 'string' ? Number(args.top) : 20,
    });
    job.finish({ ...result });

    console.log('');
    console.log('=== Sift Classics ===');
    if (result.discovery) console.log(`discovery: ${JSON.stringify(result.discovery)}`);
    console.log(`eligibility: ${JSON.stringify(result.eligibility)}`);
    console.log(`evaluation: ${JSON.stringify(result.evaluation)}`);
    console.log(`publication: ${JSON.stringify(result.publication)}`);
    console.log('');
    printTable(
      result.top.map((candidate, index) => ({
        rank: index + 1,
        score: candidate.score.toFixed(3),
        read: candidate.predictedRead.toFixed(2),
        payoff: candidate.predictedPayoff.toFixed(2),
        title: candidate.title,
        author: candidate.author ?? '',
        source: candidate.source,
        published: candidate.originalPublished,
        category: candidate.category,
        discovery: candidate.discoverySources || candidate.discoverySource,
        access: candidate.accessCheck,
        why: candidate.why ?? '',
        url: candidate.canonicalUrl,
      })),
    );
  } catch (error) {
    job.fail(error);
    throw error;
  }
});
