import { main, printTable } from './_bootstrap.js';
import { funnelReport, costPerOutcome } from '../pipeline/costs.js';
import { auditReport } from '../pipeline/audit.js';

/**
 * The funnel, end to end.
 *
 *   npm run funnel
 *   npm run funnel -- --days 7
 *
 * Two things to read here. The survival rates show where the funnel is actually
 * narrowing, and the audit section estimates how often each cheap layer was
 * wrong -- which is the number that tells you whether a threshold is too tight.
 */
await main(async ({ db, config }, args) => {
  const days = typeof args.days === 'string' ? Number(args.days) : 30;

  console.log(`=== funnel (last ${days} days) ===`);
  const funnel = funnelReport(db, days);
  printTable(
    funnel.map((row) => ({
      stage: row.label,
      items: row.items,
      survived: row.survivalRate === null ? '—' : `${(row.survivalRate * 100).toFixed(1)}%`,
      api_calls: row.apiCalls || '',
      cost: row.cost > 0 ? `$${row.cost.toFixed(4)}` : '',
    })),
  );

  // The design target, so a drift is visible without doing arithmetic.
  console.log('');
  console.log('Design target for ~50 sources, per month:');
  console.log('  ~12,000 raw → ~8,000 after rules → 3,000–4,000 Luna → 1,000–1,500 Terra');
  console.log('  → 250–400 candidates → 150–250 surfaced');

  console.log('');
  console.log('=== cost per outcome ===');
  const cost = costPerOutcome(db, config, days);
  printTable([
    { metric: 'total spend', value: `$${cost.totalCost.toFixed(4)}` },
    { metric: 'Luna', value: `$${cost.lunaCost.toFixed(4)}` },
    { metric: 'Terra', value: `$${cost.terraCost.toFixed(4)}` },
    { metric: 'embeddings', value: `$${cost.embeddingCost.toFixed(4)}` },
    { metric: 'per surfaced item', value: cost.costPerSurfaced === null ? '—' : `$${cost.costPerSurfaced.toFixed(4)}` },
    { metric: 'per opened item', value: cost.costPerOpened === null ? '—' : `$${cost.costPerOpened.toFixed(4)}` },
    {
      metric: 'per explicit positive',
      value: cost.costPerPositive === null ? '—' : `$${cost.costPerPositive.toFixed(4)}`,
    },
  ]);
  console.log('');
  console.log('These are for inspection, not optimisation: a system tuned to minimise');
  console.log('cost per open would learn to prefer cheap bait.');

  console.log('');
  console.log('=== false-negative audit ===');
  const audits = auditReport(db, config);
  for (const boundary of audits) {
    const question =
      boundary.boundary === 'free_to_luna'
        ? 'How often does Luna find good items among free-ranker rejects?'
        : 'How often does Terra find excellent items among Luna rejects?';
    console.log('');
    console.log(question);
    if (boundary.resolved === 0) {
      console.log(`  ${boundary.sampled} sampled, none resolved yet.`);
      continue;
    }
    console.log(
      `  ${boundary.falseNegatives} of ${boundary.resolved} resolved samples were worth having ` +
        `(${((boundary.falseNegativeRate ?? 0) * 100).toFixed(1)}%).`,
    );
    if ((boundary.falseNegativeRate ?? 0) > 0.2) {
      const knob =
        boundary.boundary === 'free_to_luna'
          ? 'free-ranking.yaml → free_ranking.bands'
          : 'final-ranking.yaml → luna_gate.threshold';
      console.log(`  That is high. Loosen ${knob}.`);
    }
    if (boundary.examples.length) {
      printTable(
        boundary.examples.slice(0, 8).map((e) => ({
          source: e.source_id,
          title: e.title.slice(0, 50),
          band: e.band ?? '',
          free: e.free_score === null ? '' : e.free_score.toFixed(2),
          downstream: e.downstream_score === null ? '' : e.downstream_score.toFixed(2),
          result: e.audit_result ?? '',
        })),
      );
    }
  }
});
