import { main, printTable } from './_bootstrap.js';
import { auditSummary } from '../pipeline/diagnostics.js';
import { AiClient } from '../ai/client.js';
import { runDeepEvaluation } from '../ai/deepEval.js';
import { extractForItems } from '../extract/index.js';
import { startJob } from '../pipeline/journal.js';

/**
 * The false-negative audit (§20).
 *
 *   npm run audit                 show what the audit sample has found so far
 *   npm run audit -- --run 20     deep-evaluate 20 more cheap-stage rejects now
 */
await main(async ({ db, config }, args) => {
  if (args.run) {
    const count = typeof args.run === 'string' ? Number(args.run) : 10;
    const job = startJob(db, 'audit');
    const ai = new AiClient(config, db, job.id);
    try {
      // Rejects that have not already been audited, sampled across sources so
      // one noisy feed cannot dominate the estimate.
      const rows = db.all<{ id: string }>(
        `SELECT fi.id FROM feed_items fi
         JOIN cheap_evaluations ce ON ce.item_id = fi.id
         WHERE ce.passed = 0
           AND NOT EXISTS (SELECT 1 FROM deep_evaluations de WHERE de.item_id = fi.id)
         ORDER BY RANDOM()
         LIMIT :n`,
        { n: count },
      );
      if (rows.length === 0) {
        console.log('no un-audited rejects available');
        job.finish({ audited: 0 });
        return;
      }

      const ids = rows.map((r) => r.id);
      db.run(
        `UPDATE cheap_evaluations SET is_audit_sample = 1
         WHERE item_id IN (${ids.map((_, i) => `:id${i}`).join(',')})`,
        Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
      );

      await extractForItems(db, config, ids);
      const stats = await runDeepEvaluation(db, ai, config, ids);
      job.finish({ ...stats, spendUsd: Number(ai.spentUsd.toFixed(5)) });
      console.log(`deep-evaluated ${stats.evaluated} rejects ($${ai.spentUsd.toFixed(4)})`);
    } catch (err) {
      job.fail(err);
      throw err;
    }
  }

  const summary = auditSummary(db, config);
  console.log('');
  console.log('=== cheap-stage false-negative audit ===');
  console.log(`${summary.total} rejected items have been deep-evaluated.`);
  if (summary.total > 0) {
    const rate = (summary.wouldHavePublished / summary.total) * 100;
    console.log(`${summary.wouldHavePublished} would have qualified for a feed (${rate.toFixed(1)}%).`);
    console.log('');
    console.log('If this number is high, lower `triage.threshold` in ranking-config.yaml.');
    console.log('');
    printTable(
      summary.examples.map((e) => ({
        score: e.score.toFixed(2),
        source: e.source_id,
        title: e.title.slice(0, 60),
        why: (e.why ?? '').slice(0, 60),
      })),
    );
  }
});
