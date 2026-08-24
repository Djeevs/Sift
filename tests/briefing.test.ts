import { describe, expect, it } from 'vitest';
import {
  briefingSummary,
  dueSlot,
  hasEdition,
  loadBriefingEditions,
  previousDay,
  recentSlots,
  runBriefing,
  selectBriefingLines,
  slotLabelFor,
  wallClockAt,
  windowStartFor,
} from '../src/briefing/index.js';
import { runClassics } from '../src/classics/index.js';
import { AiClient } from '../src/ai/client.js';
import { publishEditions } from '../src/rank/publishEdition.js';
import { renderFeedDocuments } from '../src/server/renderFeed.js';
import { createApp } from '../src/server/app.js';
import { allFeeds, type AppConfig } from '../src/config/index.js';
import { HOUR_MS } from '../src/util/time.js';
import { testDb, seedItem, seedDeepEvaluation, type SeedDeepScores } from './helpers.js';

/**
 * The briefing is the one feed that bundles articles rather than listing them,
 * and the one that cares what time it is. Both of those create failure modes no
 * other feed has, so most of what is asserted here is a boundary the briefing
 * must not cross rather than a number it must produce.
 */

/** 2026-08-23 10:00 UTC. Fixed, so nothing here depends on when it is run. */
const NOW = Date.UTC(2026, 7, 23, 10, 0);

/**
 * A known briefing configuration for one test.
 *
 * Every field a test here might change is set explicitly, not just the two that
 * matter to the caller. `loadConfig` caches, so `testDb()` hands every test the
 * same object: a test that lowered `max_per_source` to check the cap silently
 * lowered it for every test that ran afterwards, and those tests then asserted
 * against a config no YAML file describes.
 *
 * The timezone is pinned to UTC so the slot arithmetic is checkable by reading
 * it, rather than depending on how the machine running the tests is set.
 */
function briefingConfig(config: AppConfig): AppConfig {
  config.briefing.enabled = true;
  config.briefing.schedule.timezone = 'UTC';
  config.briefing.schedule.times = ['08:00', '20:00'];
  config.briefing.schedule.max_lateness_minutes = 360;
  config.briefing.selection.items = 10;
  config.briefing.selection.min_items = 4;
  config.briefing.selection.window_hours = 14;
  config.briefing.selection.max_age_hours = 36;
  config.briefing.selection.max_per_cluster = 1;
  config.briefing.selection.max_per_source = 3;
  config.briefing.selection.repeat_across_editions = false;
  config.briefing.summary.max_chars = 220;
  config.briefing.summary.sources = ['publisher', 'why_it_surfaced'];
  config.classics.enabled = true;
  return config;
}

function seedCandidate(
  db: ReturnType<typeof testDb>['db'],
  opts: {
    title: string;
    sourceId?: string;
    hoursAgo?: number;
    clusterId?: string | null;
    summary?: string;
    scores?: SeedDeepScores;
    audit?: boolean;
  },
): string {
  const id = seedItem(db, {
    sourceId: opts.sourceId ?? 'quanta',
    title: opts.title,
    summary: opts.summary ?? `What happened, in the publisher's own words: ${opts.title}.`,
    publishedAt: NOW - (opts.hoursAgo ?? 2) * HOUR_MS,
    status: 'deep_evaluated',
    clusterId: opts.clusterId ?? null,
  });
  seedDeepEvaluation(db, id, { category: 'ai_product', ...opts.scores });
  if (opts.audit) db.run(`UPDATE deep_evaluations SET is_audit_sample = 1 WHERE item_id = :id`, { id });
  return id;
}

