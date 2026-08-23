import type { AppConfig, SourceConfig } from '../config/index.js';
import type { Db } from '../db/index.js';
import { setStatus } from '../pipeline/journal.js';
import { DAY_MS } from '../util/time.js';
import { classifyEditorialType, isExpired } from '../rank/freeScore.js';
import { logger } from '../util/log.js';
import { classifyArticleLanguage } from './language.js';

const log = logger('filter');

/**
 * Deterministic pre-AI filtering.
 *
 * Deliberately conservative: this stage exists to remove things that are
 * obviously not articles, not to make editorial judgements. Anything debatable
 * is left for the cheap model, because a false negative here is invisible and
 * permanent.
 */

export interface FilterInput {
  id: string;
  source_id: string;
  title: string;
  canonical_url: string | null;
  original_url: string | null;
  subtitle?: string | null;
  rss_summary: string | null;
  rss_content: string | null;
  feed_categories: string[];
  publication_time: number | null;
  first_seen_at: number;
  is_podcast?: boolean;
  language?: string | null;
}

export interface FilterVerdict {
  keep: boolean;
  reason: string;
  /** Short items are flagged rather than dropped; later stages see this. */
  thin: boolean;
  /** The specific pattern or rule that fired, for the audit trail. */
  matchedRule: string | null;
  /** global | source | derived -- where the rule came from. */
  scope: 'global' | 'source' | 'derived' | null;
}

const regexCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    log.warn(`invalid regex in config, ignored: ${pattern}`, err);
  }
  regexCache.set(pattern, re);
  return re;
}

function matchesAny(value: string | null | undefined, patterns: readonly string[]): string | null {
  if (!value) return null;
  for (const p of patterns) {
    const re = compile(p);
    if (re?.test(value)) return p;
  }
  return null;
}

