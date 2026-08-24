import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { scoreForFeed, type DeepScores } from '../route/score.js';
import { collapseWhitespace, truncate } from '../util/text.js';
import { stableId } from '../util/hash.js';
import { HOUR_MS } from '../util/time.js';
import { logger } from '../util/log.js';
import { dueSlot, recentSlots, type BriefingSlot } from './schedule.js';

const log = logger('briefing');

export * from './schedule.js';

/**
 * The twice-daily briefing.
 *
 * One article per slot: the ten things worth knowing since the last one, each a
 * headline, a link and a short summary. It is a *view over* evaluations the
 * funnel already paid for, which gives it three properties worth stating
 * plainly, because each was a design decision rather than an accident:
 *
 *   1. It costs nothing. No model is called here. An item is only a candidate
 *      because Terra already evaluated it for the ordinary feeds.
 *   2. It does not compete for Terra's money. `terraOpportunity.ts` computes
 *      `feed_need` from `config.feeds` and deliberately does not know the
 *      briefing exists, so a briefing can never bid an article away from
 *      Essential.
 *   3. It does not consume items. Nothing here writes to
 *      `published_feed_items`, so appearing in a briefing leaves an article
 *      fully eligible for every other feed. Overlap is the intent: the briefing
 *      answers "what happened?", the feeds are the reading list.
 */

export interface BriefingLine {
  itemId: string;
  rank: number;
  score: number;
  title: string;
  url: string;
  sourceName: string;
  summary: string;
  summarySource: string;
}

export interface BriefingEdition {
  id: string;
  feedId: string;
  localDay: string;
  slot: string;
  slotLabel: string;
  scheduledFor: number;
  publishedAt: number;
  windowStart: number;
  lines: BriefingLine[];
}

export interface BriefingRunResult {
  built: boolean;
  reason: string;
  slot: string | null;
  localDay: string | null;
  candidates: number;
  eligible: number;
  selected: number;
  lines: BriefingLine[];
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  source_id: string;
  source_name: string;
  cluster_id: string | null;
  title: string;
  original_url: string | null;
  canonical_url: string | null;
  rss_summary: string | null;
  subtitle: string | null;
  why_it_surfaced: string | null;
  category: string | null;
  recommended_feeds_json: string;
  publication_time: number | null;
  personal_interest: number;
  intellectual_depth: number;
  novelty: number;
  practical_usefulness: number;
  entertainment: number;
  storytelling: number;
  authorial_voice: number;
  critique: number;
  humor: number;
  obsessive_expertise: number;
  rabbit_hole: number;
  delight: number;
  headline_sufficiency: number;
  source_quality: number;
  serendipity: number;
  ragebait: number;
  duplicate_information: number;
  expected_attention_value: number;
  anchor_distance: number;
}

function scoresOf(row: CandidateRow): DeepScores {
  return {
    personal_interest: row.personal_interest,
    intellectual_depth: row.intellectual_depth,
    novelty: row.novelty,
    practical_usefulness: row.practical_usefulness,
    entertainment: row.entertainment,
    storytelling: row.storytelling,
    authorial_voice: row.authorial_voice,
    critique: row.critique,
    humor: row.humor,
    obsessive_expertise: row.obsessive_expertise,
    rabbit_hole: row.rabbit_hole,
    delight: row.delight,
    headline_sufficiency: row.headline_sufficiency,
    source_quality: row.source_quality,
    serendipity: row.serendipity,
    ragebait: row.ragebait,
    duplicate_information: row.duplicate_information,
    expected_attention_value: row.expected_attention_value,
    anchor_distance: row.anchor_distance,
  };
}

