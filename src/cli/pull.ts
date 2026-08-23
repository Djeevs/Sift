import { main, printTable } from './_bootstrap.js';
import { fetchEdgeEvents } from '../cloudflare/kv.js';
import { startJob } from '../pipeline/journal.js';

/**
 * Copy open events recorded by the edge Worker into the local database, so
 * learning and diagnostics see them.
 *
 *   npm run pull
 *
 * Idempotent: the edge uses the same deterministic event ids as the Node side
 * (item + feed + day), so re-pulling the same window changes nothing.
 */
await main(async ({ db, config }) => {
  const workerUrl = config.env.publicUrl;
  if (!workerUrl || workerUrl.includes('localhost')) {
    console.log(`SIFT_PUBLIC_URL is "${workerUrl}", which is not a deployed Worker.`);
    console.log('Set it to your Worker URL (e.g. https://sift.<subdomain>.workers.dev).');
    process.exitCode = 1;
    return;
  }

  const job = startJob(db, 'pull');
  try {
    // Resume from the newest event already stored, so each pull is incremental.
    const watermark =
      db.get<{ t: number }>(`SELECT COALESCE(MAX(opened_at), 0) AS t FROM open_events`)?.t ?? 0;

    const events = await fetchEdgeEvents(workerUrl, config.env.accessToken, watermark);
    let inserted = 0;
    let unknownItem = 0;

    db.transaction(() => {
      for (const event of events) {
        // An event for an item this database has never seen would violate the
        // foreign key. That happens if the local database was reset while the
        // edge kept running; skip rather than fail the whole pull.
        const exists = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM feed_items WHERE id = :id`, {
          id: event.item_id,
        });
        if ((exists?.c ?? 0) === 0) {
          unknownItem += 1;
          continue;
        }

        const before = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM open_events WHERE id = :id`, {
          id: event.id,
        });
        db.run(
          `INSERT INTO open_events (id, item_id, feed_id, original_url, opened_at)
           VALUES (:id, :item, :feed, :url, :ts)
           ON CONFLICT(id) DO NOTHING`,
          {
            id: event.id,
            item: event.item_id,
            feed: event.feed_id,
            url: event.original_url,
            ts: event.opened_at,
          },
        );
        if ((before?.c ?? 0) === 0) inserted += 1;
      }
    });

    job.finish({ fetched: events.length, inserted, unknownItem });

    console.log(`fetched ${events.length} edge events since ${new Date(watermark).toISOString()}`);
    console.log(`${inserted} new, ${events.length - inserted - unknownItem} already known`);
    if (unknownItem > 0) {
      console.log(`${unknownItem} referenced items this database does not have (skipped)`);
    }

    if (inserted > 0) {
      printTable(
        db.all(
          `SELECT o.opened_at, s.name AS source, fi.title
           FROM open_events o
           JOIN feed_items fi ON fi.id = o.item_id
           JOIN sources s ON s.id = fi.source_id
           ORDER BY o.opened_at DESC LIMIT 10`,
        ),
      );
      console.log('');
      console.log('Run `npm run learn` to fold these into the taste weights.');
    }
  } catch (err) {
    job.fail(err);
    throw err;
  }
});
