import type { SourceConfig } from '../config/index.js';
import { fetchText } from '../util/http.js';
import { mapPool } from '../util/pool.js';
import { collapseWhitespace, stripHtml } from '../util/text.js';
import type { ParsedItem } from './parseFeed.js';

interface HackerNewsStory {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  text?: string;
  url?: string;
  score?: number;
  title?: string;
  descendants?: number;
  deleted?: boolean;
  dead?: boolean;
}

/**
 * Convert the official HN API into a small set of original linked articles.
 * HN popularity is deliberately only a discovery signal; Sift's normal
 * language, access, extraction, and article-quality gates still apply.
 */
export async function fetchHackerNewsItems(
  source: SourceConfig,
  topStoriesJson: string,
  concurrency: number,
  now: number = Date.now(),
): Promise<ParsedItem[]> {
  const cfg = source.discovery;
  if (!cfg || cfg.type !== 'hacker_news') return [];

  let ids: number[];
  try {
    const parsed = JSON.parse(topStoriesJson) as unknown;
    ids = Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }

  const fetched = await mapPool(ids.slice(0, cfg.max_candidates), concurrency, async (id, rank) => {
    const response = await fetchText(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
      retries: 1,
      maxBytes: 250_000,
    });
    if (!response.ok) return null;
    try {
      return { story: JSON.parse(response.body) as HackerNewsStory, rank: rank + 1 };
    } catch {
      return null;
    }
  });

  const eligible: Array<{ story: HackerNewsStory; rank: number; ageHours: number; velocity: number; signal: number }> = [];
  for (const result of fetched) {
    if (!result.ok || !result.value) continue;
    const { story, rank } = result.value;
    if (story.deleted || story.dead || story.type !== 'story' || !story.url || !story.title || !story.time) continue;
    const ageHours = Math.max(0.25, (now - story.time * 1000) / 3_600_000);
    const points = story.score ?? 0;
    const comments = story.descendants ?? 0;
    const velocity = points / Math.pow(ageHours + 2, 0.72);
    const showHn = /^show hn:/i.test(story.title);
    if (ageHours > cfg.max_age_hours || points < cfg.min_points) continue;
    if (comments < cfg.min_comments && points < cfg.min_points * 2 && !showHn) continue;
    if (velocity < cfg.min_engagement_signal && !showHn) continue;

    // Centred at 0.5: ordinary HN traction neither helps nor hurts; unusually
    // strong points/comments relative to age can add only a small free-stage lift.
    const signal = Math.max(0, Math.min(1, 0.35 + velocity / 35 + Math.min(comments / 300, 0.2)));
    eligible.push({ story, rank, ageHours, velocity, signal });
  }

  eligible.sort((a, b) => b.signal - a.signal || a.rank - b.rank);
  return eligible.slice(0, cfg.max_items).map(({ story, rank, ageHours, velocity, signal }) => ({
    guid: `hn:${story.id}`,
    title: collapseWhitespace(stripHtml(story.title ?? '')),
    link: story.url ?? null,
    subtitle: null,
    summary: story.text ? collapseWhitespace(stripHtml(story.text)) : null,
    content: null,
    author: null,
    publishedAt: story.time ? story.time * 1000 : null,
    categories: /^show hn:/i.test(story.title ?? '') ? ['Show HN'] : [],
    enclosure: null,
    durationMinutes: null,
    images: [],
    language: null,
    extra: {
      discovery_source: 'hacker_news',
      hn_id: story.id,
      hn_submitter: story.by ?? null,
      hn_points: story.score ?? 0,
      hn_comment_count: story.descendants ?? 0,
      hn_age_hours: Number(ageHours.toFixed(2)),
      hn_rank: rank,
      hn_engagement_velocity: Number(velocity.toFixed(3)),
      discovery_signal: Number(signal.toFixed(3)),
      discussion_url: `https://news.ycombinator.com/item?id=${story.id}`,
    },
  }));
}

