import { describe, expect, it } from 'vitest';
import { inspectClassicHtml } from '../src/classics/evaluate.js';
import { publishClassics, topClassicCandidates } from '../src/classics/index.js';
import { createApp } from '../src/server/app.js';
import { loadFeedItems, renderAtomFeed, renderJsonFeed } from '../src/server/renderFeed.js';
import { testDb, seedItem } from './helpers.js';

function seedClassic(
  db: ReturnType<typeof testDb>['db'],
  opts: {
    title: string;
    url: string;
    score?: number;
    predictedRead?: number;
    predictedPayoff?: number;
    category?: string;
  },
): string {
  const id = seedItem(db, {
    sourceId: 'classics_archive',
    title: opts.title,
    url: opts.url,
    publishedAt: Date.UTC(2013, 4, 14),
    status: 'classics_discovered',
  });
  db.run(
    `INSERT INTO classics_candidates (
       item_id, source_name, original_author, original_published_at,
       best_discovery_source, discovery_sources_json, historical_signal,
       status, first_discovered_at, updated_at)
     VALUES (:id, 'Some Magazine', 'Jane Writer', :published, 'hn_archive',
             '["hn_archive","longreads_archive"]', 0.9, 'evaluated', :now, :now)`,
    { id, published: Date.UTC(2013, 4, 14), now: Date.now() },
  );
  db.run(
    `INSERT INTO classics_evaluations (
       item_id, analysis, storytelling, authorial_voice, entertainment,
       obsessive_expertise, rabbit_hole, critique, humor, enduring_value,
       personal_interest, historical_quality, homework, datedness, ragebait,
       predicted_read, predicted_payoff, predicted_satisfaction,
       archival_score, category, pleasure_class,
       why_picked, enduring_reason, model, prompt_version, config_hash, created_at)
     VALUES (:id, .95, .96, .91, .94, .9, .96, .82, .7, .95, .55, .85,
             .02, .01, .01, :predictedRead, :predictedPayoff, :satisfaction,
             :score, :category, 'corporate disaster',
             'A dryly funny disaster whose incentives make every bad decision inevitable.',
             'The mechanism and characters still work.', 'test', 'classics-ranking-v2',
             'test', :now)`,
    {
      id,
      predictedRead: opts.predictedRead ?? 0.95,
      predictedPayoff: opts.predictedPayoff ?? 0.95,
      satisfaction: Math.sqrt((opts.predictedRead ?? 0.95) * (opts.predictedPayoff ?? 0.95)),
      score: opts.score ?? 0.93,
      category: opts.category ?? 'business_economics',
      now: Date.now(),
    },
  );
  return id;
}

describe('Classics eligibility', () => {
  const prose =
    'The company was built around an incentive that looked sensible at first, but every person who followed it made the system stranger. ';

  it('accepts a full English article and rejects explicit paid metadata', () => {
    const free = inspectClassicHtml(
      `<html><head><title>The Strange Company</title><script type="application/ld+json">` +
        `{"@type":"Article","isAccessibleForFree":true}</script></head>` +
        `<body><article><h1>The Strange Company</h1><p>${prose.repeat(35)}</p></article></body></html>`,
      'https://example.com/story',
      2_500,
    );
    expect(free).toEqual({ readable: true, explicitlyFree: true, english: true });

    const paid = inspectClassicHtml(
      `<html><head><script type="application/ld+json">` +
        `{"@type":"NewsArticle","isAccessibleForFree":false}</script></head>` +
        `<body><article><p>${prose.repeat(35)}</p></article></body></html>`,
      'https://example.com/paid',
      2_500,
    );
    expect(paid.explicitlyFree).toBe(false);
  });
});

describe('Classics publishing and output', () => {
  it('publishes at most one qualifying article per day and keeps persistent history', () => {
    const { db, config } = testDb();
    const first = seedClassic(db, { title: 'The Strange Story of X', url: 'https://one.example/archive/x' });
    seedClassic(db, { title: 'The Stranger Story of Y', url: 'https://two.example/archive/y', score: 0.92 });
    const now = Date.UTC(2026, 7, 22, 9);

    expect(publishClassics(db, config, now).itemIds).toEqual([first]);
    expect(publishClassics(db, config, now + 3_600_000).published).toBe(0);
    expect(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE feed_id='classics'`)?.c).toBe(1);
    db.close();
  });

  it('requires both sufficient start probability and exceptional expected payoff', () => {
    const { db, config } = testDb();
    seedClassic(db, {
      title: 'Clickable but disappointing',
      url: 'https://click.example/archive/x',
      predictedRead: 0.98,
      predictedPayoff: 0.70,
    });
    seedClassic(db, {
      title: 'Excellent but forbidding homework',
      url: 'https://homework.example/archive/y',
      predictedRead: 0.60,
      predictedPayoff: 0.98,
    });

    expect(publishClassics(db, config, Date.UTC(2026, 7, 22, 9)).published).toBe(0);
    db.close();
  });

  it('uses recommendation time for ordering while displaying the original date', async () => {
    const { db, config } = testDb();
    seedClassic(db, { title: 'The Strange Story of X', url: 'https://one.example/archive/x' });
    const recommendedAt = Date.UTC(2026, 7, 22, 9);
    publishClassics(db, config, recommendedAt);
    const items = loadFeedItems(db, 'classics', 60);
    const options = { tracked: true, publicUrl: 'https://sift.example', accessToken: '' };

    const atom = renderAtomFeed(db, config, config.classics.feed, items, options);
    expect(atom).toContain(`<published>${new Date(recommendedAt).toISOString()}</published>`);
    expect(atom).toContain('Originally published: May 14, 2013');
    expect(atom).toContain('⭐ Sift Classics');

    const json = JSON.parse(renderJsonFeed(db, config, config.classics.feed, items, options)) as {
      items: Array<{ date_published: string; _sift: { original_published_at: string } }>;
    };
    expect(json.items[0]?.date_published).toBe(new Date(recommendedAt).toISOString());
    expect(json.items[0]?._sift.original_published_at).toBe(new Date(Date.UTC(2013, 4, 14)).toISOString());

    const app = createApp(db, { ...config, env: { ...config.env, accessToken: '' } });
    expect((await app.request('/feed/classics.json')).headers.get('content-type')).toContain('feed+json');
    db.close();
  });

  it('reports discovery provenance and passed access state for calibration', () => {
    const { db } = testDb();
    seedClassic(db, { title: 'The Strange Story of X', url: 'https://one.example/archive/x' });
    const [candidate] = topClassicCandidates(db, 20);
    expect(candidate?.discoverySources).toContain('hn_archive');
    expect(candidate?.accessCheck).toBe('passed');
    expect(candidate?.score).toBeCloseTo(0.93);
    db.close();
  });
});