function recommendedFeeds(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The short summary, in the publisher's own words wherever possible.
 *
 * Sift does not write summaries -- that rule governs every other feed
 * (`renderFeed.ts`) and there is no reason for the briefing to be the exception
 * just because its lines are short. `publisher` is the RSS summary or the
 * extracted subtitle; `why_it_surfaced` is Terra's one-line reason, which is
 * already shown to readers under "Why this surfaced" everywhere else.
 */
export function briefingSummary(
  row: Pick<CandidateRow, 'rss_summary' | 'subtitle' | 'why_it_surfaced'>,
  config: AppConfig,
): { summary: string; source: string } {
  const maxChars = config.briefing.summary.max_chars;
  for (const preference of config.briefing.summary.sources) {
    const candidates: Array<[string, string | null]> =
      preference === 'publisher'
        ? [
            ['rss_summary', row.rss_summary],
            ['subtitle', row.subtitle],
          ]
        : [['why_it_surfaced', row.why_it_surfaced]];
    for (const [name, value] of candidates) {
      const text = collapseWhitespace(value ?? '');
      if (text) return { summary: truncate(text, maxChars), source: name };
    }
  }
  return { summary: '', source: 'none' };
}

/**
 * Rank and cap the candidates for one slot.
 *
 * Exported so `npm run briefing -- --dry` can show exactly what would ship
 * without writing an edition.
 */
export function selectBriefingLines(
  db: Db,
  config: AppConfig,
  windowStart: number,
  now: number,
): { candidates: number; eligible: number; lines: BriefingLine[] } {
  const feed = config.briefing.feed;
  const selection = config.briefing.selection;
  // Resolved from config rather than the sources table: config is the source of
  // editorial truth, and the table is a mirror of it refreshed at ingest.
  const briefingSourceIds = config.sources.filter((source) => source.lanes.includes('briefing')).map((source) => source.id);

  const rows = db.all<CandidateRow>(
    `SELECT fi.id, fi.source_id, s.name AS source_name, fi.cluster_id, fi.title,
            fi.original_url, fi.canonical_url, fi.rss_summary, fi.publication_time,
            ac.subtitle, de.why_it_surfaced, de.category, de.recommended_feeds_json,
            de.personal_interest, de.intellectual_depth, de.novelty, de.practical_usefulness,
            de.entertainment, de.storytelling, de.authorial_voice, de.critique, de.humor,
            de.obsessive_expertise, de.rabbit_hole, de.delight, de.headline_sufficiency,
            de.source_quality, de.serendipity, de.ragebait, de.duplicate_information,
            de.expected_attention_value, de.anchor_distance
     FROM deep_evaluations de
     JOIN feed_items fi ON fi.id = de.item_id
     JOIN sources s ON s.id = fi.source_id
     LEFT JOIN article_content ac ON ac.item_id = fi.id
     WHERE s.publishable = 1
       -- A source opts into the briefing lane. The digest and the feeds want
       -- different things: a high-volume wire is too noisy to publish but ideal
       -- summarised in ten lines, and a slow essay site is the reverse.
       AND s.id IN (${briefingSourceIds.map((_, i) => `:src${i}`).join(',') || `''`})
       -- Appearing in a briefing is publishing, so the rule that audit samples
       -- are measured and never surfaced applies here exactly as it does to
       -- every feed. Without this the false-negative rate stops meaning
       -- anything, because the sample would have been shown to the reader.
       AND de.is_audit_sample = 0
       AND COALESCE(fi.publication_time, fi.first_seen_at) >= :windowStart
       AND COALESCE(fi.publication_time, fi.first_seen_at) <= :now
       ${selection.repeat_across_editions ? '' : `AND NOT EXISTS (
         SELECT 1 FROM briefing_edition_items bei WHERE bei.item_id = fi.id
       )`}
     ORDER BY de.expected_attention_value DESC`,
    { windowStart, now, ...Object.fromEntries(briefingSourceIds.map((id, i) => [`src${i}`, id])) },
  );

  const scored = rows
    .map((row) => ({
      row,
      verdict: scoreForFeed(
        scoresOf(row),
        feed,
        row.category ?? 'other',
        recommendedFeeds(row.recommended_feeds_json),
      ),
    }))
    .filter((entry) => entry.verdict.eligible)
    .sort((a, b) => b.verdict.score - a.verdict.score);

  const perCluster = new Map<string, number>();
  const perSource = new Map<string, number>();
  const lines: BriefingLine[] = [];

  for (const { row, verdict } of scored) {
    if (lines.length >= selection.items) break;
    const url = row.original_url ?? row.canonical_url;
    if (!url) continue;

    // One line per story. Clustering decides what "the same story" means, and a
    // digest is where ten takes on one announcement is most obviously a failure.
    const cluster = row.cluster_id;
    if (cluster && (perCluster.get(cluster) ?? 0) >= selection.max_per_cluster) continue;
    if ((perSource.get(row.source_id) ?? 0) >= selection.max_per_source) continue;

    const { summary, source } = briefingSummary(row, config);
    lines.push({
      itemId: row.id,
      rank: lines.length + 1,
      score: verdict.score,
      title: row.title,
      url,
      sourceName: row.source_name,
      summary,
      summarySource: source,
    });
    if (cluster) perCluster.set(cluster, (perCluster.get(cluster) ?? 0) + 1);
    perSource.set(row.source_id, (perSource.get(row.source_id) ?? 0) + 1);
  }

  return { candidates: rows.length, eligible: scored.length, lines };
}

function editionId(feedId: string, localDay: string, slot: string): string {
  return stableId('briefing', feedId, localDay, slot);
}

export function hasEdition(db: Db, config: AppConfig, slot: BriefingSlot): boolean {
  const row = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM briefing_editions WHERE feed_id = :feed AND local_day = :day AND slot = :slot`,
    { feed: config.briefing.feed.id, day: slot.localDay, slot: slot.id },
  );
  return (row?.c ?? 0) > 0;
}

/**
 * The window a slot summarises: everything since the slot before it.
 *
 * Derived from the configured times rather than from the previous edition's
 * timestamp, so a missed briefing does not silently widen the next one into a
 * two-day digest. `max_age_hours` is the backstop for the first run after a
 * long outage, when `window_hours` alone would still admit stale news.
 */
export function windowStartFor(config: AppConfig, slot: BriefingSlot, now: number): number {
  const byWindow = slot.scheduledFor - config.briefing.selection.window_hours * HOUR_MS;
  const byAge = now - config.briefing.selection.max_age_hours * HOUR_MS;
  return Math.max(byWindow, byAge);
}

export interface BuildOptions {
  now?: number;
  /** Build the most recent slot even if it is late or already published. */
  force?: boolean;
  /** Select and report, but write nothing. */
  dry?: boolean;
}

export function runBriefing(db: Db, config: AppConfig, options: BuildOptions = {}): BriefingRunResult {
  const now = options.now ?? Date.now();
  const empty = {
    built: false,
    slot: null,
    localDay: null,
    candidates: 0,
    eligible: 0,
    selected: 0,
    lines: [] as BriefingLine[],
  };

  if (!config.briefing.enabled) {
    return { ...empty, reason: 'the briefing is turned off for this reader' };
  }

  // --force skips both the already-published and the too-late checks, which is
  // the whole point of it: rebuilding this morning's edition at noon after
  // changing a weight has to be possible.
  const due = dueSlot(config.briefing, now, (candidate) => hasEdition(db, config, candidate));
  const slot = options.force ? recentSlots(config.briefing, now)[0] ?? null : due.slot;
  if (!slot) return { ...empty, reason: due.reason };

  const windowStart = windowStartFor(config, slot, now);
  const { candidates, eligible, lines } = selectBriefingLines(db, config, windowStart, now);
  const base = {
    slot: slot.id,
    localDay: slot.localDay,
    candidates,
    eligible,
    selected: lines.length,
    lines,
  };

  if (lines.length < config.briefing.selection.min_items) {
    // Deliberately not published, and deliberately not recorded as an edition:
    // leaving the slot unbuilt returns these items to the next briefing's
    // window rather than spending them on a digest too thin to be worth
    // opening. A four-line "top ten" reads as a broken feed.
    const reason =
      `only ${lines.length} item(s) cleared the bar for the ${slot.time} briefing ` +
      `(minimum ${config.briefing.selection.min_items}), so the slot was left for the next one`;
    log.info(reason);
    return { ...base, built: false, reason };
  }

  if (options.dry) {
    return { ...base, built: false, reason: `${lines.length} item(s) selected; dry run wrote nothing` };
  }

  const id = editionId(config.briefing.feed.id, slot.localDay, slot.id);
  db.transaction(() => {
    db.run(
      `INSERT INTO briefing_editions (
         id, feed_id, local_day, slot, slot_label, scheduled_for, published_at,
         item_count, candidates, window_start, config_hash)
       VALUES (:id, :feed, :day, :slot, :label, :scheduled, :now, :count, :candidates, :window, :hash)
       ON CONFLICT(id) DO UPDATE SET
         published_at = excluded.published_at, item_count = excluded.item_count,
         candidates = excluded.candidates, window_start = excluded.window_start,
         config_hash = excluded.config_hash`,
      {
        id,
        feed: config.briefing.feed.id,
        day: slot.localDay,
        slot: slot.id,
        label: slot.label,
        scheduled: slot.scheduledFor,
        now,
        count: lines.length,
        candidates,
        window: windowStart,
        hash: config.hashes.briefing,
      },
    );
    // --force may rebuild a slot; the edition's lines are replaced wholesale
    // rather than merged, so a rebuild cannot leave two rankings interleaved.
    db.run(`DELETE FROM briefing_edition_items WHERE edition_id = :id`, { id });
    for (const line of lines) {
      db.run(
        `INSERT INTO briefing_edition_items (edition_id, item_id, rank_position, score, summary, summary_source)
         VALUES (:edition, :item, :rank, :score, :summary, :source)`,
        {
          edition: id,
          item: line.itemId,
          rank: line.rank,
          score: line.score,
          summary: line.summary,
          source: line.summarySource,
        },
      );
    }
  });

  const reason = `published the ${slot.time} briefing for ${slot.localDay} with ${lines.length} item(s)`;
  log.info(`${reason} (from ${candidates} candidate(s), ${eligible} eligible)`);
  return { ...base, built: true, reason };
}

/** Editions for the rendered feed, newest first. */
export function loadBriefingEditions(db: Db, config: AppConfig, limit: number): BriefingEdition[] {
  const editions = db.all<{
    id: string;
    feed_id: string;
    local_day: string;
    slot: string;
    slot_label: string;
    scheduled_for: number;
    published_at: number;
    window_start: number;
  }>(
    `SELECT id, feed_id, local_day, slot, slot_label, scheduled_for, published_at, window_start
     FROM briefing_editions WHERE feed_id = :feed
     ORDER BY published_at DESC LIMIT :limit`,
    { feed: config.briefing.feed.id, limit },
  );
  if (editions.length === 0) return [];

  return editions.map((edition) => ({
    id: edition.id,
    feedId: edition.feed_id,
    localDay: edition.local_day,
    slot: edition.slot,
    slotLabel: edition.slot_label,
    scheduledFor: edition.scheduled_for,
    publishedAt: edition.published_at,
    windowStart: edition.window_start,
    lines: db
      .all<{
        item_id: string;
        rank_position: number;
        score: number;
        summary: string;
        summary_source: string;
        title: string;
        original_url: string | null;
        canonical_url: string | null;
        source_name: string;
      }>(
        `SELECT bei.item_id, bei.rank_position, bei.score, bei.summary, bei.summary_source,
                fi.title, fi.original_url, fi.canonical_url, s.name AS source_name
         FROM briefing_edition_items bei
         JOIN feed_items fi ON fi.id = bei.item_id
         JOIN sources s ON s.id = fi.source_id
         WHERE bei.edition_id = :id
         ORDER BY bei.rank_position ASC`,
        { id: edition.id },
      )
      .map((line) => ({
        itemId: line.item_id,
        rank: line.rank_position,
        score: line.score,
        title: line.title,
        url: line.original_url ?? line.canonical_url ?? '',
        sourceName: line.source_name,
        summary: line.summary,
        summarySource: line.summary_source,
      })),
  }));
}
