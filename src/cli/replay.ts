/**
 * Replay the stored corpus under different budgets, without issuing model calls.
 *
 * Every item that has ever been through Luna and Terra has its scores in the
 * database. That is enough to ask the question that actually matters: at a $10
 * monthly budget, which of the recommendations I liked would I still have got?
 *
 * The point is to find the quality frontier, not the cheapest configuration. A
 * setting that halves spend and loses a third of the good items is a bad trade
 * and this is what makes that visible before it ships.
 */
import { loadConfig, type AppConfig } from '../config/index.js';
import { initDb, type Db } from '../db/index.js';
import { feedNeed, scoreOpportunity, type OpportunityInput } from '../rank/terraOpportunity.js';
import { observedTerraCostPerCall } from '../pipeline/budget.js';
import { loadEnvFile } from './_bootstrap.js';

interface ReplayItem extends OpportunityInput {
  eav: number | null;
  published: boolean;
  publishedFeeds: string[];
  title: string;
  category: string | null;
}

function loadCorpus(db: Db, config: AppConfig): ReplayItem[] {
  const rows = db.all<{
    item_id: string; source_id: string; title: string; free_score: number; triage_score: number;
    luna_action: string | null; interest_match: number; novelty: number; junk_probability: number;
    categories_json: string | null; cluster_id: string | null; perspective_distance: number;
    serendipity_candidate: number; published_at: number | null; eav: number | null;
    category: string | null; published: number; feeds: string | null;
  }>(
    `SELECT fi.id AS item_id, fi.source_id, fi.title,
            COALESCE(f.free_score, 0) AS free_score,
            COALESCE(ce.triage_score, 0) AS triage_score,
            ce.action AS luna_action,
            COALESCE(ce.interest_match, 0) AS interest_match,
            COALESCE(ce.novelty_likelihood, 0) AS novelty,
            COALESCE(ce.junk_probability, 0) AS junk_probability,
            ce.categories_json,
            fi.cluster_id,
            COALESCE(m.perspective_distance, 1) AS perspective_distance,
            COALESCE(ce.serendipity_candidate, 0) AS serendipity_candidate,
            COALESCE(fi.publication_time, fi.first_seen_at) AS published_at,
            de.expected_attention_value AS eav,
            de.category,
            CASE WHEN EXISTS (SELECT 1 FROM published_feed_items p WHERE p.item_id = fi.id) THEN 1 ELSE 0 END AS published,
            (SELECT GROUP_CONCAT(p.feed_id) FROM published_feed_items p WHERE p.item_id = fi.id) AS feeds
     FROM feed_items fi
     JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN free_score_components f ON f.item_id = fi.id
     LEFT JOIN deep_evaluations de ON de.item_id = fi.id
     LEFT JOIN story_cluster_members m ON m.item_id = fi.id AND m.cluster_id = fi.cluster_id
     WHERE ce.passed = 1`,
    {},
  );

  const priors = new Map(config.sources.map((s) => [s.id, s.quality_prior]));
  const contentTypes = new Map(config.sources.map((s) => [s.id, s.hard_rules?.content_type ?? null]));

  return rows.map((r) => {
    let categories: string[] = [];
    try {
      const parsed = JSON.parse(r.categories_json ?? '[]');
      if (Array.isArray(parsed)) categories = parsed.filter((c): c is string => typeof c === 'string');
    } catch { /* no category hint */ }
    return {
      item_id: r.item_id,
      source_id: r.source_id,
      title: r.title,
      free_score: r.free_score,
      triage_score: r.triage_score,
      luna_action: r.luna_action,
      interest_match: r.interest_match,
      novelty: r.novelty,
      junk_probability: r.junk_probability,
      quality_prior: priors.get(r.source_id) ?? 0.5,
      categories,
      cluster_id: r.cluster_id,
      perspective_distance: r.perspective_distance,
      serendipity_potential: r.serendipity_candidate
        ? Math.max(0.5, r.novelty)
        : Math.min(1, r.novelty * (1 - r.interest_match) * 2),
      content_type: contentTypes.get(r.source_id) ?? null,
      published_at: r.published_at,
      eav: r.eav,
      category: r.category,
      published: r.published === 1,
      publishedFeeds: (r.feeds ?? '').split(',').filter(Boolean),
    };
  });
}

