import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { renderAtomFeed, renderRssFeed, loadFeedItems } from '../src/server/renderFeed.js';
import { createApp } from '../src/server/app.js';
import { routeAndPublish } from '../src/route/index.js';
import { parseFeed } from '../src/ingest/parseFeed.js';
import { testDb, seedItem, seedDeepEvaluation } from './helpers.js';
import { stableId } from '../src/util/hash.js';

const strong = {
  personal_interest: 0.95,
  intellectual_depth: 0.95,
  novelty: 0.9,
  practical_usefulness: 0.85,
  entertainment: 0.8,
  source_quality: 0.9,
  expected_attention_value: 0.95,
  ragebait: 0.01,
  duplicate_information: 0.02,
};

function setup() {
  const { db, config } = testDb();
  const id = seedItem(db, {
    sourceId: 'simon_willison',
    title: 'A persistent-memory pattern for agents & why it matters <today>',
    url: 'https://simonwillison.net/2026/agents-memory',
    summary: 'The publisher\'s own summary of the piece.',
  });
  seedDeepEvaluation(db, id, {
    ...strong,
    category: 'ai_product',
    why: 'Explains a persistent-memory interaction pattern and its consequences for chat UX.',
  });
  routeAndPublish(db, config);
  return { db, config, id };
}

const options = { tracked: true, publicUrl: 'https://sift.example', accessToken: 'secret-token' };

describe('Atom output', () => {
  it('is well-formed XML that a feed parser can read back', () => {
    const { db, config, id } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);

    const reparsed = parseFeed(xml, 'https://sift.example/feed/ai-product.xml');
    expect(reparsed.kind).toBe('atom');
    expect(reparsed.items).toHaveLength(1);
    expect(reparsed.items[0]!.title).toContain('persistent-memory pattern');
    expect(id).toBeTruthy();
    db.close();
  });

  it('escapes characters that would otherwise break the document', () => {
    const { db, config } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);

    // The raw title contains & and angle brackets; neither may appear unescaped.
    expect(xml).not.toMatch(/<title type="text">[^<]*<today>/);
    expect(xml).toContain('&amp;');
    const strict = new XMLParser({ ignoreAttributes: false });
    expect(() => strict.parse(xml)).not.toThrow();
    db.close();
  });

  it('keeps the original publisher prominent', () => {
    const { db, config } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    expect(xml).toContain('Simon Willison');
    expect(xml).toContain('<source>');
    db.close();
  });

  it('includes the why-it-surfaced explanation', () => {
    const { db, config } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    expect(xml).toContain('Why this surfaced');
    expect(xml).toContain('persistent-memory interaction pattern');
    db.close();
  });

  it('routes links through the tracked redirect when enabled', () => {
    const { db, config, id } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    expect(xml).toContain(`https://sift.example/open/${id}`);

    const untracked = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), {
      ...options,
      tracked: false,
    });
    expect(untracked).toContain('https://simonwillison.net/2026/agents-memory');
    expect(untracked).not.toContain('/open/');
    db.close();
  });

  it('uses a stable entry id so read state survives regeneration', () => {
    const { db, config, id } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const a = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    const b = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    expect(a).toContain(`urn:sift:item:${id}`);
    expect(a).toBe(b);
    db.close();
  });

  it('renders an empty feed without breaking', () => {
    const { db, config } = testDb();
    const feed = config.feeds.find((f) => f.id === 'essential')!;
    const xml = renderAtomFeed(db, config, feed, [], options);
    const strict = new XMLParser({ ignoreAttributes: false });
    expect(() => strict.parse(xml)).not.toThrow();
    expect(parseFeed(xml).items).toHaveLength(0);
    db.close();
  });

  it('surfaces a podcast match as a listen line, not a separate item', () => {
    const { db, config, id } = setup();
    db.run(
      `INSERT INTO alternate_formats (id, item_id, format_type, url, title, publisher, duration_minutes,
                                      confidence, signals_json, spotify_url, created_at)
       VALUES (:id, :item, 'podcast_version', 'https://cdn.example/ep.mp3', 'Episode 12', 'The Show', 42,
               0.95, '{}', 'https://open.spotify.com/search/Episode%2012', :ts)`,
      { id: stableId('alt', 'test'), item: id, ts: Date.now() },
    );

    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderAtomFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    expect(xml).toContain('Listen instead');
    expect(xml).toContain('42 min');
    expect(xml).toContain('open.spotify.com');
    expect(xml).toContain('rel="enclosure"');
    // Still exactly one entry: the audio is part of the article's entry.
    expect(parseFeed(xml).items).toHaveLength(1);
    db.close();
  });
});

