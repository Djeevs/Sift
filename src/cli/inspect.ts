import { main, printTable } from './_bootstrap.js';
import { recentItems, itemDetail } from '../pipeline/diagnostics.js';

/**
 * Inspect items from the terminal.
 *
 *   npm run inspect
 *   npm run inspect -- --status rejected_cheap --limit 30
 *   npm run inspect -- --item <item-id>
 *   npm run inspect -- --feed essential
 */
await main(async ({ db, config }, args) => {
  if (typeof args.item === 'string') {
    const detail = itemDetail(db, config, args.item);
    if (!detail) {
      console.log('no such item');
      return;
    }
    console.log(`${detail.item.title}`);
    console.log(`${detail.item.source_name} — ${detail.item.original_url ?? ''}`);
    console.log(`status: ${detail.item.status} (${detail.item.status_reason ?? ''})`);
    console.log('');
    if (detail.cheap) {
      console.log('cheap triage:');
      printTable([detail.cheap]);
    }
    if (detail.deep) {
      console.log('');
      console.log('deep evaluation:');
      printTable([detail.deep]);
    }
    if (detail.routing.length) {
      console.log('');
      console.log('routing:');
      printTable(detail.routing);
    }
    if (detail.briefings.length) {
      console.log('');
      console.log('briefings that carried it:');
      printTable(detail.briefings);
    }
    if (detail.cluster.length) {
      console.log('');
      console.log('story cluster siblings:');
      printTable(detail.cluster);
    }
    if (detail.alternates.length) {
      console.log('');
      console.log('alternate formats:');
      printTable(detail.alternates);
    }
    console.log('');
    console.log(`opens: ${detail.opens}, explicit feedback: ${detail.feedback.map((f) => f.signal).join(', ') || 'none'}`);
    return;
  }

  if (typeof args.feed === 'string') {
    const rows = db.all(
      `SELECT p.score, s.name AS source, fi.title, p.why_it_surfaced, p.published_at
       FROM published_feed_items p
       JOIN feed_items fi ON fi.id = p.item_id
       JOIN sources s ON s.id = fi.source_id
       WHERE p.feed_id = :f ORDER BY p.published_at DESC LIMIT 40`,
      { f: args.feed },
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      console.log(`${Number(row.score).toFixed(3)}  ${String(row.source)}`);
      console.log(`       ${String(row.title)}`);
      console.log(`       why: ${String(row.why_it_surfaced ?? '')}`);
      console.log('');
    }
    return;
  }

  printTable(
    recentItems(db, {
      status: typeof args.status === 'string' ? args.status : null,
      sourceId: typeof args.source === 'string' ? args.source : null,
      limit: typeof args.limit === 'string' ? Number(args.limit) : 40,
    }).map((i) => ({
      source: i.source_name.slice(0, 20),
      title: i.title.slice(0, 55),
      status: i.status,
      cheap: i.triage_score?.toFixed(2) ?? '-',
      deep: i.expected_attention_value?.toFixed(2) ?? '-',
      feeds: i.feeds ?? '',
      reason: (i.why_it_surfaced ?? i.status_reason ?? '').slice(0, 45),
    })),
  );
});
