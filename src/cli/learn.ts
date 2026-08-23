import { main, printTable } from './_bootstrap.js';
import { applyLearning, collectSignals, learnedWeights } from '../learn/index.js';
import { startJob } from '../pipeline/journal.js';

/**
 * Apply one slow learning round from stored feedback.
 *
 *   npm run learn
 *   npm run learn -- --dry     (show what would change, change nothing)
 */
await main(async ({ db, config }, args) => {
  if (args.dry) {
    const signals = collectSignals(db, config);
    console.log(`${signals.length} items carry a feedback signal`);
    printTable(
      signals.slice(0, 30).map((s) => ({
        source: s.sourceId,
        category: s.category ?? '-',
        anchor: s.bestAnchorId ?? '-',
        value: s.value.toFixed(2),
        signals: s.kinds.join('+'),
      })),
    );
    const ignored = signals.filter((s) => s.kinds.includes('open_ignored_ragebait'));
    if (ignored.length) {
      console.log('');
      console.log(`${ignored.length} opens were ignored because the item scored high on ragebait.`);
    }
    return;
  }

  const job = startJob(db, 'learn');
  try {
    const stats = applyLearning(db, config);
    job.finish({ signals: stats.signals, updated: stats.updated.length });

    console.log(`${stats.signals} signals considered`);
    if (stats.updated.length) {
      console.log('');
      console.log('adjusted weights:');
      printTable(
        stats.updated.map((u) => ({
          scope: u.scope,
          key: u.key,
          from: u.from.toFixed(4),
          to: u.to.toFixed(4),
          events: u.events,
        })),
      );
    } else {
      console.log('nothing changed (not enough evidence yet)');
    }

    if (stats.skipped.length) {
      console.log('');
      console.log('held back:');
      for (const s of stats.skipped.slice(0, 15)) console.log(`  ${s.scope}/${s.key}: ${s.reason}`);
    }

    const current = learnedWeights(db);
    if (current.length) {
      console.log('');
      console.log('current learned weights:');
      printTable(current.map((w) => ({ ...w, value: w.value.toFixed(4) })));
    }
  } catch (err) {
    job.fail(err);
    throw err;
  }
});
