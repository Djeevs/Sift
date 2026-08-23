/**
 * What is the funnel throwing away?
 *
 * The audit samples answer this, but only if something reads them. Before this,
 * eight free-stage samples and two Luna-stage samples had accumulated and nobody
 * could say what the false-negative rate was -- which, for a system whose stated
 * principle is that false negatives cost more than false positives, was the most
 * important unmeasured number in it.
 *
 * The headline rate matters less than the breakdown. "We drop 12% of good items"
 * is much less actionable than "we drop long-form pieces from low-prior sources".
 */
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';

export interface FreeStageReport {
  sampled: number;
  resolved: number;
  lunaKeep: number;
  lunaUncertain: number;
  lunaDrop: number;
  reachedTerra: number;
  terraHigh: number;
  wouldHavePublished: number;
  /** Share of sampled rejects that a deeper look said were worth keeping. */
  falseNegativeRate: number | null;
  /** Share that would actually have reached a feed -- the strict definition. */
  publishableMissRate: number | null;
}

export interface LunaStageReport {
  sampled: number;
  resolved: number;
  terraScores: number[];
  medianTerraScore: number | null;
  terraHigh: number;
  wouldHavePublished: number;
  falseNegativeRate: number | null;
}

export interface Breakdown {
  dimension: string;
  rows: Array<{ key: string; sampled: number; misses: number; rate: number | null }>;
}

const HIGH_EAV = 0.7;

export function freeStageReport(db: Db): FreeStageReport {
  const row = db.get<{
    sampled: number; resolved: number; keep: number; uncertain: number; dropped: number;
  }>(
    `SELECT COUNT(*) AS sampled,
            SUM(CASE WHEN audit_result IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN audit_result = 'luna_would_keep' THEN 1 ELSE 0 END) AS keep,
            SUM(CASE WHEN audit_result = 'luna_uncertain' THEN 1 ELSE 0 END) AS uncertain,
            SUM(CASE WHEN audit_result = 'luna_drop' THEN 1 ELSE 0 END) AS dropped
     FROM audit_samples WHERE boundary = 'free_to_luna'`,
    {},
  );

  // Some free-stage samples go on to get a Terra evaluation, which is a much
  // stronger verdict than Luna's on whether the reject was a mistake.
  const deep = db.get<{ reached: number; high: number; published: number }>(
    `SELECT COUNT(*) AS reached,
            SUM(CASE WHEN de.expected_attention_value >= :high THEN 1 ELSE 0 END) AS high,
            SUM(CASE WHEN a.would_have_published = 1 THEN 1 ELSE 0 END) AS published
     FROM audit_samples a JOIN deep_evaluations de ON de.item_id = a.item_id
     WHERE a.boundary = 'free_to_luna'`,
    { high: HIGH_EAV },
  );

  const sampled = row?.sampled ?? 0;
  const resolved = row?.resolved ?? 0;
  const keep = row?.keep ?? 0;
  const uncertain = row?.uncertain ?? 0;

  return {
    sampled,
    resolved,
    lunaKeep: keep,
    lunaUncertain: uncertain,
    lunaDrop: row?.dropped ?? 0,
    reachedTerra: deep?.reached ?? 0,
    terraHigh: deep?.high ?? 0,
    wouldHavePublished: deep?.published ?? 0,
    // A KEEP is a clear miss; an UNCERTAIN is half of one, since Luna itself
    // could not tell. Counting it as a whole miss overstates the problem.
    falseNegativeRate: resolved > 0 ? (keep + uncertain * 0.5) / resolved : null,
    publishableMissRate: (deep?.reached ?? 0) > 0 ? (deep!.published ?? 0) / deep!.reached : null,
  };
}