export function applyHardFilter(
  item: FilterInput,
  source: SourceConfig | undefined,
  config: AppConfig,
  now: number = Date.now(),
): FilterVerdict {
  const hf = config.free.rule_filter;
  const summaryLength = (item.rss_summary?.length ?? 0) + (item.rss_content?.length ?? 0);
  const thin = summaryLength < hf.thin_content_chars;

  if (!hf.enabled) return { keep: true, reason: 'filters disabled', thin, matchedRule: null, scope: null };

  const safelyGatedMixedSource =
    source?.access === 'mixed' &&
    source.hard_rules?.require_explicit_free_article === true &&
    source.hard_rules?.require_readable_article === true;
  if (source && source.access !== 'free' && !safelyGatedMixedSource) {
    return {
      keep: false,
      reason: `source access is ${source.access}; mixed sources require explicit-free metadata and readability gates`,
      thin,
      matchedRule: `access:${source.access}`,
      scope: 'source',
    };
  }

  // Podcast-feed entries exist only for alternate-format matching. They are not
  // recommendation candidates, and excluding them here rather than deeper in
  // keeps the funnel counts honest.
  if (hf.drop_podcast_items && item.is_podcast) {
    return {
      keep: false,
      reason: 'podcast feed entry: ingested for alternate-format matching only',
      thin,
      matchedRule: 'drop_podcast_items',
      scope: 'derived',
    };
  }

  const title = (item.title ?? '').trim();

  // Malformed: nothing to identify or link to.
  if (!title || title === '(untitled)') {
    if (!item.canonical_url) {
      return { keep: false, reason: 'malformed: no title and no URL', thin, matchedRule: 'malformed', scope: 'derived' };
    }
  }
  if (title.length > 0 && title.length < hf.min_title_length && !item.canonical_url) {
    return {
      keep: false,
      reason: `malformed: title shorter than ${hf.min_title_length} chars`,
      thin,
      matchedRule: 'min_title_length',
      scope: 'derived',
    };
  }
  if (!item.canonical_url && !item.original_url) {
    return { keep: false, reason: 'malformed: no link', thin, matchedRule: 'malformed', scope: 'derived' };
  }

  const globalTitle = matchesAny(title, hf.title_patterns);
  if (globalTitle) {
    return {
      keep: false,
      reason: `title matched blocked pattern /${globalTitle}/`,
      thin,
      matchedRule: globalTitle,
      scope: 'global',
    };
  }

  const url = item.canonical_url ?? item.original_url;

  if (url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      const paywallHost = hf.paywall_hosts.find((host) => {
        const clean = host.toLowerCase().replace(/^www\./, '');
        return hostname === clean || hostname.endsWith(`.${clean}`);
      });
      if (paywallHost) {
        return {
          keep: false,
          reason: `linked article is on known paywall host ${paywallHost}`,
          thin,
          matchedRule: `paywall_host:${paywallHost}`,
          scope: 'global',
        };
      }
    } catch {
      // URL shape is handled by the malformed checks above.
    }
  }

  const configuredLanguages = config.taste.reader_preferences.languages.map((language) => language.toLowerCase());
  const allowedLanguages = new Set(
    config.taste.reader_preferences.non_primary_language_policy === 'never'
      ? configuredLanguages.slice(0, 1)
      : configuredLanguages,
  );
  if (hf.english_only || allowedLanguages.size > 0) {
    const language = classifyArticleLanguage(
      [item.title, item.subtitle, item.rss_summary, item.rss_content],
      item.language ?? source?.language,
    );
    const allowed = language.verdict !== 'uncertain' && language.language !== null && allowedLanguages.has(language.language);
    if (!allowed) {
      return {
        keep: false,
        reason:
          language.verdict === 'uncertain'
            ? `language uncertain or unsupported: ${language.reason}`
            : language.language === 'en'
              ? `English is not in the reader's allowed languages: ${language.reason}`
              : `non-English language ${language.language ?? 'unknown'} is not in the reader's allowed languages: ${language.reason}`,
        thin,
        matchedRule: language.language ? 'allowed_languages' : 'allowed_languages_uncertain',
        scope: 'derived',
      };
    }
  }

  const globalUrl = matchesAny(url, hf.url_patterns);
  if (globalUrl) {
    return {
      keep: false,
      reason: `url matched blocked pattern /${globalUrl}/`,
      thin,
      matchedRule: globalUrl,
      scope: 'global',
    };
  }

  const blocked = hf.feed_category_blocklist.map((c) => c.toLowerCase());
  for (const cat of item.feed_categories) {
    if (blocked.includes(cat.toLowerCase())) {
      return {
        keep: false,
        reason: `feed category "${cat}" is blocklisted`,
        thin,
        matchedRule: `feed_category:${cat}`,
        scope: 'global',
      };
    }
  }

  // Age. Items with no date are given the benefit of the doubt.
  const maxAgeDays = source?.hard_rules?.max_age_days ?? hf.max_item_age_days;
  if (item.publication_time !== null && item.publication_time < now - maxAgeDays * DAY_MS) {
    return { keep: false, reason: `older than ${maxAgeDays} days`, thin, matchedRule: 'max_item_age_days', scope: 'global' };
  }

  // Time-sensitive content past its useful life. Only content types whose
  // freshness curve declares an expiry are affected, so an essay is never
  // dropped for being three weeks old.
  const contentType = classifyEditorialType(
    { title: item.title, subtitle: item.subtitle ?? null, summary: item.rss_summary },
    source,
    config,
  );
  const { expired, afterDays } = isExpired(item.publication_time, contentType, config, now);
  if (expired) {
    return {
      keep: false,
      reason: `stale ${contentType}: past its ${afterDays}-day useful life`,
      thin,
      matchedRule: `expires_after_days:${contentType}`,
      scope: 'derived',
    };
  }

  // Per-source rules.
  const rules = source?.hard_rules;
  if (rules) {
    const t = matchesAny(title, rules.drop_title_patterns ?? []);
    if (t) return { keep: false, reason: `source rule: title matched /${t}/`, thin, matchedRule: t, scope: 'source' };

    const u = matchesAny(url, rules.drop_url_patterns ?? []);
    if (u) return { keep: false, reason: `source rule: url matched /${u}/`, thin, matchedRule: u, scope: 'source' };

    const dropCats = (rules.drop_feed_categories ?? []).map((c) => c.toLowerCase());
    for (const cat of item.feed_categories) {
      if (dropCats.includes(cat.toLowerCase())) {
        return {
          keep: false,
          reason: `source rule: feed category "${cat}"`,
          thin,
          matchedRule: `feed_category:${cat}`,
          scope: 'source',
        };
      }
    }

    const minChars = rules.min_summary_chars ?? 0;
    if (minChars > 0 && summaryLength < minChars) {
      return {
        keep: false,
        reason: `source rule: summary shorter than ${minChars} chars`,
        thin,
        matchedRule: 'min_summary_chars',
        scope: 'source',
      };
    }
  }

  return { keep: true, reason: thin ? 'kept (thin content)' : 'kept', thin, matchedRule: null, scope: null };
}

