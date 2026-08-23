import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { gatherDiagnostics, itemDetail, recentItems, funnelStats, costReport } from '../pipeline/diagnostics.js';
import { budgetState, terraPathCost } from '../pipeline/budget.js';
import { clusteringStats, sampleClusters } from '../cluster/diagnostics.js';
import {
  freeStageReport,
  lunaStageReport,
  measurementReadiness,
} from '../pipeline/falseNegatives.js';
import { escapeXml } from '../util/text.js';

/**
 * A deliberately plain admin surface (§28): functional, not pretty. Everything
 * here answers a question you will actually ask -- why did this appear, why did
 * that not, what is this costing, what is broken.
 */

export function adminRoutes(
  db: Db,
  config: AppConfig,
  authorised: (token: string | undefined) => boolean,
): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const provided = c.req.query('t') ?? c.req.header('x-sift-token');
    if (!authorised(provided)) return c.text('Not found', 404);
    await next();
  });

  const tokenParam = () => {
    const t = config.env.accessToken;
    return t && t !== 'change-me-please' ? `?t=${encodeURIComponent(t)}` : '';
  };

  app.get('/', (c) => {
    const diag = gatherDiagnostics(db, config);
    const funnel = funnelStats(db);
    const cost = costReport(db, config);
    const budget = budgetState(db, config);
    const pathCost = terraPathCost(db, config);
    const cluster = clusteringStats(db, config);
    const freeFn = freeStageReport(db);
    const lunaFn = lunaStageReport(db);
    const readiness = measurementReadiness(db, config);
    const q = tokenParam();
    const sep = q ? '&' : '?';

    const html = page(
      'Sift admin',
      `
      <h1>Sift</h1>
      <p class="muted">A private editorial desk. Reeder is the frontend.</p>

      <h2>Pipeline funnel (last 7 days)</h2>
      ${table(
        ['Stage', 'Items'],
        funnel.map((f) => [f.stage, String(f.count)]),
      )}

      <h2>Feeds</h2>
      ${table(
        ['Feed', 'Today', 'Cap', 'Total', 'Subscribe'],
        diag.feeds.map((f) => [
          f.id,
          String(f.publishedToday),
          String(f.dailyCap),
          String(f.publishedTotal),
          `<a href="${config.env.publicUrl}/feed/${f.slug}.xml${q}">${f.slug}.xml</a>`,
        ]),
      )}

      <h2>Estimated spend</h2>
      ${table(
        ['Window', 'Cost (USD)', 'Requests'],
        [
          ['Today', `$${cost.today.toFixed(4)}`, String(cost.todayRequests)],
          ['Last 30 days', `$${cost.month.toFixed(4)}`, String(cost.monthRequests)],
          ['All time', `$${cost.total.toFixed(4)}`, String(cost.totalRequests)],
        ],
      )}
      ${
        cost.byStage.length
          ? table(
              ['Stage', 'Model', 'Requests', 'Input tokens', 'From cache', 'Cache hit', 'Cost'],
              cost.byStage.map((s) => [
                s.stage,
                escapeXml(s.model),
                String(s.requests),
                String(s.inputTokens),
                String(s.cachedInputTokens),
                s.cacheHitRate,
                `$${s.cost.toFixed(4)}`,
              ]),
            )
          : ''
      }
      ${
        cost.month > config.pipeline.costs.monthly_budget_warning
          ? `<p class="warn">30-day estimate exceeds the configured warning of $${config.pipeline.costs.monthly_budget_warning}.</p>`
          : ''
      }

      <h2>Cheap-stage audit (false-negative estimate)</h2>
      <p>${diag.audit.total} rejected items were sent to the deep model anyway.
      ${diag.audit.wouldHavePublished} of them would have been published
      (${diag.audit.total ? ((diag.audit.wouldHavePublished / diag.audit.total) * 100).toFixed(1) : '0'}%).</p>

      <h2>Sources</h2>
      ${table(
        ['Source', 'Items', 'Published', 'Rate', 'Last success', 'Error'],
        diag.sources.map((s) => [
          s.name,
          String(s.items),
          String(s.published),
          s.items ? `${((s.published / s.items) * 100).toFixed(1)}%` : '—',
          s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString().slice(0, 16).replace('T', ' ') : 'never',
          s.lastError ? `<span class="warn">${escapeXml(s.lastError.slice(0, 60))}</span>` : '',
        ]),
      )}

      <h2>Recent errors</h2>
      ${
        diag.errors.length
          ? table(
              ['When', 'Stage', 'Scope', 'Message'],
              diag.errors.map((e) => [
                new Date(e.created_at).toISOString().slice(5, 16).replace('T', ' '),
                e.stage,
                e.scope,
                escapeXml(e.message.slice(0, 120)),
              ]),
            )
          : '<p class="muted">None.</p>'
      }

      <h2>Budget (${budget.monthKey}, mode: ${escapeXml(config.modeName)})</h2>
      ${table(
        ['metric', 'value'],
        [
          ['month-to-date Luna', `$${budget.lunaUsd.toFixed(4)}`],
          ['month-to-date Terra', `$${budget.terraUsd.toFixed(4)}`],
          ['month-to-date total', `$${budget.spentUsd.toFixed(4)}`],
          ['projected month-end', `$${budget.projectedMonthEndUsd.toFixed(2)} (day ${budget.daysElapsed} of ${budget.daysInMonth})`],
          ['target', `$${budget.targetUsd.toFixed(2)}`],
          ['hard limit', `$${budget.hardLimitUsd.toFixed(2)}`],
          ['remaining to target', `$${budget.remainingToTargetUsd.toFixed(4)}`],
          ['degradation stage', escapeXml(budget.stage)],
          ['min opportunity for a Terra call', budget.minOpportunity.toFixed(2)],
          ['cheapest Terra path', escapeXml(pathCost.note)],
        ],
      )}

      <h2>Clustering</h2>
      ${table(
        ['metric', 'value'],
        [
          ['clusters', String(cluster.clusters)],
          ['multi-item clusters', `${cluster.multiItemClusters} (${(cluster.multiItemRate * 100).toFixed(1)}% of clustered items)`],
          ['average / median size', `${cluster.averageSize.toFixed(2)} / ${cluster.medianSize}`],
          ['largest cluster', String(cluster.largestSize)],
          ['clustered with another source', `${cluster.crossSourceItems} (${(cluster.crossSourceRate * 100).toFixed(1)}%)`],
          ['same-source duplicate pairs', String(cluster.sameSourcePairs)],
          ['cross-source duplicate pairs', String(cluster.crossSourcePairs)],
          ['kept as distinct takes', `${cluster.distinctMembers} of ${cluster.nonSeedMembers} non-seed members`],
          ['source uniqueness calibrated', `${cluster.uniquenessCalibrated ? 'yes' : 'no'} ${escapeXml(cluster.uniquenessNote)}`],
        ],
      )}

      <h2>False negatives</h2>
      <p class="muted">${escapeXml(readiness.note)}</p>
      ${table(
        ['boundary', 'sampled', 'resolved', 'would have published', 'false-negative rate'],
        [
          [
            'free -> Luna',
            String(freeFn.sampled),
            String(freeFn.resolved),
            String(freeFn.wouldHavePublished),
            freeFn.falseNegativeRate === null ? 'n/a' : `${(freeFn.falseNegativeRate * 100).toFixed(1)}%`,
          ],
          [
            'Luna -> Terra',
            String(lunaFn.sampled),
            String(lunaFn.resolved),
            String(lunaFn.wouldHavePublished),
            lunaFn.falseNegativeRate === null ? 'n/a' : `${(lunaFn.falseNegativeRate * 100).toFixed(1)}%`,
          ],
        ],
      )}

      <h2>Browse</h2>
      <ul>
        <li><a href="/admin/allocation${q}">Terra allocation: what was bought, and why</a></li>
        <li><a href="/admin/items${q}">Recent items (all stages, with scores and drop reasons)</a></li>
        <li><a href="/admin/items${q}${sep}status=published">Published only</a></li>
        <li><a href="/admin/items${q}${sep}status=rejected_luna">Rejected by Luna (stage 4)</a></li>
        <li><a href="/admin/items${q}${sep}status=rejected_free">Rejected by the free ranker (stage 3)</a></li>
        <li><a href="/admin/items${q}${sep}status=rejected_rules">Rejected by rule filters (stage 2)</a></li>
        <li><a href="/admin/clusters${q}">Story clusters with more than one member</a></li>
        <li><a href="/admin/cluster-samples${q}">Cluster samples: why were these one story?</a></li>
        <li><a href="/admin/feedback${q}">Feedback received</a></li>
      </ul>
      `,
    );
    return c.html(html);
  });

  /**
   * Why an item did or did not get a deep evaluation. Kept separate from the
   * ranking view because this is a spending decision, not an editorial one: an
   * item can be excellent and still not be worth buying today.
   */
  app.get('/allocation', (c) => {
    const budget = budgetState(db, config);
    const latest = db.get<{ ts: number }>(`SELECT MAX(created_at) AS ts FROM terra_allocation_decisions`, {});
    const rows = latest?.ts
      ? db.all<{
          item_id: string; title: string; opportunity: number; selected: number;
          is_audit: number; feed_need: number; reason: string; components_json: string;
        }>(
          `SELECT a.item_id, fi.title, a.opportunity, a.selected, a.is_audit, a.feed_need,
                  a.reason, a.components_json
           FROM terra_allocation_decisions a JOIN feed_items fi ON fi.id = a.item_id
           WHERE a.created_at = :ts ORDER BY a.opportunity DESC`,
          { ts: latest.ts },
        )
      : [];

    const q = tokenParam();
    return c.html(
      page(
        'Terra allocation',
        `
      <h1>Terra allocation</h1>
      <p class="muted">
        Budget stage <strong>${escapeXml(budget.stage)}</strong>:
        $${budget.spentUsd.toFixed(3)} of $${budget.targetUsd.toFixed(2)} this month,
        minimum opportunity ${budget.minOpportunity.toFixed(2)}.
      </p>
      ${
        rows.length === 0
          ? '<p class="muted">No allocation decisions recorded yet.</p>'
          : table(
              ['bought', 'opportunity', 'feed need', 'item', 'why'],
              rows.map((r) => [
                r.selected ? (r.is_audit ? 'yes (audit)' : 'yes') : 'no',
                r.opportunity.toFixed(3),
                r.feed_need.toFixed(2),
                `<a href="/admin/item/${encodeURIComponent(r.item_id)}${q}">${escapeXml(r.title.slice(0, 70))}</a>`,
                escapeXml(r.reason.slice(0, 160)),
              ]),
            )
      }
      <p><a href="/admin/${q}">Back</a></p>
      `,
      ),
    );
  });

  /** Multi-item clusters, so "why were these one story?" has an answer. */
  app.get('/cluster-samples', (c) => {
    const samples = sampleClusters(db, 12);
    const threshold = config.pipeline.clustering.perspective.distinct_threshold;
    return c.html(
      page(
        'Cluster samples',
        `
      <h1>Story clusters</h1>
      <p class="muted">
        Each member shows the signals that put it here, and whether it still counts
        as a distinct take (perspective distance >= ${threshold}).
      </p>
      ${samples
        .map(
          (s) => `
        <h3>${s.members.length} members</h3>
        ${table(
          ['source', 'title', 'joined because', 'perspective'],
          s.members.map((m) => [
            escapeXml(m.source_id),
            escapeXml(m.title.slice(0, 60)),
            escapeXml(m.match_reason.slice(0, 60)),
            (m.perspective_distance ?? 1) >= threshold
              ? `${(m.perspective_distance ?? 1).toFixed(3)} distinct`
              : `${(m.perspective_distance ?? 1).toFixed(3)} redundant`,
          ]),
        )}`,
        )
        .join('')}
      <p><a href="/admin/${tokenParam()}">Back</a></p>
      `,
      ),
    );
  });

  app.get('/items', (c) => {
    const status = c.req.query('status') ?? null;
    const source = c.req.query('source') ?? null;
    const limit = Math.min(500, Number(c.req.query('limit') ?? 100) || 100);
    const items = recentItems(db, { status, sourceId: source, limit });
    const q = tokenParam();

    return c.html(
      page(
        'Items',
        `
      <p><a href="/admin${q}">&larr; back</a></p>
      <h1>Recent items${status ? ` — ${escapeXml(status)}` : ''}</h1>
      ${table(
        ['Seen', 'Source', 'Title', 'Status', 'Free', 'Band', 'Luna', 'Terra', 'Feeds', 'Why / reason'],
        items.map((i) => [
          new Date(i.first_seen_at).toISOString().slice(5, 16).replace('T', ' '),
          escapeXml(i.source_name),
          `<a href="/admin/item/${i.id}${q}">${escapeXml(i.title.slice(0, 90))}</a>`,
          statusBadge(i.status),
          i.free_score === null ? '—' : i.free_score.toFixed(2),
          i.band ?? '—',
          i.triage_score === null ? '—' : i.triage_score.toFixed(2),
          i.expected_attention_value === null ? '—' : i.expected_attention_value.toFixed(2),
          escapeXml(i.feeds ?? ''),
          escapeXml((i.why_it_surfaced ?? i.status_reason ?? '').slice(0, 140)),
        ]),
      )}
      `,
      ),
    );
  });

  app.get('/item/:id', (c) => {
    const detail = itemDetail(db, config, c.req.param('id'));
    if (!detail) return c.text('Not found', 404);
    const q = tokenParam();

    return c.html(
      page(
        detail.item.title,
        `
      <p><a href="/admin/items${q}">&larr; back</a></p>
      <h1>${escapeXml(detail.item.title)}</h1>
      <p class="muted">${escapeXml(detail.item.source_name)}${detail.item.author ? ` · ${escapeXml(detail.item.author)}` : ''}
        · <a href="${escapeXml(detail.item.original_url ?? '#')}">original</a></p>
      <p>Status: ${statusBadge(detail.item.status)} — ${escapeXml(detail.item.status_reason ?? '')}</p>

      <h2>Stage 4 — Luna</h2>
      ${detail.cheap ? keyValues(detail.cheap as Record<string, unknown>) : '<p class="muted">Not evaluated.</p>'}

      <h2>Stage 5 — Terra</h2>
      ${detail.deep ? keyValues(detail.deep as Record<string, unknown>) : '<p class="muted">Not evaluated.</p>'}

      <h2>Stage 2 — rule filter</h2>
      ${detail.ruleFilter ? keyValues(detail.ruleFilter) : '<p class="muted">Not evaluated.</p>'}

      <h2>Stage 3 — free score</h2>
      ${detail.freeScore ? keyValues(detail.freeScore) : '<p class="muted">Not scored.</p>'}

      <h2>Stage 6 — final ranking, per feed</h2>
      ${
        detail.routing.length
          ? table(
              ['Feed', 'Base', 'Source ×', 'Topic ×', 'Cluster ×', 'Corr ×', 'Final', 'Min', 'Mins', 'Pick', 'Published', 'Reason'],
              detail.routing.map((r) => [
                r.feed_id,
                r.base_score.toFixed(3),
                r.source_penalty.toFixed(2),
                r.topic_penalty.toFixed(2),
                r.cluster_penalty.toFixed(2),
                r.correlation_penalty.toFixed(2),
                `<b>${r.final_score.toFixed(3)}</b>`,
                r.threshold.toFixed(2),
                r.estimated_minutes === null ? '' : String(Math.round(r.estimated_minutes)),
                r.selection_order === null ? '' : `#${r.selection_order}`,
                r.published ? 'yes' : 'no',
                escapeXml(r.reason),
              ]),
            )
          : '<p class="muted">Never reached the final ranker.</p>'
      }

      <h2>Attention cost</h2>
      ${detail.attention ? keyValues(detail.attention) : '<p class="muted">Not estimated.</p>'}

      ${
        detail.auditSamples.length
          ? `<h2>Audit sampling</h2>${table(
              ['Boundary', 'Normal decision', 'Result'],
              detail.auditSamples.map((a) => [
                a.boundary,
                escapeXml(a.normal_decision),
                escapeXml(a.audit_result ?? 'pending'),
              ]),
            )}`
          : ''
      }

      <h2>Story cluster</h2>
      ${
        detail.cluster.length
          ? table(
              ['Source', 'Title', 'Similarity', 'Matched by'],
              detail.cluster.map((m) => [
                escapeXml(m.source_id),
                `<a href="/admin/item/${m.item_id}${q}">${escapeXml(m.title.slice(0, 80))}</a>`,
                m.similarity.toFixed(3),
                escapeXml(m.match_reason),
              ]),
            )
          : '<p class="muted">No siblings (singleton cluster).</p>'
      }

      <h2>Alternate formats</h2>
      ${
        detail.alternates.length
          ? table(
              ['Type', 'Confidence', 'Duration', 'URL', 'Signals'],
              detail.alternates.map((a) => [
                a.format_type,
                a.confidence.toFixed(2),
                a.duration_minutes ? `${a.duration_minutes} min` : '—',
                `<a href="${escapeXml(a.url)}">link</a>`,
                escapeXml(a.signals_json),
              ]),
            )
          : '<p class="muted">None found.</p>'
      }

      <h2>Feedback</h2>
      <p>Opens: ${detail.opens}${
        detail.feedback.length
          ? ` — explicit: ${detail.feedback.map((f) => escapeXml(f.signal)).join(', ')}`
          : ''
      }</p>

      <h2>Extraction</h2>
      ${
        detail.content
          ? `<p class="muted">${escapeXml(detail.content.extraction_method)} · ${detail.content.body_chars} chars · ${
              detail.content.reading_minutes ?? '?'
            } min${detail.content.error ? ` · ${escapeXml(detail.content.error)}` : ''}</p>
             <pre>${escapeXml((detail.content.body_text ?? '').slice(0, 3000))}</pre>`
          : '<p class="muted">Not fetched.</p>'
      }

      <h2>Raw model output</h2>
      <pre>${escapeXml(rawJson(detail.deep) ?? rawJson(detail.cheap) ?? '(none)')}</pre>
      `,
      ),
    );
  });

  app.get('/clusters', (c) => {
    const q = tokenParam();
    const clusters = db.all<{ id: string; cluster_topic: string | null; member_count: number }>(
      `SELECT id, cluster_topic, member_count FROM story_clusters
       WHERE member_count > 1 ORDER BY last_updated_at DESC LIMIT 100`,
    );
    const rows = clusters.map((cluster) => {
      const members = db.all<{ item_id: string; title: string; source_id: string }>(
        `SELECT m.item_id, fi.title, fi.source_id FROM story_cluster_members m
         JOIN feed_items fi ON fi.id = m.item_id WHERE m.cluster_id = :c`,
        { c: cluster.id },
      );
      return [
        escapeXml((cluster.cluster_topic ?? '').slice(0, 80)),
        String(cluster.member_count),
        members
          .map((m) => `<a href="/admin/item/${m.item_id}${q}">${escapeXml(m.source_id)}</a>: ${escapeXml(m.title.slice(0, 60))}`)
          .join('<br>'),
      ];
    });
    return c.html(
      page(
        'Clusters',
        `<p><a href="/admin${q}">&larr; back</a></p><h1>Story clusters</h1>${table(['Topic', 'Members', 'Items'], rows)}`,
      ),
    );
  });

  app.get('/feedback', (c) => {
    const q = tokenParam();
    const rows = db.all<{
      signal: string;
      origin: string;
      created_at: number;
      title: string | null;
      item_id: string | null;
      raw_title: string | null;
    }>(
      `SELECT f.signal, f.origin, f.created_at, fi.title, f.item_id, f.raw_title
       FROM explicit_feedback f LEFT JOIN feed_items fi ON fi.id = f.item_id
       ORDER BY f.created_at DESC LIMIT 200`,
    );
    return c.html(
      page(
        'Feedback',
        `<p><a href="/admin${q}">&larr; back</a></p><h1>Explicit feedback</h1>
        ${table(
          ['When', 'Signal', 'Origin', 'Item'],
          rows.map((r) => [
            new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' '),
            r.signal === 'excellent' ? '<b>excellent</b>' : escapeXml(r.signal),
            escapeXml(r.origin),
            r.item_id
              ? `<a href="/admin/item/${r.item_id}${q}">${escapeXml((r.title ?? '').slice(0, 80))}</a>`
              : `<span class="muted">unmatched: ${escapeXml((r.raw_title ?? '').slice(0, 80))}</span>`,
          ]),
        )}`,
      ),
    );
  });

  return app;
}

/** The evaluation rows come back as loose records; pull raw_json safely. */
function rawJson(row: Record<string, unknown> | null): string | null {
  const value = row?.['raw_json'];
  return typeof value === 'string' ? value : null;
}

function statusBadge(status: string): string {
  const colour =
    status === 'published'
      ? '#0a0'
      : status.startsWith('rejected')
        ? '#a00'
        : status === 'error'
          ? '#c60'
          : '#666';
  return `<span style="color:${colour}">${escapeXml(status)}</span>`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    '<table>',
    `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`,
    '<tbody>',
    ...rows.map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join('')}</tr>`),
    '</tbody></table>',
  ].join('\n');
}

function keyValues(obj: Record<string, unknown>): string {
  const skip = new Set(['raw_json', 'item_id']);
  const rows = Object.entries(obj)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => [escapeXml(k), escapeXml(typeof v === 'number' ? formatNumber(k, v) : String(v))]);
  return table(['Field', 'Value'], rows);
}

function formatNumber(key: string, value: number): string {
  if (key.endsWith('_at') || key === 'created_at') return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeXml(title)} — Sift</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #eee; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eee; vertical-align: top; font-size: 13px; }
  th { background: #fafafa; font-weight: 600; }
  .muted { color: #888; } .warn { color: #b00; }
  pre { background: #f7f7f7; padding: .75rem; overflow-x: auto; white-space: pre-wrap; font-size: 12px; max-height: 30rem; }
  a { color: #06c; text-decoration: none; } a:hover { text-decoration: underline; }
</style></head><body>${body}</body></html>`;
}