export function lunaStageReport(db: Db): LunaStageReport {
  const rows = db.all<{ eav: number; published: number }>(
    `SELECT de.expected_attention_value AS eav, COALESCE(a.would_have_published, 0) AS published
     FROM audit_samples a JOIN deep_evaluations de ON de.item_id = a.item_id
     WHERE a.boundary = 'luna_to_terra'`,
    {},
  );
  const sampled = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM audit_samples WHERE boundary = 'luna_to_terra'`,
    {},
  )?.c ?? 0;

  const scores = rows.map((r) => r.eav).sort((a, b) => a - b);
  const high = rows.filter((r) => r.eav >= HIGH_EAV).length;

  return {
    sampled,
    resolved: rows.length,
    terraScores: scores,
    medianTerraScore: scores.length > 0 ? scores[Math.floor(scores.length / 2)]! : null,
    terraHigh: high,
    wouldHavePublished: rows.filter((r) => r.published === 1).length,
    falseNegativeRate: rows.length > 0 ? high / rows.length : null,
  };
}

/**
 * The actionable half of the report: which kinds of item the cheap layers get
 * wrong. A miss is a sample the deeper stage judged worth keeping.
 */
export function breakdowns(db: Db, config: AppConfig): Breakdown[] {
  const dims: Array<{ dimension: string; expr: string }> = [
    { dimension: 'source', expr: 'COALESCE(a.source_id, fi.source_id)' },
    { dimension: 'category', expr: `COALESCE(a.category, de.category, 'unknown')` },
    { dimension: 'free-score band', expr: `COALESCE(a.band, 'n/a')` },
    { dimension: 'content type', expr: `COALESCE(a.content_type, 'unknown')` },
    {
      dimension: 'article length',
      expr: `CASE WHEN ac.word_count IS NULL THEN 'unknown'
                  WHEN ac.word_count < 400 THEN 'short (<400w)'
                  WHEN ac.word_count < 1200 THEN 'medium (400-1200w)'
                  ELSE 'long (1200w+)' END`,
    },
    {
      dimension: 'source prior',
      expr: `CASE WHEN a.source_prior IS NULL THEN 'unknown'
                  WHEN a.source_prior >= 0.8 THEN 'high (>=0.8)'
                  WHEN a.source_prior >= 0.6 THEN 'medium (0.6-0.8)'
                  ELSE 'low (<0.6)' END`,
    },
    {
      dimension: 'semantic interest',
      expr: `CASE WHEN a.semantic_interest IS NULL THEN 'unknown'
                  WHEN a.semantic_interest >= 0.6 THEN 'high (>=0.6)'
                  WHEN a.semantic_interest >= 0.35 THEN 'medium (0.35-0.6)'
                  ELSE 'low (<0.35)' END`,
    },
    { dimension: 'serendipity', expr: `CASE WHEN a.is_serendipity = 1 THEN 'yes' ELSE 'no' END` },
  ];

  return dims.map(({ dimension, expr }) => ({
    dimension,
    rows: db
      .all<{ key: string; sampled: number; misses: number }>(
        `SELECT ${expr} AS key,
                COUNT(*) AS sampled,
                SUM(CASE
                      WHEN a.audit_result IN ('luna_would_keep', 'terra_excellent') THEN 1
                      WHEN de.expected_attention_value >= ${HIGH_EAV} THEN 1
                      ELSE 0 END) AS misses
         FROM audit_samples a
         JOIN feed_items fi ON fi.id = a.item_id
         LEFT JOIN deep_evaluations de ON de.item_id = a.item_id
         LEFT JOIN article_content ac ON ac.item_id = a.item_id
         GROUP BY key
         HAVING sampled > 0
         ORDER BY misses DESC, sampled DESC`,
        {},
      )
      .map((r) => ({ ...r, rate: r.sampled > 0 ? r.misses / r.sampled : null })),
  }));
}

/**
 * Is there enough audit data to trust any of this yet? A rate computed from four
 * samples is not a rate, and saying so is more useful than printing it.
 */
export function measurementReadiness(
  db: Db,
  config: AppConfig,
): { ready: boolean; note: string; freeSamples: number; lunaSamples: number } {
  const free = freeStageReport(db);
  const luna = lunaStageReport(db);
  // Below ~30 resolved observations per boundary the confidence interval is
  // wider than any decision it would inform.
  const need = 30;
  const ready = free.resolved >= need && luna.resolved >= need;
  return {
    ready,
    freeSamples: free.resolved,
    lunaSamples: luna.resolved,
    note: ready
      ? `${free.resolved} free-stage and ${luna.resolved} Luna-stage observations resolved`
      : `needs ~${need} resolved observations per boundary; have ${free.resolved} free-stage ` +
        `and ${luna.resolved} Luna-stage (mode: ${config.modeName})`,
  };
}