interface Outcome {
  budget: number;
  terraCalls: number;
  monthlyCost: number;
  publishedRetained: number;
  publishedTotal: number;
  goodRetained: number;
  goodTotal: number;
  serendipityRetained: number;
  serendipityTotal: number;
  categories: number;
  sources: number;
  minOpportunity: number;
  lost: string[];
}

/**
 * Simulate one monthly budget. The corpus covers a measured span of days, so
 * counts are scaled to a month before being priced.
 */
function simulate(
  corpus: ReplayItem[],
  config: AppConfig,
  db: Db,
  monthlyBudget: number,
  perCallCost: number,
  corpusDays: number,
): Outcome {
  // How many Terra calls a month at this budget buys, after Luna's small share.
  const terraMoney = monthlyBudget * config.budget.terra_share_target;
  const monthlyCalls = Math.floor(terraMoney / perCallCost);
  const callsForCorpus = Math.max(1, Math.round((monthlyCalls * corpusDays) / 30));

  const need = feedNeed(db, config, new Date().toISOString().slice(0, 10));
  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  // Greedy selection by opportunity, exactly as the live allocator does, so the
  // simulation reflects the shipped policy rather than an idealised one.
  const remaining = [...corpus];
  const chosen: ReplayItem[] = [];
  while (remaining.length > 0 && chosen.length < callsForCorpus) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const s = scoreOpportunity(remaining[i]!, { config, need, sourceCounts, categoryCounts }).score;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const pick = remaining.splice(bestIdx, 1)[0]!;
    chosen.push(pick);
    sourceCounts.set(pick.source_id, (sourceCounts.get(pick.source_id) ?? 0) + 1);
    for (const c of pick.categories) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }

  const chosenIds = new Set(chosen.map((c) => c.item_id));

  // "Good" means Terra actually rated it highly -- a judgement already on record,
  // not one invented by the simulation.
  const good = corpus.filter((c) => (c.eav ?? 0) >= 0.7);
  const publishedItems = corpus.filter((c) => c.published);
  const serendipity = publishedItems.filter((c) => c.publishedFeeds.includes('serendipity'));

  const lost = publishedItems
    .filter((c) => !chosenIds.has(c.item_id))
    .sort((a, b) => (b.eav ?? 0) - (a.eav ?? 0))
    .map((c) => `${c.title.slice(0, 52)} (eav ${(c.eav ?? 0).toFixed(2)})`);

  return {
    budget: monthlyBudget,
    terraCalls: monthlyCalls,
    monthlyCost: monthlyCalls * perCallCost / config.budget.terra_share_target,
    publishedRetained: publishedItems.filter((c) => chosenIds.has(c.item_id)).length,
    publishedTotal: publishedItems.length,
    goodRetained: good.filter((c) => chosenIds.has(c.item_id)).length,
    goodTotal: good.length,
    serendipityRetained: serendipity.filter((c) => chosenIds.has(c.item_id)).length,
    serendipityTotal: serendipity.length,
    categories: new Set(chosen.flatMap((c) => c.categories)).size,
    sources: new Set(chosen.map((c) => c.source_id)).size,
    minOpportunity: 0,
    lost,
  };
}

