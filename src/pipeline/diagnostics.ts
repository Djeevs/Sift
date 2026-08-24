import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { dayKey, DAY_MS } from '../util/time.js';

/** Everything needed to answer the questions in §20. */

export interface FunnelRow {
  stage: string;
  count: number;
}

export function funnelStats(db: Db, days = 7): FunnelRow[] {
  const since = Date.now() - days * DAY_MS;
  const one = (sql: string, params: Record<string, unknown> = {}): number =>
    db.get<{ c: number }>(sql, { since, ...params })?.c ?? 0;

  return [
    { stage: 'raw items ingested', count: one(`SELECT COUNT(*) AS c FROM feed_items WHERE first_seen_at >= :since`) },
    {
      stage: 'removed by rule filters',
      count: one(`SELECT COUNT(*) AS c FROM feed_items WHERE first_seen_at >= :since AND status = 'rejected_rules'`),
    },
    {
      stage: 'free-scored',
      count: one(
        `SELECT COUNT(*) AS c FROM free_score_components f JOIN feed_items fi ON fi.id = f.item_id
         WHERE fi.first_seen_at >= :since`,
      ),
    },
    {
      stage: '  rejected by the free ranker',
      count: one(`SELECT COUNT(*) AS c FROM feed_items WHERE first_seen_at >= :since AND status = 'rejected_free'`),
    },
    {
      stage: 'duplicate URLs skipped',
      count: one(`SELECT COUNT(*) AS c FROM feed_items WHERE first_seen_at >= :since AND status = 'skipped_duplicate'`),
    },
    {
      stage: 'reached Luna',
      count: one(
        `SELECT COUNT(*) AS c FROM cheap_evaluations ce JOIN feed_items fi ON fi.id = ce.item_id
         WHERE fi.first_seen_at >= :since`,
      ),
    },
    {
      stage: '  of which passed triage',
      count: one(
        `SELECT COUNT(*) AS c FROM cheap_evaluations ce JOIN feed_items fi ON fi.id = ce.item_id
         WHERE fi.first_seen_at >= :since AND ce.passed = 1`,
      ),
    },
    {
      stage: 'reached Terra',
      count: one(
        `SELECT COUNT(*) AS c FROM deep_evaluations de JOIN feed_items fi ON fi.id = de.item_id
         WHERE fi.first_seen_at >= :since`,
      ),
    },
    {
      stage: '  of which audit samples',
      count: one(
        `SELECT COUNT(*) AS c FROM deep_evaluations de JOIN feed_items fi ON fi.id = de.item_id
         WHERE fi.first_seen_at >= :since AND de.is_audit_sample = 1`,
      ),
    },
    {
      stage: 'published (placements)',
      count: one(`SELECT COUNT(*) AS c FROM published_feed_items WHERE published_at >= :since`),
    },
    {
      stage: 'published (distinct items)',
      count: one(`SELECT COUNT(DISTINCT item_id) AS c FROM published_feed_items WHERE published_at >= :since`),
    },
    { stage: 'opened', count: one(`SELECT COUNT(DISTINCT item_id) AS c FROM open_events WHERE opened_at >= :since`) },
    {
      stage: 'marked excellent',
      count: one(`SELECT COUNT(*) AS c FROM explicit_feedback WHERE created_at >= :since AND signal = 'excellent'`),
    },
    {
      stage: 'marked not for me',
      count: one(`SELECT COUNT(*) AS c FROM explicit_feedback WHERE created_at >= :since AND signal = 'not_for_me'`),
    },
    {
      stage: 'multi-item story clusters',
      count: one(`SELECT COUNT(*) AS c FROM story_clusters WHERE member_count > 1 AND last_updated_at >= :since`),
    },
  ];
}

