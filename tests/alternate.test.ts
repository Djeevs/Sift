import { describe, it, expect } from 'vitest';
import {
  scoreEpisodeMatch,
  resolveAlternateFormats,
  spotifyEpisodeLink,
  suppressDuplicateEpisodes,
  alternatesForItem,
} from '../src/alternate/index.js';
import { extractFromHtml, parseIso8601Duration } from '../src/extract/index.js';
import { loadConfig } from '../src/config/index.js';
import { testDb, seedItem, seedVector, seedDeepEvaluation } from './helpers.js';
import { routeAndPublish } from '../src/route/index.js';
import { HOUR_MS } from '../src/util/time.js';

const config = loadConfig();
const MODEL = 'test-embed';

describe('scoreEpisodeMatch', () => {
  const article = {
    title: 'How the Dutch railway timetable is actually computed',
    canonicalUrl: 'https://example.com/railway-timetable',
    publishedAt: Date.now(),
    sourceName: 'Works in Progress',
  };

  it('is highly confident when the episode links the article', () => {
    const result = scoreEpisodeMatch(
      article,
      {
        title: 'Episode 42: timetables',
        description: 'We discuss the piece at https://example.com/railway-timetable in detail.',
        publisher: 'Works in Progress Podcast',
        publishedAt: Date.now(),
      },
      null,
      config,
    );
    expect(result.confidence).toBeGreaterThanOrEqual(config.pipeline.alternate_formats.min_confidence);
    expect(result.signals).toHaveProperty('url_mentioned_in_episode');
  });

  it('combines title, publisher and date signals', () => {
    const result = scoreEpisodeMatch(
      article,
      {
        title: 'How the Dutch railway timetable is actually computed',
        description: 'A conversation about railways.',
        publisher: 'Works in Progress',
        publishedAt: Date.now() - 2 * HOUR_MS,
      },
      0.93,
      config,
    );
    expect(result.signals).toHaveProperty('title_match');
    expect(result.signals).toHaveProperty('publisher_match');
    expect(result.signals).toHaveProperty('semantic_similarity');
    expect(result.confidence).toBeGreaterThanOrEqual(config.pipeline.alternate_formats.min_confidence);
  });

  it('stays below the threshold for an unrelated episode', () => {
    const result = scoreEpisodeMatch(
      article,
      {
        title: 'Episode 12: the history of the shipping container',
        description: 'Nothing to do with the above.',
        publisher: '99% Invisible',
        publishedAt: Date.now(),
      },
      0.2,
      config,
    );
    expect(result.confidence).toBeLessThan(config.pipeline.alternate_formats.min_confidence);
  });

  it('penalises episodes published far from the article', () => {
    const near = scoreEpisodeMatch(
      article,
      { title: article.title, description: '', publisher: 'Works in Progress', publishedAt: Date.now() },
      null,
      config,
    );
    const far = scoreEpisodeMatch(
      article,
      {
        title: article.title,
        description: '',
        publisher: 'Works in Progress',
        publishedAt: Date.now() - 400 * HOUR_MS,
      },
      null,
      config,
    );
    expect(far.confidence).toBeLessThan(near.confidence);
    expect(far.signals).toHaveProperty('date_too_far');
  });
});

describe('spotifyEpisodeLink', () => {
  it('builds a plain public search deeplink', () => {
    const url = spotifyEpisodeLink('Episode 42: timetables', 'Works in Progress');
    expect(url).toContain('https://open.spotify.com/search/');
    expect(url).toContain(encodeURIComponent('Episode 42'));
  });

  it('returns null with nothing to search for', () => {
    expect(spotifyEpisodeLink(null, null)).toBeNull();
  });
});

