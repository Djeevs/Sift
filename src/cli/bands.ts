import { main, printTable } from './_bootstrap.js';

/**
 * Band calibration.
 *
 *   npm run bands
 *
 * Shows the observed free-score distribution and what the current band
 * thresholds are actually doing to it. Run this after changing the weights in
 * free-ranking.yaml: the weights change the *shape* of the distribution, and
 * thresholds that were sensible before will not be afterwards.
 *
 * What to look for: band A+B should be roughly the share of items you are willing
 * to pay Luna for. If almost everything lands in A or B, the bands are not
 * filtering and the per-run Luna budget is silently doing the work instead --
 * which is the failure mode this stage exists to avoid.
 */
await main(async ({ db, config }) => {
  const scores = db
    .all<{ free_score: number }>(
      `SELECT f.free_score
       FROM free_score_components f
       JOIN feed_items fi ON fi.id = f.item_id
       JOIN sources s ON s.id = fi.source_id
       WHERE s.enabled = 1 AND fi.is_podcast = 0
       ORDER BY f.free_score`,
    )
    .map((r) => r.free_score);

  if (scores.length === 0) {
    console.log('No free scores recorded yet. Run `npm run pipeline` first.');
    return;
  }

  const bands = config.free.free_ranking.bands;
  const at = (p: number) => scores[Math.min(scores.length - 1, Math.floor((p / 100) * scores.length))]!;

  console.log(`=== free-score distribution (n = ${scores.length}) ===`);
  printTable(
    [1, 5, 10, 25, 50, 75, 80, 85, 90, 95, 99].map((p) => ({
      percentile: `p${p}`,
      score: at(p).toFixed(3),
    })),
  );

  const counts = db.all<{ band: string; c: number; lo: number; hi: number }>(
    `SELECT band, COUNT(*) c, MIN(free_score) lo, MAX(free_score) hi
     FROM free_score_components f
     JOIN feed_items fi ON fi.id = f.item_id
     JOIN sources s ON s.id = fi.source_id
     WHERE s.enabled = 1 AND fi.is_podcast = 0
     GROUP BY band ORDER BY band`,
  );
  console.log('');
  console.log('=== current bands ===');
  printTable(
    counts.map((r) => ({
      band: r.band,
      items: r.c,
      share: `${((r.c / scores.length) * 100).toFixed(1)}%`,
      range: `${r.lo.toFixed(3)} - ${r.hi.toFixed(3)}`,
      action:
        r.band === 'A'
          ? 'always to Luna'
          : r.band === 'B'
            ? 'to Luna within budget'
            : r.band === 'C'
              ? 'rejected, audit-sampled'
              : 'rejected',
    })),
  );

  const toLuna = counts.filter((c) => c.band === 'A' || c.band === 'B').reduce((s, c) => s + c.c, 0);
  const share = (toLuna / scores.length) * 100;
  console.log('');
  console.log(`A+B = ${toLuna} of ${scores.length} items (${share.toFixed(1)}%) would go to Luna,`);
  console.log(`capped at ${config.free.free_ranking.luna_budget_per_run} per run.`);

  if (share > 70) {
    console.log('');
    console.log('The bands are barely filtering: most items reach Luna, so the per-run');
    console.log('budget is doing the real work rather than the score. Consider raising');
    console.log('a_min/b_min toward the suggestions below.');
  }

  console.log('');
  console.log('=== suggested thresholds ===');
  console.log('Targets ~15% band A, ~30% band B (so ~45% reach Luna), ~25% band C.');
  printTable([
    { setting: 'a_min', current: bands.a_min, suggested: at(85).toFixed(3) },
    { setting: 'b_min', current: bands.b_min, suggested: at(55).toFixed(3) },
    { setting: 'c_min', current: bands.c_min, suggested: at(30).toFixed(3) },
  ]);

  console.log('');
  console.log('=== component means (what is actually driving the score) ===');
  const means = db.get<Record<string, number>>(
    `SELECT AVG(source_quality_prior) source_quality, AVG(category_prior) category,
            AVG(keyword_interest_score) keyword, AVG(semantic_interest_score) semantic,
            AVG(freshness_score) freshness, AVG(editorial_type_score) editorial_type,
            AVG(discovery_signal) discovery_signal,
            AVG(source_uniqueness_score) uniqueness, AVG(source_volume_penalty) volume_penalty,
            AVG(redundancy_penalty) redundancy_penalty, AVG(clickbait_penalty) clickbait_penalty,
            AVG(negative_interest_penalty) negative_penalty
     FROM free_score_components f
     JOIN feed_items fi ON fi.id = f.item_id
     JOIN sources s ON s.id = fi.source_id
     WHERE s.enabled = 1 AND fi.is_podcast = 0`,
  );
  printTable(
    Object.entries(means ?? {}).map(([component, value]) => ({
      component,
      mean: Number(value).toFixed(3),
    })),
  );

  // A component that is constant carries no information, whatever its weight.
  const flat = Object.entries(means ?? {}).filter(([, v]) => Number(v) === 0 || Number(v) === 1);
  if (flat.length > 0) {
    console.log('');
    console.log('Components that are constant across every item, and so contribute no');
    console.log('ranking signal despite their weight:');
    for (const [name, value] of flat) console.log(`  ${name} = ${Number(value).toFixed(2)}`);
  }

  const providers = db.all<{ semantic_provider: string; c: number }>(
    `SELECT f.semantic_provider, COUNT(*) c
     FROM free_score_components f
     JOIN feed_items fi ON fi.id = f.item_id
     JOIN sources s ON s.id = fi.source_id
     WHERE s.enabled = 1 AND fi.is_podcast = 0
     GROUP BY 1`,
  );
  console.log('');
  console.log('=== semantic provider used ===');
  printTable(providers);
});