export interface SourceStat {
  id: string;
  name: string;
  items: number;
  published: number;
  excellent: number;
  notForMe: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export function sourceStats(db: Db): SourceStat[] {
  return db.all<SourceStat>(
    `SELECT s.id, s.name, s.last_success_at AS lastSuccessAt, s.last_error AS lastError,
            (SELECT COUNT(*) FROM feed_items fi WHERE fi.source_id = s.id) AS items,
            (SELECT COUNT(DISTINCT p.item_id) FROM published_feed_items p
              JOIN feed_items fi2 ON fi2.id = p.item_id WHERE fi2.source_id = s.id) AS published,
            (SELECT COUNT(*) FROM explicit_feedback f JOIN feed_items fi3 ON fi3.id = f.item_id
              WHERE fi3.source_id = s.id AND f.signal = 'excellent') AS excellent,
            (SELECT COUNT(*) FROM explicit_feedback f JOIN feed_items fi4 ON fi4.id = f.item_id
              WHERE fi4.source_id = s.id AND f.signal = 'not_for_me') AS notForMe
     FROM sources s
     ORDER BY published DESC, items DESC`,
  );
}

export interface AuditSummary {
  total: number;
  wouldHavePublished: number;
  examples: Array<{ item_id: string; title: string; source_id: string; score: number; why: string | null }>;
}

/**
 * The false-negative estimate: of the rejected items we deep-evaluated anyway,
 * how many would have been good enough to publish?
 */
export function auditSummary(db: Db, config: AppConfig): AuditSummary {
  const rows = db.all<{
    item_id: string;
    title: string;
    source_id: string;
    expected_attention_value: number;
    why_it_surfaced: string | null;
    published: number;
  }>(
    `SELECT de.item_id, fi.title, fi.source_id, de.expected_attention_value, de.why_it_surfaced,
            CASE WHEN EXISTS (SELECT 1 FROM routing_decisions r
                              WHERE r.item_id = de.item_id AND r.score >= r.threshold)
                 THEN 1 ELSE 0 END AS published
     FROM deep_evaluations de
     JOIN feed_items fi ON fi.id = de.item_id
     WHERE de.is_audit_sample = 1
     ORDER BY de.expected_attention_value DESC`,
  );

  return {
    total: rows.length,
    wouldHavePublished: rows.filter((r) => r.published === 1).length,
    examples: rows.slice(0, 25).map((r) => ({
      item_id: r.item_id,
      title: r.title,
      source_id: r.source_id,
      score: r.expected_attention_value,
      why: r.why_it_surfaced,
    })),
  };
}

export interface CostReport {
  today: number;
  todayRequests: number;
  month: number;
  monthRequests: number;
  total: number;
  totalRequests: number;
  byStage: Array<{
    stage: string;
    model: string;
    cost: number;
    requests: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheHitRate: string;
  }>;
}

export function costReport(db: Db, _config: AppConfig): CostReport {
  const sum = (since: number | null) => {
    const row = since
      ? db.get<{ c: number; r: number }>(
          `SELECT COALESCE(SUM(estimated_cost), 0) AS c, COALESCE(SUM(requests), 0) AS r
           FROM api_usage WHERE created_at >= :since`,
          { since },
        )
      : db.get<{ c: number; r: number }>(
          `SELECT COALESCE(SUM(estimated_cost), 0) AS c, COALESCE(SUM(requests), 0) AS r FROM api_usage`,
        );
    return { cost: row?.c ?? 0, requests: row?.r ?? 0 };
  };

  const startOfToday = new Date(`${dayKey(Date.now())}T00:00:00Z`).getTime();
  const today = sum(startOfToday);
  const month = sum(Date.now() - 30 * DAY_MS);
  const total = sum(null);

  return {
    today: today.cost,
    todayRequests: today.requests,
    month: month.cost,
    monthRequests: month.requests,
    total: total.cost,
    totalRequests: total.requests,
    byStage: db
      .all<{
        stage: string;
        model: string;
        cost: number;
        requests: number;
        inputTokens: number;
        cachedInputTokens: number;
      }>(
        `SELECT stage, model,
                COALESCE(SUM(estimated_cost), 0) AS cost,
                COALESCE(SUM(requests), 0) AS requests,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens
         FROM api_usage GROUP BY stage, model ORDER BY SUM(input_tokens) DESC`,
      )
      .map((r) => ({
        ...r,
        // Share of input tokens served from the provider's prompt cache. For the
        // two chat stages this should settle well above zero once a run has more
        // than a couple of items; near-zero means caching is not engaging.
        cacheHitRate: r.inputTokens > 0 ? `${((r.cachedInputTokens / r.inputTokens) * 100).toFixed(1)}%` : '-',
      })),
  };
}

export interface FeedStat {
  id: string;
  slug: string;
  dailyCap: number;
  publishedToday: number;
  publishedTotal: number;
}

export interface BriefingStat {
  localDay: string;
  slot: string;
  label: string;
  items: number;
  candidates: number;
  publishedAt: string;
  /** Minutes between the slot's time and when it was actually built. */
  lateMinutes: number;
}

/**
 * Recent briefing editions.
 *
 * Separate from `feedStats` because the briefing intentionally writes no
 * `published_feed_items` rows -- listing it there would report a permanent zero
 * and read as a broken feed rather than as a differently-shaped one.
 *
 * `lateMinutes` is the number worth watching: consistently high means the Mac
 * is asleep at 08:00, and editions are being skipped rather than delivered.
 */
export function briefingStats(db: Db, config: AppConfig, limit = 10): BriefingStat[] {
  return db
    .all<{
      local_day: string;
      slot: string;
      slot_label: string;
      item_count: number;
      candidates: number;
      scheduled_for: number;
      published_at: number;
    }>(
      `SELECT local_day, slot, slot_label, item_count, candidates, scheduled_for, published_at
       FROM briefing_editions WHERE feed_id = :feed
       ORDER BY published_at DESC LIMIT :limit`,
      { feed: config.briefing.feed.id, limit },
    )
    .map((row) => ({
      localDay: row.local_day,
      slot: row.slot,
      label: row.slot_label,
      items: row.item_count,
      candidates: row.candidates,
      publishedAt: new Date(row.published_at).toISOString(),
      lateMinutes: Math.round((row.published_at - row.scheduled_for) / 60_000),
    }));
}

export function feedStats(db: Db, config: AppConfig): FeedStat[] {
  const today = dayKey(Date.now());
  return config.feeds.map((feed) => ({
    id: feed.id,
    slug: feed.slug,
    dailyCap: feed.daily_cap,
    publishedToday:
      db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM published_feed_items WHERE feed_id = :f AND day_key = :d`,
        { f: feed.id, d: today },
      )?.c ?? 0,
    publishedTotal:
      db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE feed_id = :f`, { f: feed.id })?.c ?? 0,
  }));
}