describe('extractFromHtml: audio discovery', () => {
  it('finds a podcast episode declared in JSON-LD', () => {
    const html = `<!doctype html><html><head><title>A piece</title>
      <script type="application/ld+json">{
        "@type": "PodcastEpisode",
        "name": "Episode 12: On Cities",
        "contentUrl": "https://cdn.example/12.mp3",
        "duration": "PT42M10S",
        "publisher": {"@type": "Organization", "name": "The Show"}
      }</script></head>
      <body><article><p>${'Real article text. '.repeat(60)}</p></article></body></html>`;

    const result = extractFromHtml(html, 'https://example.com/piece');
    const audio = result.audioLinks.find((a) => a.kind === 'structured_data');
    expect(audio?.url).toBe('https://cdn.example/12.mp3');
    expect(audio?.durationMinutes).toBe(42);
    expect(audio?.publisher).toBe('The Show');
  });

  it('finds an audio element and an embedded player', () => {
    const html = `<!doctype html><html><body>
      <audio src="/audio/version.mp3"></audio>
      <iframe src="https://open.spotify.com/embed/episode/abc123"></iframe>
      <article><p>${'Body text here. '.repeat(60)}</p></article></body></html>`;

    const result = extractFromHtml(html, 'https://example.com/piece');
    expect(result.audioLinks.some((a) => a.url.endsWith('/audio/version.mp3'))).toBe(true);
    expect(result.audioLinks.some((a) => a.platform === 'spotify' && a.kind === 'embed')).toBe(true);
  });

  it('ignores a generic site-footer podcast link', () => {
    const html = `<!doctype html><html><body>
      <article><p>${'Body text here. '.repeat(60)}</p></article>
      <footer><a href="https://open.spotify.com/show/xyz">Our shows</a></footer></body></html>`;
    const result = extractFromHtml(html, 'https://example.com/piece');
    expect(result.audioLinks).toHaveLength(0);
  });

  it('strips navigation and cookie boilerplate from the body', () => {
    const html = `<!doctype html><html><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <div>Accept all cookies</div>
      <article><h1>The real title</h1><p>${'Substantive paragraph text. '.repeat(60)}</p></article>
      <aside>Related stories</aside>
      <footer>Copyright 2026 All rights reserved</footer></body></html>`;

    const result = extractFromHtml(html, 'https://example.com/piece');
    expect(result.bodyText).toContain('Substantive paragraph');
    expect(result.bodyText).not.toMatch(/Accept all cookies/);
    expect(result.bodyText).not.toMatch(/All rights reserved/);
  });

  it('never throws on broken HTML', () => {
    for (const html of ['', '<html', '<!doctype html><body><p>unclosed', '<script>bad(</script>']) {
      expect(() => extractFromHtml(html, 'https://example.com/x')).not.toThrow();
    }
  });
});

describe('parseIso8601Duration', () => {
  it('handles the formats publishers actually use', () => {
    expect(parseIso8601Duration('PT42M10S')).toBe(42);
    expect(parseIso8601Duration('PT1H2M')).toBe(62);
    expect(parseIso8601Duration('PT30S')).toBe(1);
    expect(parseIso8601Duration('nonsense')).toBeNull();
    expect(parseIso8601Duration(undefined)).toBeNull();
  });
});

