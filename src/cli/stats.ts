import { main, printTable } from './_bootstrap.js';
import { funnelStats, sourceStats, costReport, feedStats, auditSummary } from '../pipeline/diagnostics.js';

/** The answers to every question in §20 of the brief. */
await main(async ({ db, config }, args) => {
  const days = typeof args.days === 'string' ? Number(args.days) : 7;

  console.log(`=== funnel (last ${days} days) ===`);
  for (const row of funnelStats(db, days)) {
    console.log(`${String(row.count).padStart(7)}  ${row.stage}`);
  }

  console.log('');
  console.log('=== feeds ===');
  printTable(feedStats(db, config));

  console.log('');
  console.log('=== sources (by items published) ===');
  printTable(
    sourceStats(db).map((s) => ({
      source: s.id,
      items: s.items,
      published: s.published,
      rate: s.items ? `${((s.published / s.items) * 100).toFixed(1)}%` : '-',
      excellent: s.excellent,
      not_for_me: s.notForMe,
      error: s.lastError ? s.lastError.slice(0, 30) : '',
    })),
  );

  const quiet = sourceStats(db).filter((s) => s.items >= 10 && s.published === 0);
  if (quiet.length) {
    console.log('');
    console.log('sources that have never produced a recommendation:');
    for (const s of quiet) console.log(`  ${s.id} (${s.items} items)`);
  }

  console.log('');
  console.log('=== cheap-stage audit ===');
  const audit = auditSummary(db, config);
  console.log(`${audit.total} rejected items were deep-evaluated anyway.`);
  console.log(
    `${audit.wouldHavePublished} would have been published` +
      (audit.total ? ` (estimated false-negative rate ${((audit.wouldHavePublished / audit.total) * 100).toFixed(1)}%)` : ''),
  );
  for (const ex of audit.examples.slice(0, 10)) {
    console.log(`  ${ex.score.toFixed(2)}  ${ex.source_id}: ${ex.title.slice(0, 70)}`);
  }

  console.log('');
  console.log('=== estimated spend ===');
  const cost = costReport(db, config);
  console.log(`today:        $${cost.today.toFixed(4)} (${cost.todayRequests} requests)`);
  console.log(`last 30 days: $${cost.month.toFixed(4)} (${cost.monthRequests} requests)`);
  console.log(`all time:     $${cost.total.toFixed(4)} (${cost.totalRequests} requests)`);
  if (cost.byStage.length) {
    console.log('');
    printTable(
      cost.byStage.map((s) => ({
        stage: s.stage,
        model: s.model,
        requests: s.requests,
        input_tokens: s.inputTokens,
        cached: s.cachedInputTokens,
        cache_hit: s.cacheHitRate,
        cost: `$${s.cost.toFixed(4)}`,
      })),
    );
    const chat = cost.byStage.filter((s) => s.stage !== 'embedding' && s.inputTokens > 0);
    if (chat.length && chat.every((s) => s.cachedInputTokens === 0)) {
      console.log('');
      console.log('note: no prompt-cache hits recorded yet. Expected on a run of');
      console.log('      one or two items; investigate if it persists at scale.');
    }
  }
});