export interface Diagnostics {
  feeds: FeedStat[];
  sources: SourceStat[];
  audit: AuditSummary;
  errors: Array<{ scope: string; stage: string; message: string; created_at: number }>;
  categories: Array<{ category: string; count: number }>;
}

export function gatherDiagnostics(db: Db, config: AppConfig): Diagnostics {
  return {
    feeds: feedStats(db, config),
    sources: sourceStats(db),
    audit: auditSummary(db, config),
    errors: db.all(
      `SELECT scope, stage, message, created_at FROM processing_errors ORDER BY created_at DESC LIMIT 25`,
    ),
    categories: db.all(
      `SELECT COALESCE(de.category, 'unknown') AS category, COUNT(*) AS count
       FROM published_feed_items p JOIN deep_evaluations de ON de.item_id = p.item_id
       GROUP BY category ORDER BY count DESC`,
    ),
  };
}

export interface RecentItemRow {
  id: string;
  title: string;
  source_name: string;
  status: string;
  status_reason: string | null;
  first_seen_at: number;
  free_score: number | null;
  band: string | null;
  triage_score: number | null;
  expected_attention_value: number | null;
  why_it_surfaced: string | null;
  feeds: string | null;
}

export function recentItems(
  db: Db,
  opts: { status?: string | null; sourceId?: string | null; limit?: number } = {},
): RecentItemRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 100 };
  if (opts.status) {
    clauses.push('fi.status = :status');
    params.status = opts.status;
  }
  if (opts.sourceId) {
    clauses.push('fi.source_id = :source');
    params.source = opts.sourceId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return db.all<RecentItemRow>(
    `SELECT fi.id, fi.title, s.name AS source_name, fi.status, fi.status_reason, fi.first_seen_at,
            f.free_score, f.band, ce.triage_score, de.expected_attention_value, de.why_it_surfaced,
            (SELECT GROUP_CONCAT(p.feed_id, ', ') FROM published_feed_items p WHERE p.item_id = fi.id) AS feeds
     FROM feed_items fi
     JOIN sources s ON s.id = fi.source_id
     LEFT JOIN free_score_components f ON f.item_id = fi.id
     LEFT JOIN cheap_evaluations ce ON ce.item_id = fi.id
     LEFT JOIN deep_evaluations de ON de.item_id = fi.id
     ${where}
     ORDER BY fi.first_seen_at DESC
     LIMIT :limit`,
    params,
  );
}

