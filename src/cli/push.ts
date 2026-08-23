import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveHome } from '../config/index.js';
import { main, printTable } from './_bootstrap.js';
import { loadFeedItems, renderAtomFeed, renderJsonFeed, renderRssFeed } from '../server/renderFeed.js';
import { loadCloudflareConfig, kvBulkWrite, selectChangedEntries, type KvEntry } from '../cloudflare/kv.js';
import { startJob } from '../pipeline/journal.js';
import { DAY_MS } from '../util/time.js';

/**
 * Render every feed and push it to Cloudflare KV, where the edge Worker serves
 * it. Also pushes the item -> URL map the Worker needs for /open redirects.
 *
 *   npm run push
 *   npm run push -- --dry     render and report sizes, upload nothing
 *   npm run push -- --feed classics
 *
 * Safe to run as often as you like: it overwrites the same keys.
 */
function readHashes(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { keys?: Record<string, string> };
    return parsed.keys ?? {};
  } catch {
    // No record, or an unreadable one: upload everything and rewrite it.
    return {};
  }
}

function writeHashes(path: string, keys: Record<string, string>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), keys }, null, 2)}\n`);
  } catch {
    // Failing to record hashes costs a redundant upload next time, which is far
    // better than failing a push that already succeeded.
  }
}

await main(async ({ db, config }, args) => {
  const cf = loadCloudflareConfig();
  if (!cf && !args.dry) {
    console.log('Cloudflare credentials are missing. Set these in .env:');
    console.log('  CLOUDFLARE_ACCOUNT_ID=');
    console.log('  CLOUDFLARE_API_TOKEN=      (scope: Workers KV Storage:Edit)');
    console.log('  SIFT_KV_NAMESPACE_ID=');
    console.log('');
    console.log('See the README section "Deploying to Cloudflare".');
    console.log('Run with --dry to render locally without uploading.');
    process.exitCode = 1;
    return;
  }

  const job = startJob(db, 'push');
  try {
    const entries: KvEntry[] = [];
    const summary: Array<Record<string, unknown>> = [];
    const options = {
      tracked: config.final.final_ranking.tracked_links,
      publicUrl: config.env.publicUrl,
      accessToken: config.env.accessToken,
    };

    const itemUrls = new Map<string, string>();

    const configuredFeeds = [...config.feeds, config.classics.feed];
    const requestedFeed = typeof args.feed === 'string' ? args.feed.trim() : undefined;
    const allFeeds = requestedFeed
      ? configuredFeeds.filter((feed) => feed.id === requestedFeed || feed.slug === requestedFeed)
      : configuredFeeds;
    if (allFeeds.length === 0) {
      throw new Error(
        `Unknown feed "${requestedFeed}". Available feeds: ${configuredFeeds.map((feed) => feed.slug).join(', ')}`,
      );
    }
    for (const feed of allFeeds) {
      const items = loadFeedItems(
        db,
        feed.id,
        feed.id === config.classics.feed.id
          ? config.classics.publishing.feed_length
          : config.final.final_ranking.feed_length,
      );
      const atom = renderAtomFeed(db, config, feed, items, options);
      const rss = renderRssFeed(db, config, feed, items, options);
      const json = renderJsonFeed(db, config, feed, items, options);

      entries.push({ key: `feed:${feed.slug}`, value: atom });
      entries.push({ key: `feed:${feed.slug}:rss`, value: rss });
      entries.push({ key: `feed:${feed.slug}:json`, value: json });

      for (const item of items) {
        const target = item.original_url ?? item.canonical_url;
        if (target) itemUrls.set(item.item_id, target);
      }

      summary.push({
        feed: feed.slug,
        items: items.length,
        atom_kb: (atom.length / 1024).toFixed(1),
        rss_kb: (rss.length / 1024).toFixed(1),
        json_kb: (json.length / 1024).toFixed(1),
      });
    }

    // The Worker needs a URL for every item it might be asked to redirect to.
    // Kept for 90 days: long after an item has scrolled out of every feed, a
    // link in someone's read-later queue should still resolve.
    for (const [itemId, url] of itemUrls) {
      entries.push({ key: `item:${itemId}`, value: url, expiration_ttl: 90 * 24 * 3600 });
    }

    if (requestedFeed) {
      // A scoped upload must not replace the global index or claim that every
      // feed was refreshed. It writes only the selected feed's documents,
      // redirects, and a feed-specific freshness marker.
      entries.push({ key: `meta:pushed_at:${allFeeds[0]!.slug}`, value: String(Date.now()) });
    } else {
      entries.push({ key: 'meta:pushed_at', value: String(Date.now()) });
      entries.push({
        key: 'meta:index',
        value: [
          'Sift — a private editorial desk.',
          '',
          ...allFeeds.map((f) => `  ${config.env.publicUrl}/feed/${f.slug}.xml`),
        ].join('\n'),
      });
    }

    printTable(summary);
    const totalBytes = entries.reduce((sum, e) => sum + e.value.length, 0);
    console.log('');
    console.log(
      `${entries.length} keys, ${(totalBytes / 1024).toFixed(1)} KB total ` +
        `(${itemUrls.size} item URLs, ${allFeeds.length * 3} feed documents)`,
    );

    // Only upload what actually changed.
    //
    // Every push rewrote all 105 keys regardless, byte for byte identical when
    // nothing new had published. Eight pushes a day is 840 writes against a
    // free-tier limit of 1,000, so ordinary use ran into Cloudflare's daily cap
    // on data that had not changed. The hashes of the last successful upload
    // live beside the profile, so a fresh checkout simply uploads everything
    // once.
    // Kept under data/, not inside the reader's directory. It is a cache of
    // what was last uploaded, not part of a reader's profile -- and writing it
    // through profileDirectory meant a bad profile id created a directory that
    // looked like a reader. One appeared during testing ("dimazln", holding
    // nothing but this file) and I could not reproduce how. Under data/ the
    // worst case is a stray cache file that nothing mistakes for a person.
    const statePath = resolve(resolveHome(), 'data', 'kv-state', `${config.env.profileId ?? 'default'}.json`);
    const previous = args.force === true ? {} : readHashes(statePath);
    // meta:pushed_at is a timestamp and always differs; it is the staleness
    // signal the Worker's /health reports, and two keys a push is not worth
    // economising on.
    const { changed, hashes, skipped } = selectChangedEntries(entries, previous);

    if (args.dry) {
      console.log('');
      console.log(`--dry: nothing uploaded. ${changed.length} key(s) would be written, ${skipped} unchanged.`);
      job.finish({ dryRun: true, keys: changed.length, skipped });
      return;
    }

    if (changed.length === 0) {
      console.log('');
      console.log('Nothing changed since the last push; nothing uploaded.');
      job.finish({ keys: 0, skipped, feeds: allFeeds.length });
      return;
    }

    const written = await kvBulkWrite(cf!, changed);
    writeHashes(statePath, hashes);
    job.finish({ keys: written, skipped, bytes: totalBytes, feeds: allFeeds.length });

    console.log('');
    console.log(`pushed ${written} key(s) to Cloudflare KV${skipped > 0 ? `, skipped ${skipped} unchanged` : ''}`);
    console.log(`feeds are live at ${config.env.publicUrl}/feed/<slug>.xml`);

    // A stale-feed warning is more useful here than anywhere else: this is the
    // command whose absence causes staleness.
    const newest = db.get<{ t: number }>(`SELECT MAX(published_at) AS t FROM published_feed_items`);
    if (newest?.t && Date.now() - newest.t > 2 * DAY_MS) {
      console.log('');
      console.log(
        `note: the newest published item is ${Math.round((Date.now() - newest.t) / DAY_MS)} days old. ` +
          'Run `npm run pipeline` to refresh before pushing.',
      );
    }
  } catch (err) {
    job.fail(err);
    throw err;
  }
});
