import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { logger } from '../util/log.js';

const log = logger('audit');

/**
 * Audit sampling: the false-negative measurement.
 *
 * At each expensive boundary a small random slice of *rejected* items is pushed
 * through anyway. Those items never enter a feed automatically -- the point is not
 * to rescue them, it is to find out how often the cheap layers are wrong.
 *
 * Two questions this answers, and they are among the most important numbers in
 * the system:
 *
 *   How often does Luna find good items among free-ranker rejects?
 *   How often does Terra find excellent items among Luna rejects?
 *
 * If either rate is high, the layer above is too aggressive and its threshold
 * should come down.
 */

export interface AuditResolution {
  boundary: string;
  resolved: number;
}

/**
 * Fill in what the deeper stage concluded about each sampled reject. Idempotent:
 * a sample already resolved keeps its result.
 */
export function resolveAuditSamples(db: Db, config: AppConfig): AuditResolution[] {
  const ts = Date.now();
  const out: AuditResolution[] = [];

  // --- free_to_luna: what did Luna say about free-ranker rejects? -----------
  const freeSamples = db.all<{
    item_id: string;
    action: string;
    passed: number;
    triage_score: number;
  }>(
    `SELECT a.item_id, ce.action, ce.passed, ce.triage_score
     FROM audit_samples a
     JOIN cheap_evaluations ce ON ce.item_id = a.item_id
     WHERE a.boundary = 'free_to_luna' AND a.audit_result IS NULL`,
  );

  db.transaction(() => {
    for (const row of freeSamples) {
      // "Good" here means Luna would have let it through on its own merits --
      // that is exactly the item the free ranker should not have rejected.
      const verdict = row.passed === 1 ? 'luna_would_keep' : `luna_${row.action.toLowerCase()}`;
      db.run(
        `UPDATE audit_samples
         SET audit_result = :result, downstream_score = :score, resolved_at = :ts
         WHERE item_id = :id AND boundary = 'free_to_luna'`,
        { id: row.item_id, result: verdict, score: row.triage_score, ts },
      );
    }
  });
  out.push({ boundary: 'free_to_luna', resolved: freeSamples.length });

  // --- luna_to_terra: what did Terra say about Luna's rejects? --------------
  const lunaSamples = db.all<{
    item_id: string;
    expected_attention_value: number;
    would_publish: number;
  }>(
    `SELECT a.item_id, de.expected_attention_value,
            CASE WHEN EXISTS (
              SELECT 1 FROM final_ranking_decisions r
              WHERE r.item_id = a.item_id AND r.final_score >= r.threshold
            ) THEN 1 ELSE 0 END AS would_publish
     FROM audit_samples a
     JOIN deep_evaluations de ON de.item_id = a.item_id
     WHERE a.boundary = 'luna_to_terra' AND a.audit_result IS NULL`,
  );

  db.transaction(() => {
    for (const row of lunaSamples) {
      db.run(
        `UPDATE audit_samples
         SET audit_result = :result, downstream_score = :score,
             would_have_published = :pub, resolved_at = :ts
         WHERE item_id = :id AND boundary = 'luna_to_terra'`,
        {
          id: row.item_id,
          result: row.would_publish === 1 ? 'terra_excellent' : 'terra_ordinary',
          score: row.expected_attention_value,
          pub: row.would_publish,
          ts,
        },
      );
    }
  });
  out.push({ boundary: 'luna_to_terra', resolved: lunaSamples.length });

  const total = out.reduce((s, r) => s + r.resolved, 0);
  if (total > 0) log.info(`resolved ${total} audit samples`);
  return out;
}

export interface BoundaryAudit {
  boundary: string;
  sampled: number;
  resolved: number;
  /** Items the deeper stage judged worth having: the false-negative estimate. */
  falseNegatives: number;
  falseNegativeRate: number | null;
  examples: Array<{
    item_id: string;
    title: string;
    source_id: string;
    band: string | null;
    free_score: number | null;
    downstream_score: number | null;
    audit_result: string | null;
  }>;
}

/** Per-boundary false-negative estimates, for `npm run audit` and /admin. */
export function auditReport(db: Db, _config: AppConfig): BoundaryAudit[] {
  const boundaries = ['free_to_luna', 'luna_to_terra'];
  return boundaries.map((boundary) => {
    const counts = db.get<{ sampled: number; resolved: number; positive: number }>(
      `SELECT COUNT(*) AS sampled,
              SUM(CASE WHEN audit_result IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN audit_result IN ('luna_would_keep', 'terra_excellent') THEN 1 ELSE 0 END) AS positive
       FROM audit_samples WHERE boundary = :b`,
      { b: boundary },
    );
    const resolved = counts?.resolved ?? 0;
    const positive = counts?.positive ?? 0;

    const examples = db.all<BoundaryAudit['examples'][number]>(
      `SELECT a.item_id, fi.title, fi.source_id, a.band, a.free_score,
              a.downstream_score, a.audit_result
       FROM audit_samples a
       JOIN feed_items fi ON fi.id = a.item_id
       WHERE a.boundary = :b AND a.audit_result IS NOT NULL
       ORDER BY a.downstream_score DESC NULLS LAST
       LIMIT 15`,
      { b: boundary },
    );

    return {
      boundary,
      sampled: counts?.sampled ?? 0,
      resolved,
      falseNegatives: positive,
      falseNegativeRate: resolved > 0 ? positive / resolved : null,
      examples,
    };
  });
}