export interface ItemDetail {
  item: {
    id: string;
    title: string;
    source_name: string;
    author: string | null;
    original_url: string | null;
    status: string;
    status_reason: string | null;
  };
  /** Stage 2. */
  ruleFilter: Record<string, unknown> | null;
  /** Stage 3, every component rather than just the total. */
  freeScore: Record<string, unknown> | null;
  /** Stage 4. */
  cheap: Record<string, unknown> | null;
  /** Stage 5. */
  deep: Record<string, unknown> | null;
  /**
   * Stage 7. Which briefings carried this item, and the summary each showed.
   *
   * Separate from `routing` because a briefing line is not a feed placement --
   * it has no final_ranking_decisions row and no threshold. Without this,
   * "why did this reach me?" had no answer for an article the reader met on
   * line three of the morning digest.
   */
  briefings: Array<{
    local_day: string;
    slot: string;
    rank_position: number;
    score: number;
    summary_source: string;
  }>;
  /** Stage 6, one row per feed with every adjustment that moved the score. */
  routing: Array<{
    feed_id: string;
    base_score: number;
    final_score: number;
    threshold: number;
    published: number;
    source_penalty: number;
    topic_penalty: number;
    cluster_penalty: number;
    correlation_penalty: number;
    selection_order: number | null;
    exploration_slot: number;
    estimated_minutes: number | null;
    reason: string;
  }>;
  attention: Record<string, unknown> | null;
  auditSamples: Array<{ boundary: string; normal_decision: string; audit_result: string | null }>;
  cluster: Array<{ item_id: string; title: string; source_id: string; similarity: number; match_reason: string }>;
  alternates: Array<{
    format_type: string;
    url: string;
    confidence: number;
    duration_minutes: number | null;
    signals_json: string;
  }>;
  content: {
    extraction_method: string;
    body_chars: number;
    body_text: string | null;
    reading_minutes: number | null;
    error: string | null;
  } | null;
  opens: number;
  feedback: Array<{ signal: string; origin: string; created_at: number }>;
}

export function itemDetail(db: Db, _config: AppConfig, itemId: string): ItemDetail | null {
  const item = db.get<ItemDetail['item']>(
    `SELECT fi.id, fi.title, s.name AS source_name, fi.author, fi.original_url, fi.status, fi.status_reason
     FROM feed_items fi JOIN sources s ON s.id = fi.source_id WHERE fi.id = :id`,
    { id: itemId },
  );
  if (!item) return null;

  return {
    item,
    ruleFilter: db.get(`SELECT * FROM rule_filter_evaluations WHERE item_id = :id`, { id: itemId }) ?? null,
    freeScore: db.get(`SELECT * FROM free_score_components WHERE item_id = :id`, { id: itemId }) ?? null,
    cheap: db.get(`SELECT * FROM cheap_evaluations WHERE item_id = :id`, { id: itemId }) ?? null,
    deep: db.get(`SELECT * FROM deep_evaluations WHERE item_id = :id`, { id: itemId }) ?? null,
    routing: db.all(
      `SELECT feed_id, base_score, final_score, threshold, published, source_penalty,
              topic_penalty, cluster_penalty, correlation_penalty, selection_order,
              exploration_slot, estimated_minutes, reason
       FROM final_ranking_decisions
       WHERE item_id = :id ORDER BY final_score DESC`,
      { id: itemId },
    ),
    briefings: db.all(
      `SELECT be.local_day, be.slot, bei.rank_position, bei.score, bei.summary_source
       FROM briefing_edition_items bei
       JOIN briefing_editions be ON be.id = bei.edition_id
       WHERE bei.item_id = :id ORDER BY be.published_at DESC`,
      { id: itemId },
    ),
    attention: db.get(`SELECT * FROM attention_estimates WHERE item_id = :id`, { id: itemId }) ?? null,
    auditSamples: db.all(
      `SELECT boundary, normal_decision, audit_result FROM audit_samples WHERE item_id = :id`,
      { id: itemId },
    ),
    cluster: db.all(
      `SELECT m2.item_id, fi.title, fi.source_id, m2.similarity, m2.match_reason
       FROM story_cluster_members m1
       JOIN story_cluster_members m2 ON m2.cluster_id = m1.cluster_id AND m2.item_id != m1.item_id
       JOIN feed_items fi ON fi.id = m2.item_id
       WHERE m1.item_id = :id`,
      { id: itemId },
    ),
    alternates: db.all(
      `SELECT format_type, url, confidence, duration_minutes, signals_json FROM alternate_formats
       WHERE item_id = :id ORDER BY confidence DESC`,
      { id: itemId },
    ),
    content:
      db.get(
        `SELECT extraction_method, body_chars, body_text, reading_minutes, error
         FROM article_content WHERE item_id = :id`,
        { id: itemId },
      ) ?? null,
    opens: db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM open_events WHERE item_id = :id`, { id: itemId })?.c ?? 0,
    feedback: db.all(
      `SELECT signal, origin, created_at FROM explicit_feedback WHERE item_id = :id ORDER BY created_at DESC`,
      { id: itemId },
    ),
  };
}