describe('briefing schedule', () => {
  it('reads the wall clock in the reader’s zone, not the host’s', () => {
    // The same instant is two different days in these two zones, which is the
    // whole reason a briefing needs a timezone rather than a UTC day key.
    const instant = Date.UTC(2026, 7, 23, 23, 30);
    expect(wallClockAt(instant, 'UTC')).toMatchObject({ day: 23, hour: 23 });
    expect(wallClockAt(instant, 'Pacific/Auckland')).toMatchObject({ day: 24, hour: 11 });
  });

  it('falls back to the host clock rather than throwing on an unusable zone', () => {
    // A bad timezone in YAML must not be able to stop the pipeline.
    expect(() => wallClockAt(NOW, 'Not/AZone')).not.toThrow();
  });

  it('walks back over a month boundary', () => {
    expect(previousDay('2026-09-01')).toBe('2026-08-31');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('labels slots by time of day', () => {
    expect(slotLabelFor('08:00')).toBe('Morning');
    expect(slotLabelFor('13:30')).toBe('Afternoon');
    expect(slotLabelFor('20:00')).toBe('Evening');
  });

  it('assigns a slot that has not happened yet today to yesterday', () => {
    const { config } = testDb();
    briefingConfig(config);
    // At 10:00, 08:00 was two hours ago and 20:00 was fourteen hours ago —
    // yesterday evening's, not tonight's.
    const [first, second] = recentSlots(config.briefing, NOW);
    expect(first).toMatchObject({ time: '08:00', localDay: '2026-08-23', latenessMinutes: 120 });
    expect(second).toMatchObject({ time: '20:00', localDay: '2026-08-22', latenessMinutes: 840 });
  });

  it('offers only the most recent slot, never a backlog of missed ones', () => {
    const { config } = testDb();
    briefingConfig(config);
    // A Mac asleep since Friday must not wake and deliver four digests at once:
    // each would summarise a window the next one has already covered.
    const { slot } = dueSlot(config.briefing, NOW, () => false);
    expect(slot?.time).toBe('08:00');
    expect(slot?.localDay).toBe('2026-08-23');
  });

  it('skips a slot that is too late rather than publishing stale news', () => {
    const { config } = testDb();
    briefingConfig(config);
    // 19:00, so the 08:00 slot is eleven hours late and 20:00 has not arrived.
    const late = Date.UTC(2026, 7, 23, 19, 0);
    const { slot, reason } = dueSlot(config.briefing, late, () => false);
    expect(slot).toBeNull();
    expect(reason).toContain('skipped');
  });

  it('does not rebuild a slot that has already been published', () => {
    const { config } = testDb();
    briefingConfig(config);
    const { slot, reason } = dueSlot(config.briefing, NOW, () => true);
    expect(slot).toBeNull();
    expect(reason).toContain('already published');
  });

  it('bounds the window by age as well as by the slot gap', () => {
    const { config } = testDb();
    briefingConfig(config);
    const slot = recentSlots(config.briefing, NOW)[0]!;
    config.briefing.selection.window_hours = 14;
    config.briefing.selection.max_age_hours = 6;
    // The age limit wins, so the first run after a long outage cannot present a
    // two-day-old front page as today's news.
    expect(windowStartFor(config, slot, NOW)).toBe(NOW - 6 * HOUR_MS);
  });
});

describe('briefing selection', () => {
  it('takes the top items by relevance and numbers them', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    config.briefing.selection.items = 3;
    for (const [index, title] of ['Most relevant', 'Middling', 'Least', 'Spare'].entries()) {
      seedCandidate(db, {
        title,
        clusterId: `c${index}`,
        scores: { personal_interest: 0.9 - index * 0.15 },
      });
    }

    const { lines } = selectBriefingLines(db, config, NOW - 14 * HOUR_MS, NOW);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.title)).toEqual(['Most relevant', 'Middling', 'Least']);
    expect(lines.map((line) => line.rank)).toEqual([1, 2, 3]);
    db.close();
  });

  /**
   * A digest is the format where ten takes on one announcement is most obviously
   * a failure, and it is also the format where it is most likely: the whole
   * point is to catch the day's biggest stories, which are exactly the ones
   * every publisher covers at once.
   */
  it('allows one line per story, however many outlets covered it', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedCandidate(db, { title: 'The announcement', clusterId: 'same-story', scores: { personal_interest: 0.9 } });
    seedCandidate(db, { title: 'The same announcement', sourceId: 'kottke', clusterId: 'same-story' });
    seedCandidate(db, { title: 'The same announcement again', sourceId: 'simon_willison', clusterId: 'same-story' });
    seedCandidate(db, { title: 'Something else', clusterId: 'other-story' });

    const { lines } = selectBriefingLines(db, config, NOW - 14 * HOUR_MS, NOW);
    expect(lines.map((line) => line.title)).toEqual(['The announcement', 'Something else']);
    db.close();
  });

  it('caps how much of a briefing one publisher can be', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    config.briefing.selection.max_per_source = 2;
    for (let i = 0; i < 5; i += 1) {
      seedCandidate(db, { title: `Quanta story ${i}`, clusterId: `q${i}` });
    }
    const { lines } = selectBriefingLines(db, config, NOW - 14 * HOUR_MS, NOW);
    expect(lines).toHaveLength(2);
    db.close();
  });

  /**
   * Appearing in a briefing is being shown to the reader, so the rule that
   * audit samples are measured and never surfaced applies here too. Without it
   * the false-negative rate stops meaning anything: the sample would have been
   * read.
   */
  it('never puts an audit sample in a briefing', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedCandidate(db, { title: 'A sampled reject', clusterId: 'a', audit: true, scores: { personal_interest: 1 } });
    seedCandidate(db, { title: 'A real candidate', clusterId: 'b' });

    const { lines } = selectBriefingLines(db, config, NOW - 14 * HOUR_MS, NOW);
    expect(lines.map((line) => line.title)).toEqual(['A real candidate']);
    db.close();
  });

  it('ignores anything published before the window', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedCandidate(db, { title: 'Recent', clusterId: 'a', hoursAgo: 2 });
    seedCandidate(db, { title: 'Yesterday', clusterId: 'b', hoursAgo: 30 });

    const { lines } = selectBriefingLines(db, config, NOW - 14 * HOUR_MS, NOW);
    expect(lines.map((line) => line.title)).toEqual(['Recent']);
    db.close();
  });

  it('applies the feed’s gates, so a briefing cannot be ten pieces of ragebait', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedCandidate(db, { title: 'Furious take', clusterId: 'a', scores: { ragebait: 0.8, personal_interest: 1 } });
    seedCandidate(db, { title: 'Calm report', clusterId: 'b' });

    const { lines } = selectBriefingLines(db, config, NOW - 14 * HOUR_MS, NOW);
    expect(lines.map((line) => line.title)).toEqual(['Calm report']);
    db.close();
  });

  it('prefers the publisher’s own words for the summary', () => {
    const { config } = testDb();
    briefingConfig(config);
    const both = briefingSummary(
      { rss_summary: 'What the publisher said.', subtitle: null, why_it_surfaced: 'Why you care.' },
      config,
    );
    expect(both).toEqual({ summary: 'What the publisher said.', source: 'rss_summary' });

    // Sift writes no summaries of its own, so when the publisher supplied none
    // the fallback is Terra's reason -- text already shown to readers under
    // "Why this surfaced" in every other feed.
    const fallback = briefingSummary(
      { rss_summary: null, subtitle: null, why_it_surfaced: 'Why you care.' },
      config,
    );
    expect(fallback).toEqual({ summary: 'Why you care.', source: 'why_it_surfaced' });

    const neither = briefingSummary({ rss_summary: null, subtitle: null, why_it_surfaced: null }, config);
    expect(neither.summary).toBe('');
  });

  it('truncates a long summary to the configured length', () => {
    const { config } = testDb();
    briefingConfig(config);
    config.briefing.summary.max_chars = 40;
    const { summary } = briefingSummary(
      { rss_summary: 'x'.repeat(200), subtitle: null, why_it_surfaced: null },
      config,
    );
    expect(summary.length).toBeLessThanOrEqual(41); // truncate() appends an ellipsis
  });
});