function main(): void {
  loadEnvFile();
  const config = loadConfig();
  const db = initDb(config.env.dbPath);
  const corpus = loadCorpus(db, config);
  const perCall = observedTerraCostPerCall(db, config);

  // Daily volume has to come from complete days only. An RSS feed keeps a
  // window of recent items, so the oldest days in the corpus are truncated --
  // averaging over the whole span understates the real arrival rate, while
  // using first_seen_at overstates it wildly (a backlog ingested in one
  // afternoon looks like one enormous day).
  const perDayRows = db.all<{ d: string; n: number }>(
    `SELECT DATE(publication_time / 1000, 'unixepoch') AS d, COUNT(*) AS n
     FROM feed_items WHERE publication_time > 0
     GROUP BY d ORDER BY d DESC`,
    {},
  );
  // Drop today (partial) and keep the most recent stretch, which is the part the
  // feeds had not yet truncated.
  const completeDays = perDayRows.slice(1, 8);
  const rawPerDay =
    completeDays.length > 0
      ? completeDays.reduce((a, b) => a + b.n, 0) / completeDays.length
      : 0;

  const rawTotal = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM feed_items`, {})?.c ?? 1;
  const lunaPassRate = corpus.length / rawTotal;
  const lunaPerDay = rawPerDay * lunaPassRate;
  const corpusDays = Math.max(1, corpus.length / Math.max(lunaPerDay, 0.01));

  console.log(`corpus: ${corpus.length} Luna-passed items of ${rawTotal} raw`);
  console.log(
    `measured arrival rate: ${rawPerDay.toFixed(1)} raw items/day ` +
    `(mean of ${completeDays.length} complete days), Luna pass rate ${(lunaPassRate * 100).toFixed(1)}%`,
  );
  console.log(`  => ${lunaPerDay.toFixed(1)} Terra-eligible items/day, ${(lunaPerDay * 30).toFixed(0)}/month`);
  console.log(`  corpus therefore represents ~${corpusDays.toFixed(1)} days of steady-state volume`);
  console.log(`measured Terra cost per call: $${perCall.toFixed(4)}`);
  console.log(`published items in corpus: ${corpus.filter((c) => c.published).length}`);
  console.log(`Terra-rated good (eav >= 0.70): ${corpus.filter((c) => (c.eav ?? 0) >= 0.7).length}\n`);

  // Deliberately probes below the target as well. At the measured volume the
  // unconstrained cost sits under $5, so the interesting part of the frontier --
  // where the gate actually starts discarding good items -- is below that, and a
  // table that only shows $5+ would report a flat 100% and teach nothing.
  const budgets = [1, 2, 3, 4, 5, 10, 15, 20];
  const results = budgets.map((b) => simulate(corpus, config, db, b, perCall, corpusDays));

  console.log('| monthly budget | Terra calls/mo | published retained | good retained | serendipity | categories | sources |');
  console.log('| -------------: | -------------: | -----------------: | ------------: | ----------: | ---------: | ------: |');
  for (const r of results) {
    console.log(
      `| $${String(r.budget).padStart(2)} | ${String(r.terraCalls).padStart(4)} | ` +
      `${r.publishedRetained}/${r.publishedTotal} (${((100 * r.publishedRetained) / Math.max(1, r.publishedTotal)).toFixed(0)}%) | ` +
      `${r.goodRetained}/${r.goodTotal} (${((100 * r.goodRetained) / Math.max(1, r.goodTotal)).toFixed(0)}%) | ` +
      `${r.serendipityRetained}/${r.serendipityTotal} | ${r.categories} | ${r.sources} |`,
    );
  }

  console.log('\nwhat a $10 budget would have missed:');
  const ten = results.find((r) => r.budget === 10)!;
  for (const l of ten.lost.slice(0, 8)) console.log(`  - ${l}`);
  if (ten.lost.length === 0) console.log('  (nothing previously published)');

  const unconstrained = lunaPerDay * 30 * perCall;
  console.log(
    `\nif every Terra-eligible item got a call: $${unconstrained.toFixed(2)}/month ` +
    `(${(lunaPerDay * 30).toFixed(0)} calls at $${perCall.toFixed(4)})`,
  );
  console.log(
    `plus Luna and embeddings at ~${(config.budget.luna_share_target * 100).toFixed(0)}% share: ` +
    `~$${(unconstrained / config.budget.terra_share_target).toFixed(2)}/month total`,
  );
  if (unconstrained / config.budget.terra_share_target < 10) {
    console.log(
      'Note: at the measured volume the unconstrained cost is already inside the $10 target.\n' +
      'The opportunity gate is therefore protection against volume growth and backlog\n' +
      'spikes rather than a cut that has to bite today.',
    );
  }
}

main();