describe('RSS output', () => {
  it('produces valid RSS 2.0 as an alternative', () => {
    const { db, config } = setup();
    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const xml = renderRssFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    const reparsed = parseFeed(xml);
    expect(reparsed.kind).toBe('rss');
    expect(reparsed.items).toHaveLength(1);
    db.close();
  });

  it('preserves the publisher images in the generated feed', () => {
    const { db, config } = testDb();
    const id = seedItem(db, {
      sourceId: 'simon_willison',
      title: 'An English illustrated article about a new agent interface',
      images: [
        { url: 'https://publisher.example/hero.jpg', alt: 'Agent interface', caption: 'The main interface' },
        { url: 'https://publisher.example/diagram.png', alt: 'Interaction diagram' },
      ],
    });
    seedDeepEvaluation(db, id, { ...strong, category: 'ai_product' });
    routeAndPublish(db, config);

    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const items = loadFeedItems(db, feed.id, 60);
    const atom = renderAtomFeed(db, config, feed, items, options);
    const rss = renderRssFeed(db, config, feed, items, options);

    expect(atom).toContain('https://publisher.example/hero.jpg');
    expect(atom).toContain('https://publisher.example/diagram.png');
    expect(atom).toContain('The main interface');
    expect(rss).toContain('<media:content url="https://publisher.example/hero.jpg"');
    db.close();
  });

  it('labels Product Hunt entries as product discovery cards', () => {
    const { db, config } = testDb();
    const id = seedItem(db, {
      sourceId: 'product_hunt',
      title: 'A new English product for exploring personal knowledge',
      itemKind: 'product',
    });
    seedDeepEvaluation(db, id, { ...strong, category: 'ai_product' });
    routeAndPublish(db, config);

    const feed = config.feeds.find((f) => f.id === 'ai_product')!;
    const rss = renderRssFeed(db, config, feed, loadFeedItems(db, feed.id, 60), options);
    expect(rss).toContain('Product discovery');
    db.close();
  });
});

describe('HTTP endpoints', () => {
  it('serves a feed and records an open on redirect', async () => {
    const { db, config, id } = setup();
    // Local development token means no gate; that is the documented behaviour.
    const app = createApp(db, { ...config, env: { ...config.env, accessToken: '' } });

    const feedRes = await app.request('/feed/ai-product.xml');
    expect(feedRes.status).toBe(200);
    expect(feedRes.headers.get('content-type')).toContain('atom');
    expect(await feedRes.text()).toContain('persistent-memory');

    const openRes = await app.request(`/open/${id}?feed=ai_product`);
    expect(openRes.status).toBe(302);
    expect(openRes.headers.get('location')).toBe('https://simonwillison.net/2026/agents-memory');

    const opens = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM open_events WHERE item_id = :id`, { id });
    expect(opens?.c).toBe(1);
    db.close();
  });

  it('does not double-count repeated opens on the same day', async () => {
    const { db, config, id } = setup();
    const app = createApp(db, { ...config, env: { ...config.env, accessToken: '' } });
    await app.request(`/open/${id}?feed=ai_product`);
    await app.request(`/open/${id}?feed=ai_product`);
    await app.request(`/open/${id}?feed=ai_product`);
    const opens = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM open_events WHERE item_id = :id`, { id });
    expect(opens?.c).toBe(1);
    db.close();
  });

  it('404s an unknown item rather than redirecting anywhere', async () => {
    const { db, config } = setup();
    const app = createApp(db, { ...config, env: { ...config.env, accessToken: '' } });
    const res = await app.request('/open/does-not-exist');
    expect(res.status).toBe(404);
    db.close();
  });

  it('hides feeds and admin behind the access token when one is set', async () => {
    const { db, config } = setup();
    const app = createApp(db, { ...config, env: { ...config.env, accessToken: 'secret-token' } });

    expect((await app.request('/feed/ai-product.xml')).status).toBe(404);
    expect((await app.request('/feed/ai-product.xml?t=wrong')).status).toBe(404);
    expect((await app.request('/feed/ai-product.xml?t=secret-token')).status).toBe(200);
    expect((await app.request('/admin')).status).toBe(404);
    expect((await app.request('/admin?t=secret-token')).status).toBe(200);

    // Tracked opens stay reachable: the reader app follows these links.
    const id = db.get<{ item_id: string }>(`SELECT item_id FROM published_feed_items LIMIT 1`)?.item_id;
    expect((await app.request(`/open/${id}`)).status).toBe(302);
    db.close();
  });

  it('serves the admin item view for a real item', async () => {
    const { db, config, id } = setup();
    const app = createApp(db, { ...config, env: { ...config.env, accessToken: '' } });
    const res = await app.request(`/admin/item/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Every stage of the funnel is inspectable from one page.
    expect(html).toContain('Stage 2 — rule filter');
    expect(html).toContain('Stage 3 — free score');
    expect(html).toContain('Stage 4 — Luna');
    expect(html).toContain('Stage 5 — Terra');
    expect(html).toContain('Stage 6 — final ranking, per feed');
    expect(html).toContain('ai_product');
    db.close();
  });
});

/**
 * Regression: the rel="self" link was rendered without the access token while
 * every feed endpoint is token-gated, so following it returned 404. Readers that
 * refresh from rel="self" rather than the subscribed URL would have silently
 * lost the feed.
 */
describe('self link is actually fetchable', () => {
  it('carries the access token in Atom', () => {
    const { db, config } = testDb();
    const xml = renderAtomFeed(db, config, config.feeds[0]!, [], {
      publicUrl: 'https://x.example',
      accessToken: 'secret-token',
      tracked: true,
    });
    const self = xml.match(/<link rel="self"[^>]*href="([^"]+)"/)?.[1];
    expect(self).toContain('t=secret-token');
  });

  it('carries the access token in RSS', () => {
    const { db, config } = testDb();
    const xml = renderRssFeed(db, config, config.feeds[0]!, [], {
      publicUrl: 'https://x.example',
      accessToken: 'secret-token',
      tracked: true,
    });
    const self = xml.match(/<atom:link rel="self"[^>]*href="([^"]+)"/)?.[1];
    expect(self).toContain('t=secret-token');
  });

  it('omits the query entirely when no token is configured', () => {
    const { db, config } = testDb();
    const xml = renderAtomFeed(db, config, config.feeds[0]!, [], {
      publicUrl: 'https://x.example',
      accessToken: '',
      tracked: true,
    });
    expect(xml.match(/<link rel="self"[^>]*href="([^"]+)"/)?.[1]).not.toContain('?t=');
  });
});