describe('building an edition', () => {
  function seedTen(db: ReturnType<typeof testDb>['db']): void {
    for (let i = 0; i < 10; i += 1) {
      seedCandidate(db, {
        title: `Story ${i}`,
        clusterId: `cluster-${i}`,
        // All publishable: a paywalled or mixed-access source is not a
        // candidate for any feed, so seeding one here would quietly shrink the
        // edition and make the count assertions below meaningless.
        sourceId: ['quanta', 'kottke', 'simon_willison', 'knowable'][i % 4],
        scores: { personal_interest: 0.9 - i * 0.01 },
      });
    }
  }

  it('publishes the due slot once and is safe to run again', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedTen(db);

    const first = runBriefing(db, config, { now: NOW });
    expect(first.built).toBe(true);
    expect(first.slot).toBe('0800');
    expect(first.selected).toBe(10);

    // The scheduler checks every five minutes and the pipeline checks again on
    // each run, so this happens constantly in normal operation.
    const second = runBriefing(db, config, { now: NOW + 60_000 });
    expect(second.built).toBe(false);
    expect(second.reason).toContain('already published');
    expect(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM briefing_editions`)?.c).toBe(1);
    db.close();
  });

  /**
   * The invariant the briefing's separate tables exist for.
   *
   * publishEdition and publishClassics both skip any item already in
   * published_feed_items. If the briefing wrote its lines there, a mention on
   * line seven of the morning digest would permanently disqualify that article
   * from Essential -- the briefing would quietly consume the feeds it is meant
   * to summarise.
   */
  it('does not consume the articles it lists', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedTen(db);

    const before = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items`)?.c ?? 0;
    const result = runBriefing(db, config, { now: NOW });
    expect(result.built).toBe(true);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items`)?.c).toBe(before);

    // And the same articles still reach the ordinary feeds afterwards.
    const edition = publishEditions(db, config, NOW);
    expect(edition.published).toBeGreaterThan(0);
    const briefed = new Set(result.lines.map((line) => line.itemId));
    const published = db
      .all<{ item_id: string }>(`SELECT item_id FROM published_feed_items`)
      .map((row) => row.item_id);
    expect(published.some((id) => briefed.has(id))).toBe(true);
    db.close();
  });

  it('leaves the slot unbuilt rather than publishing a two-line “top ten”', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    config.briefing.selection.min_items = 4;
    seedCandidate(db, { title: 'The only thing', clusterId: 'a' });

    const result = runBriefing(db, config, { now: NOW });
    expect(result.built).toBe(false);
    expect(result.reason).toContain('left for the next one');
    // Nothing recorded, so these items return to the next briefing's window
    // instead of being spent on a digest not worth opening.
    expect(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM briefing_editions`)?.c).toBe(0);
    db.close();
  });

  it('does not repeat an item the previous briefing already carried', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    config.briefing.selection.min_items = 1;
    config.briefing.selection.items = 2;
    seedCandidate(db, { title: 'Carried this morning', clusterId: 'a', scores: { personal_interest: 0.95 } });
    seedCandidate(db, { title: 'Still fresh', clusterId: 'b', scores: { personal_interest: 0.6 } });

    const morning = runBriefing(db, config, { now: NOW });
    expect(morning.lines.map((line) => line.title)).toEqual(['Carried this morning', 'Still fresh']);

    // 20:00 the same day: a briefing is a record of what is new since the last
    // one, so nothing it already carried appears again.
    const evening = runBriefing(db, config, { now: Date.UTC(2026, 7, 23, 20, 30) });
    expect(evening.built).toBe(false);
    expect(evening.candidates).toBe(0);
    db.close();
  });

  it('writes nothing on a dry run', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedTen(db);
    const result = runBriefing(db, config, { now: NOW, dry: true });
    expect(result.selected).toBe(10);
    expect(result.built).toBe(false);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM briefing_editions`)?.c).toBe(0);
    db.close();
  });

  it('freezes each summary at build time', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    config.briefing.selection.min_items = 1;
    const id = seedCandidate(db, { title: 'A story', clusterId: 'a', summary: 'The original wording.' });
    runBriefing(db, config, { now: NOW });

    // An edition already delivered to a reader must not change underneath them
    // because a later extraction replaced the text it was built from.
    db.run(`UPDATE feed_items SET rss_summary = 'Rewritten later.' WHERE id = :id`, { id });
    const [edition] = loadBriefingEditions(db, config, 5);
    expect(edition!.lines[0]!.summary).toBe('The original wording.');
    db.close();
  });

  it('records the slot so hasEdition can see it', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    seedTen(db);
    const slot = recentSlots(config.briefing, NOW)[0]!;
    expect(hasEdition(db, config, slot)).toBe(false);
    runBriefing(db, config, { now: NOW });
    expect(hasEdition(db, config, slot)).toBe(true);
    db.close();
  });
});

describe('briefing feed output', () => {
  function published(): ReturnType<typeof testDb> {
    const context = testDb();
    briefingConfig(context.config);
    for (let i = 0; i < 4; i += 1) {
      seedCandidate(context.db, {
        title: `Headline ${i}`,
        clusterId: `cluster-${i}`,
        sourceId: ['quanta', 'kottke', 'simon_willison', 'knowable'][i]!,
        summary: `Summary ${i}.`,
        scores: { personal_interest: 0.9 - i * 0.01 },
      });
    }
    runBriefing(context.db, context.config, { now: NOW });
    return context;
  }

  it('renders one entry per edition, numbered, with a link and a summary each', () => {
    const { db, config } = published();
    const feed = config.briefing.feed;
    const { atom, entries } = renderFeedDocuments(db, config, feed, {
      tracked: true,
      publicUrl: 'https://sift.example',
      accessToken: 'secret-token',
    });

    // One entry for the whole slot, not one per article: that is what makes it
    // a briefing rather than a seventh topic feed.
    expect(entries).toBe(1);
    expect(atom.match(/<entry>/g)).toHaveLength(1);
    expect(atom).toContain('Morning briefing · Sun 23 August');
    for (const n of [1, 2, 3, 4]) expect(atom).toContain(`${n}. `);
    expect(atom).toContain('Summary 0.');
    expect(atom).toContain('Headline 3');
    db.close();
  });

  it('tracks the links inside the digest, so opens still teach it', () => {
    const { db, config } = published();
    const { atom, itemUrls } = renderFeedDocuments(db, config, config.briefing.feed, {
      tracked: true,
      publicUrl: 'https://sift.example',
      accessToken: 'secret-token',
    });

    expect(atom).toContain('/open/');
    expect(atom).toContain(`?feed=${config.briefing.feed.id}`);
    // No token on /open links: it would reach every publisher in the Referer.
    expect(atom).not.toContain('/open/secret-token');
    expect(atom.split('/open/')[1]).not.toContain('t=secret-token');

    // The Worker resolves /open/<id> from these keys, so a briefing missing
    // from the map would render four links that all 404 at the edge.
    expect(itemUrls.size).toBe(4);
    db.close();
  });

  it('uses an id that survives a rebuild of the same slot', () => {
    const { db, config } = published();
    const render = () =>
      renderFeedDocuments(db, config, config.briefing.feed, {
        tracked: false,
        publicUrl: 'https://sift.example',
        accessToken: '',
      }).atom;
    expect(render()).toContain('urn:sift:briefing:2026-08-23:0800');
    // Read state in Reeder is keyed on the entry id, so a forced rebuild must
    // not resurrect an edition the reader has already dismissed.
    runBriefing(db, config, { now: NOW, force: true });
    expect(render()).toContain('urn:sift:briefing:2026-08-23:0800');
    db.close();
  });

  it('serves valid RSS and JSON as well', () => {
    const { db, config } = published();
    const { rss, json } = renderFeedDocuments(db, config, config.briefing.feed, {
      tracked: false,
      publicUrl: 'https://sift.example',
      accessToken: '',
    });
    expect(rss).toContain('<rss version="2.0"');
    expect(rss.match(/<item>/g)).toHaveLength(1);

    const parsed = JSON.parse(json) as {
      items: Array<{ _sift: { lines: Array<{ rank: number; title: string }> } }>;
    };
    // Machine-readable lines, so a consumer that is not a reader app does not
    // have to parse the HTML back apart.
    expect(parsed.items[0]!._sift.lines.map((line) => line.rank)).toEqual([1, 2, 3, 4]);
    db.close();
  });

  it('is reachable at its own slug, and only for readers who kept it', async () => {
    const { db, config } = published();
    const app = createApp(db, config);

    const atom = await app.request('/feed/briefing.xml');
    expect(atom.status).toBe(200);
    expect(atom.headers.get('content-type')).toContain('application/atom+xml');
    expect(await atom.text()).toContain('Morning briefing');

    expect((await app.request('/feed/briefing.rss')).status).toBe(200);
    expect((await app.request('/feed/briefing.json')).status).toBe(200);
    // Listed on the index alongside everything else, so it can be copied out.
    expect(await (await app.request('/')).text()).toContain('/feed/briefing.xml');

    // A reader who declined it gets a 404, not an empty feed: the URL was never
    // theirs, and the app is built once per process from their own config.
    config.briefing.enabled = false;
    expect((await createApp(db, config).request('/feed/briefing.xml')).status).toBe(404);
    db.close();
  });

  it('renders an empty but valid feed before the first edition exists', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    const { atom, entries } = renderFeedDocuments(db, config, config.briefing.feed, {
      tracked: false,
      publicUrl: 'https://sift.example',
      accessToken: '',
    });
    // A reader who subscribes at 09:00 waits until 20:00 for the first edition.
    // An empty feed is correct; a crash or a 404 would look like a broken URL.
    expect(entries).toBe(0);
    expect(atom).toContain('<feed');
    expect(atom).not.toContain('<entry>');
    db.close();
  });
});

describe('both optional feeds can be declined', () => {
  it('lists the briefing only for a reader who kept it', () => {
    const { db, config } = testDb();
    briefingConfig(config);
    expect(allFeeds(config).map((feed) => feed.id)).toContain('briefing');

    config.briefing.enabled = false;
    expect(allFeeds(config).map((feed) => feed.id)).not.toContain('briefing');
    // And it builds nothing, so no reader can reach it by guessing the slug.
    expect(runBriefing(db, config, { now: NOW }).built).toBe(false);
    expect(runBriefing(db, config, { now: NOW }).reason).toContain('turned off');
    db.close();
  });

  it('lists Classics only for a reader who kept it', () => {
    const { config } = testDb();
    briefingConfig(config);
    expect(allFeeds(config).map((feed) => feed.id)).toContain('classics');
    config.classics.enabled = false;
    expect(allFeeds(config).map((feed) => feed.id)).not.toContain('classics');
  });

  /**
   * `classics.enabled` used to be checked inside discoverClassics alone, so a
   * reader who declined the lane still had their existing candidate pool
   * evaluated -- real spend -- and still received a Classic a day from it. The
   * switch only stopped Sift looking for new ones.
   */
  it('turning Classics off stops evaluation and publishing, not just discovery', async () => {
    const { db, config } = testDb();
    briefingConfig(config);
    config.classics.enabled = false;
    const ai = new AiClient(config, db, 'test-job');
    const result = await runClassics(db, config, ai, { now: NOW });
    expect(result.evaluation.evaluated).toBe(0);
    expect(result.evaluation.spendUsd).toBe(0);
    expect(result.publication.published).toBe(0);
    expect(result.publication.reason).toContain('turned off');
    db.close();
  });

  it('defaults both lanes on for a reader who set no preference', () => {
    const { config } = testDb();
    expect(config.taste.reader_preferences.optional_feeds).toEqual({ briefing: true, classics: true });
  });
});
