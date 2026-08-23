/**
 * Spend, and what it is currently buying. The one place to look before asking
 * "why did so little reach Terra this week?"
 */
import { loadConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { budgetState, terraPathCost, observedTerraCostPerCall, monthToDateSpend } from '../pipeline/budget.js';
import { freeStageReport, lunaStageReport, breakdowns, measurementReadiness } from '../pipeline/falseNegatives.js';
import { loadEnvFile } from './_bootstrap.js';

loadEnvFile();
const config = loadConfig();
const db = initDb(config.env.dbPath);
const state = budgetState(db, config);

const money = (n: number) => `$${n.toFixed(4)}`;

console.log(`=== budget (${state.monthKey}, mode: ${config.modeName}) ===`);
console.log(`  month-to-date Luna      ${money(state.lunaUsd)}`);
console.log(`  month-to-date Terra     ${money(state.terraUsd)}`);
console.log(`  month-to-date total     ${money(state.spentUsd)}`);
console.log(`  projected month-end     ${money(state.projectedMonthEndUsd)}  (day ${state.daysElapsed} of ${state.daysInMonth})`);
console.log(`  target                  $${state.targetUsd.toFixed(2)}`);
console.log(`  hard limit              $${state.hardLimitUsd.toFixed(2)}`);
console.log(`  remaining to target     ${money(state.remainingToTargetUsd)}`);
console.log(`  degradation stage       ${state.stage}`);
console.log(`  min opportunity to buy a Terra call: ${state.minOpportunity.toFixed(2)}`);
if (state.hardLimitReached) {
  console.log(`  HARD LIMIT REACHED -- Terra reserved for: ${state.reservedFor.join(', ')}`);
}

console.log(`\n=== Terra unit economics ===`);
const path = terraPathCost(db, config);
console.log(`  measured cost per call  ${money(observedTerraCostPerCall(db, config))}`);
console.log(`  sync, uncached          ${money(path.syncUncached)}`);
console.log(`  sync, prefix cached     ${money(path.syncCached)}`);
console.log(`  batch (50% off)         ${money(path.batch)}`);
console.log(`  cheapest path: ${path.cheapest} -- ${path.note}`);

console.log(`\n=== Terra allocation (most recent run) ===`);
const latest = db.get<{ ts: number }>(`SELECT MAX(created_at) AS ts FROM terra_allocation_decisions`, {});
if (!latest?.ts) {
  console.log('  no allocation decisions recorded yet');
} else {
  const rows = db.all<{
    title: string; opportunity: number; selected: number; is_audit: number;
    feed_need: number; reason: string;
  }>(
    `SELECT fi.title, a.opportunity, a.selected, a.is_audit, a.feed_need, a.reason
     FROM terra_allocation_decisions a JOIN feed_items fi ON fi.id = a.item_id
     WHERE a.created_at = :ts ORDER BY a.opportunity DESC`,
    { ts: latest.ts },
  );
  const chosen = rows.filter((r) => r.selected === 1);
  console.log(`  ${chosen.length} selected of ${rows.length} scored (${chosen.filter((r) => r.is_audit).length} audits)`);
  console.log('\n  highest opportunity:');
  for (const r of rows.slice(0, 6)) {
    console.log(`    ${r.selected ? 'BUY ' : 'skip'} ${r.opportunity.toFixed(3)} ${r.title.slice(0, 54)}`);
    console.log(`         ${r.reason.slice(0, 110)}`);
  }
  const skipped = rows.filter((r) => r.selected === 0);
  if (skipped.length > 0) {
    console.log(`\n  highest-opportunity items NOT bought (${skipped.length} total):`);
    for (const r of skipped.slice(0, 4)) {
      console.log(`    ${r.opportunity.toFixed(3)} ${r.title.slice(0, 54)}`);
      console.log(`         ${r.reason.slice(0, 110)}`);
    }
  }
}

console.log(`\n=== false negatives ===`);
const readiness = measurementReadiness(db, config);
console.log(`  measurement ready: ${readiness.ready ? 'YES' : 'NO'} -- ${readiness.note}`);

const free = freeStageReport(db);
console.log(`\n  free -> Luna boundary`);
console.log(`    sampled                ${free.sampled} (${free.resolved} resolved)`);
console.log(`    Luna would KEEP        ${free.lunaKeep}`);
console.log(`    Luna UNCERTAIN         ${free.lunaUncertain}`);
console.log(`    Luna DROP (agreed)     ${free.lunaDrop}`);
console.log(`    reached Terra          ${free.reachedTerra}`);
console.log(`    Terra rated high       ${free.terraHigh}`);
console.log(`    would have published   ${free.wouldHavePublished}`);
console.log(`    false-negative rate    ${free.falseNegativeRate === null ? 'n/a' : (free.falseNegativeRate * 100).toFixed(1) + '%'}`);

const luna = lunaStageReport(db);
console.log(`\n  Luna -> Terra boundary`);
console.log(`    sampled                ${luna.sampled} (${luna.resolved} resolved)`);
console.log(`    median Terra score     ${luna.medianTerraScore === null ? 'n/a' : luna.medianTerraScore.toFixed(3)}`);
console.log(`    Terra rated high       ${luna.terraHigh}`);
console.log(`    would have published   ${luna.wouldHavePublished}`);
console.log(`    false-negative rate    ${luna.falseNegativeRate === null ? 'n/a' : (luna.falseNegativeRate * 100).toFixed(1) + '%'}`);

if (process.argv.includes('--breakdown')) {
  console.log(`\n=== what kinds of things are being dropped ===`);
  for (const b of breakdowns(db, config)) {
    const rows = b.rows.filter((r) => r.sampled >= 2).slice(0, 6);
    if (rows.length === 0) continue;
    console.log(`\n  by ${b.dimension}`);
    for (const r of rows) {
      const rate = r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(0)}%`;
      console.log(`    ${String(r.key).slice(0, 28).padEnd(30)} ${String(r.misses).padStart(3)}/${String(r.sampled).padEnd(3)} misses  ${rate}`);
    }
  }
} else {
  console.log('\n(run with --breakdown to see false negatives by source, category, length and more)');
}