describe('resolveAlternateFormats', () => {
  it('matches a published article to an ingested podcast episode', () => {
    const { db, config: cfg } = testDb();
    const shared = 'the design history of the humble revolving door and its inventors';

    const article = seedItem(db, {
      sourceId: 'kottke',
      title: 'The design history of the revolving door',
      url: 'https://kottke.org/revolving-door',
    });
    seedVector(db, article, shared, MODEL);
    seedDeepEvaluation(db, article, { category: 'culture', expected_attention_value: 0.9 });
    routeAndPublish(db, cfg);

    const episode = seedItem(db, {
      sourceId: 'pod_99pi',
      title: 'The design history of the revolving door',
      url: 'https://99pi.example/ep/revolving-door',
      summary: 'This week: revolving doors. Read more at https://kottke.org/revolving-door',
      isPodcast: true,
      enclosureUrl: 'https://cdn.99pi.example/rev.mp3',
      enclosureType: 'audio/mpeg',
      durationMinutes: 38,
    });
    seedVector(db, episode, shared, MODEL);

    const stats = resolveAlternateFormats(db, cfg, MODEL);
    expect(stats.matchesFound).toBeGreaterThan(0);

    const alternates = alternatesForItem(db, article, cfg.pipeline.alternate_formats.min_confidence);
    expect(alternates.length).toBeGreaterThan(0);
    expect(alternates[0]!.duration_minutes).toBe(38);
    expect(alternates[0]!.spotify_url).toContain('open.spotify.com');
    db.close();
  });

  it('treats an item\'s own audio enclosure as its audio version', () => {
    const { db, config: cfg } = testDb();
    const id = seedItem(db, {
      sourceId: 'simon_willison',
      title: 'An essay with an audio narration',
      enclosureUrl: 'https://cdn.substack.com/audio.mp3',
      enclosureType: 'audio/mpeg',
      durationMinutes: 25,
    });
    seedDeepEvaluation(db, id, { category: 'ai_product', expected_attention_value: 0.9 });
    routeAndPublish(db, cfg);

    resolveAlternateFormats(db, cfg, MODEL);
    const alternates = alternatesForItem(db, id, 0.5);
    expect(alternates.some((a) => a.format_type === 'audio_version')).toBe(true);
    db.close();
  });

  it('does not invent matches where none exist', () => {
    const { db, config: cfg } = testDb();
    const article = seedItem(db, { sourceId: 'quanta', title: 'A result about prime gaps' });
    seedVector(db, article, 'prime gaps analytic number theory', MODEL);
    seedDeepEvaluation(db, article, { category: 'ideas_science', expected_attention_value: 0.9 });
    routeAndPublish(db, cfg);

    const episode = seedItem(db, {
      sourceId: 'pod_99pi',
      title: 'Episode 300: the history of neon signage',
      isPodcast: true,
      enclosureUrl: 'https://cdn.example/neon.mp3',
      enclosureType: 'audio/mpeg',
    });
    seedVector(db, episode, 'neon signage history design cities', MODEL);

    resolveAlternateFormats(db, cfg, MODEL);
    expect(alternatesForItem(db, article, cfg.pipeline.alternate_formats.min_confidence)).toHaveLength(0);
    db.close();
  });

  it('suppresses an episode that is already surfaced as an article\'s audio', () => {
    const { db, config: cfg } = testDb();
    const article = seedItem(db, { sourceId: 'kottke', title: 'A piece about doors' });
    const episode = seedItem(db, { sourceId: 'pod_99pi', title: 'A piece about doors', isPodcast: true });
    seedDeepEvaluation(db, article, { category: 'culture', expected_attention_value: 0.9 });
    routeAndPublish(db, cfg);

    db.run(
      `INSERT INTO alternate_formats (id, item_id, format_type, url, confidence, signals_json,
                                      source_episode_item_id, created_at)
       VALUES ('alt-1', :item, 'podcast_version', 'https://cdn.example/a.mp3', 0.9, '{}', :ep, :ts)`,
      { item: article, ep: episode, ts: Date.now() },
    );
    // Pretend the episode had also been published on its own.
    db.run(
      `INSERT INTO published_feed_items (feed_id, item_id, score, why_it_surfaced, published_at, day_key)
       VALUES ('culture', :id, 0.8, 'x', :ts, '2026-01-01')`,
      { id: episode, ts: Date.now() },
    );

    const suppressed = suppressDuplicateEpisodes(db);
    expect(suppressed).toBe(1);
    const remaining = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM published_feed_items WHERE item_id = :id`, {
      id: episode,
    });
    expect(remaining?.c).toBe(0);
    db.close();
  });

  it('is idempotent: rerunning does not duplicate matches', () => {
    const { db, config: cfg } = testDb();
    const id = seedItem(db, {
      sourceId: 'interconnects',
      title: 'An essay with narration',
      enclosureUrl: 'https://cdn.example/n.mp3',
      enclosureType: 'audio/mpeg',
    });
    seedDeepEvaluation(db, id, { category: 'ai_product', expected_attention_value: 0.9 });
    routeAndPublish(db, cfg);

    resolveAlternateFormats(db, cfg, MODEL, [id]);
    resolveAlternateFormats(db, cfg, MODEL, [id]);
    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM alternate_formats WHERE item_id = :id`, { id });
    expect(count?.c).toBe(1);
    db.close();
  });
});