export interface HardFilterStats {
  examined: number;
  kept: number;
  dropped: number;
  thin: number;
  byReason: Record<string, number>;
}

/**
 * Stage 2 runner. Records a rule_filter_evaluations row for every item examined,
 * kept or dropped, with the rule that fired and the filter version that fired it.
 */
export function hardFilterPending(db: Db, config: AppConfig, now: number = Date.now()): HardFilterStats {
  const rows = db.all<{
    id: string;
    source_id: string;
    title: string;
    subtitle: string | null;
    canonical_url: string | null;
    original_url: string | null;
    rss_summary: string | null;
    rss_content: string | null;
    feed_categories_json: string;
    publication_time: number | null;
    first_seen_at: number;
    is_podcast: number;
    language: string | null;
  }>(`SELECT id, source_id, title, subtitle, canonical_url, original_url, rss_summary, rss_content,
             feed_categories_json, publication_time, first_seen_at, is_podcast, language
      FROM feed_items WHERE status = 'new'`);

  const stats: HardFilterStats = { examined: 0, kept: 0, dropped: 0, thin: 0, byReason: {} };
  const sourceMap = new Map(config.sources.map((s) => [s.id, s]));

  db.transaction(() => {
    for (const row of rows) {
      stats.examined += 1;
      let feedCategories: string[] = [];
      try {
        feedCategories = JSON.parse(row.feed_categories_json) as string[];
      } catch {
        feedCategories = [];
      }

      const verdict = applyHardFilter(
        { ...row, feed_categories: feedCategories, is_podcast: row.is_podcast === 1 },
        sourceMap.get(row.source_id),
        config,
        now,
      );

      db.run(
        `INSERT INTO rule_filter_evaluations (item_id, filter_result, filter_reason, filter_version,
                                              matched_rule, rule_scope, is_thin, created_at)
         VALUES (:id, :result, :reason, :version, :rule, :scope, :thin, :ts)
         ON CONFLICT(item_id) DO UPDATE SET
           filter_result = excluded.filter_result, filter_reason = excluded.filter_reason,
           filter_version = excluded.filter_version, matched_rule = excluded.matched_rule,
           rule_scope = excluded.rule_scope, is_thin = excluded.is_thin,
           created_at = excluded.created_at`,
        {
          id: row.id,
          result: verdict.keep ? 'keep' : 'drop',
          reason: verdict.reason,
          version: config.free.rule_filter.filter_version,
          rule: verdict.matchedRule,
          scope: verdict.scope,
          thin: verdict.thin ? 1 : 0,
          ts: now,
        },
      );

      if (verdict.thin) stats.thin += 1;
      if (verdict.keep) {
        stats.kept += 1;
        setStatus(db, row.id, 'filtered', verdict.reason);
      } else {
        stats.dropped += 1;
        stats.byReason[verdict.reason] = (stats.byReason[verdict.reason] ?? 0) + 1;
        setStatus(db, row.id, 'rejected_rules', verdict.reason);
      }
    }
  });

  log.info(`hard filter: ${stats.kept} kept, ${stats.dropped} dropped of ${stats.examined}`);
  return stats;
}
