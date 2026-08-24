import { z } from 'zod';

/**
 * Schemas for the human-editable config files:
 *
 *   sources.yaml        who we read, and how much opportunity each source gets
 *   taste-profile.yaml  who the reader is
 *   models.yaml         stage 4 / stage 5 models, semantic provider
 *   free-ranking.yaml   stage 2 rules, stage 3 free score
 *   final-ranking.yaml  stage 4/5 gating, stage 6 portfolio construction
 *   feed-config.yaml    the six always-on generated feeds
 *   classics.yaml       the optional archival lane
 *   briefing.yaml       the optional twice-daily digest
 *   budget.yaml         spend limits, operating mode, Terra allocation
 *   pipeline.yaml       mechanics: fetch, extract, cluster, feedback, learning
 *
 * Validation is strict on shape but tolerant of extra keys, so notes can live in
 * the YAML. Every numeric knob has a default, so a partially-filled file loads.
 */

const unit = z.number().min(-5).max(5);
const probability = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// sources.yaml
// ---------------------------------------------------------------------------

export const sourceHardRulesSchema = z
  .object({
    drop_title_patterns: z.array(z.string()).default([]),
    drop_url_patterns: z.array(z.string()).default([]),
    drop_feed_categories: z.array(z.string()).default([]),
    min_summary_chars: z.number().int().min(0).default(0),
    max_age_days: z.number().int().positive().optional(),
    force_category: z.string().optional(),
    never_extract: z.boolean().default(false),
    /** Reject unless full readable article text was extracted successfully. */
    require_readable_article: z.boolean().default(false),
    /**
     * For mixed-access publications, require canonical-page metadata to say the
     * individual article is free. Missing metadata is ineligible by design.
     */
    require_explicit_free_article: z.boolean().default(false),
    /** Overrides the inferred editorial type, and so the freshness curve. */
    content_type: z.string().optional(),
  })
  .partial()
  .default({});

export const sourceSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_]+$/i, 'source id must be alphanumeric/underscore'),
  name: z.string().min(1),
  feed_url: z.string().url(),
  feed_type: z.enum(['article', 'podcast', 'linkblog']).optional(),
  language: z.string().optional(),
  enabled: z.boolean().optional(),
  /**
   * Podcast feeds are ingested only for alternate-format matching and are not
   * recommendation candidates. Optional so the loader can derive it from
   * feed_type; a default here would silently override that.
   */
  publishable: z.boolean().optional(),
  /** Access is an eligibility fact, not a ranking signal. */
  access: z.enum(['free', 'mixed', 'paywalled']).optional(),
  /** Lets feed rendering distinguish product cards from articles. */
  item_kind: z.enum(['article', 'product']).optional(),
  /** Bounded adapters for discovery services that are not RSS feeds. */
  discovery: z
    .object({
      type: z.literal('hacker_news'),
      max_candidates: z.number().int().positive().default(120),
      max_items: z.number().int().positive().default(15),
      max_age_hours: z.number().positive().default(48),
      min_points: z.number().int().nonnegative().default(35),
      min_comments: z.number().int().nonnegative().default(8),
      min_engagement_signal: z.number().nonnegative().default(5),
    })
    .optional(),

  /**
   * Which lanes this source may reach.
   *
   * The three lanes want different things, so tying them to one list was wrong.
   * A high-volume wire is too noisy for a feed but ideal in a ten-line digest;
   * a slow essay site is the reverse. `classics` is different in kind — an
   * archive to search rather than a feed to poll — so a source opts into it
   * only when its back catalogue is worth mining.
   *
   * Defaults to feeds and briefing: the lanes a conventional RSS source serves.
   * Narrowing this never changes what is ingested or evaluated, only where an
   * item may surface, so an item can still inform clustering and saturation for
   * a lane it cannot itself appear in.
   */
  lanes: z.array(z.enum(['feeds', 'briefing', 'classics'])).min(1).optional(),
  /** How likely an item from here deserves deeper inspection (stage 3/4). */
  quality_prior: probability.optional(),
  /** How much attention this source may request. Compresses its decay curve. */
  volume_budget: z.number().min(0).max(2).optional(),
  /** Keeps new or rarely-surfaced sources from disappearing permanently. */
  exploration_floor: probability.optional(),
  /** Per-category quality. `default` covers anything unlisted. */
  category_priors: z.record(z.string(), probability).default({}),
  /** How welcome this source is in each feed. `default` covers unlisted feeds. */
  feed_weights: z.record(z.string(), probability).default({}),
  hard_rules: sourceHardRulesSchema,
});

export const sourcesFileSchema = z.object({
  defaults: z
    .object({
      feed_type: z.enum(['article', 'podcast', 'linkblog']).default('article'),
      language: z.string().default('en'),
      enabled: z.boolean().default(true),
      access: z.enum(['free', 'mixed', 'paywalled']).default('free'),
      item_kind: z.enum(['article', 'product']).default('article'),
      lanes: z.array(z.enum(['feeds', 'briefing', 'classics'])).min(1).default(['feeds', 'briefing']),
      quality_prior: probability.default(0.55),
      volume_budget: z.number().min(0).max(2).default(1),
      exploration_floor: probability.default(0.08),
      category_priors: z.record(z.string(), probability).default({ default: 0.45 }),
      feed_weights: z.record(z.string(), probability).default({ default: 0.6 }),
    })
    .default({}),
  sources: z.array(sourceSchema).min(1),
  /**
   * How an assistant-suggested source is translated into a configured one when
   * the reader approves it.
   *
   * These decide how much opportunity a newly adopted source gets, so they are
   * editorial values and belong here rather than in the adoption code. The
   * numbers are deliberately cautious: a source nobody has read yet has no
   * evidence behind it, and `disposition`/`role` are the assistant's guesses.
   * An adopted entry records its resolved values explicitly, so changing these
   * never silently re-rates a source already in a reader's list.
   */
  /**
   * Asking the deep model which sources suit this reader.
   *
   * The output is a list of publications with reasons, which is far longer
   * than the single-article verdict `models.yaml` sizes `max_output_tokens`
   * for -- the first run returned truncated JSON and no candidates at all.
   */
  suggestion: z
    .object({
      /** Which prompt version proposes sources. Add a new file, point here. */
      prompt: z.string().min(1).default('source-discovery-v2'),
      max_candidates: z.number().int().min(1).max(40).default(12),
      max_output_tokens: z.number().int().positive().default(4000),
    })
    .default({}),
  adoption: z
    .object({
      quality_prior: z
        .object({
          known_favorite: probability.default(0.62),
          recommended: probability.default(0.56),
          exploratory: probability.default(0.5),
        })
        .default({}),
      // Volume budget is where `role` does its work: a wildcard should be able
      // to surprise the reader without being able to fill the edition.
      volume_budget: z
        .object({
          direct_follow: z.number().min(0).max(2).default(1),
          selective: z.number().min(0).max(2).default(0.6),
          discovery_only: z.number().min(0).max(2).default(0.35),
          wildcard: z.number().min(0).max(2).default(0.25),
        })
        .default({}),
    })
    .default({}),
});

export type SourcesFile = z.output<typeof sourcesFileSchema>;

/**
 * Sources a reader adopted from assistant suggestions.
 *
 * A separate file, merged onto `sources.yaml` rather than replacing it. Profile
 * config files are whole-file overrides, so writing an adopted source into a
 * profile copy of `sources.yaml` would freeze that reader's list at the moment
 * of adoption and silently withhold every later change to the shared one.
 */
export const sourcesOverlayFileSchema = z.object({
  version: z.number().int().default(1),
  sources: z.array(sourceSchema).default([]),
});

export type SourcesOverlayFile = z.output<typeof sourcesOverlayFileSchema>;

// ---------------------------------------------------------------------------
// taste-profile.yaml
// ---------------------------------------------------------------------------

export const interestAnchorSchema = z.object({
  id: z.string().min(1),
  category: z.string().default('other'),
  text: z.string().min(10),
});

export const attentionBudgetSchema = z.enum(['under_15', '15_30', '30_60', '60_plus', 'variable']);
export const articleLengthSchema = z.enum(['mostly_short', 'medium', 'long_when_exceptional', 'any']);
export const paywallPolicySchema = z.enum(['free_only', 'subscribed_publications', 'readable_only', 'quality_first']);
export const freshnessBalanceSchema = z.enum(['timely', 'balanced', 'evergreen']);
export const preferredMediumSchema = z.enum(['text', 'video', 'podcast', 'any']);

/**
 * The two editorial lanes a reader may decline.
 *
 * Both are additive rather than corrective: switching one off removes a feed,
 * it never changes how the other feeds rank. That is why they are safe to
 * default on and safe to turn off at any time — no threshold needs
 * recalibrating either way.
 */
export const optionalFeedsSchema = z
  .object({
    /** The twice-daily digest of the top items, as one article per slot. */
    briefing: z.boolean().default(true),
    /** One exceptional older article a day. */
    classics: z.boolean().default(true),
  })
  .default({});

export const readerPreferencesSchema = z.object({
  version: z.literal(1).default(1),
  optional_feeds: optionalFeedsSchema,
  attention_budget: attentionBudgetSchema.default('15_30'),
  article_length: articleLengthSchema.default('long_when_exceptional'),
  paywall_policy: paywallPolicySchema.default('free_only'),
  subscribed_publications: z.array(z.string().min(1)).default([]),
  languages: z.array(z.string().min(2)).min(1).default(['en']),
  non_primary_language_policy: z.enum(['never', 'exceptional_only', 'equal']).default('never'),
  freshness_balance: freshnessBalanceSchema.default('balanced'),
  max_evergreen_age_days: z.number().int().positive().nullable().default(null),
  serendipity: z.number().min(0).max(10).default(5),
  writing_voices: z.array(z.string().min(2)).default([]),
  disliked_styles: z.array(z.string().min(2)).default([]),
  medium_preferences: z.array(z.object({
    subject: z.string().min(2),
    preferred_medium: preferredMediumSchema,
    strength: z.enum(['prefer', 'strongly_prefer']).default('prefer'),
  })).default([]),
});

export const sourcePreferenceSchema = z.object({
  name: z.string().min(1),
  domain: z.string().default(''),
  disposition: z.enum(['known_favorite', 'recommended', 'exploratory', 'avoid']),
  role: z.enum(['direct_follow', 'selective', 'discovery_only', 'wildcard']).nullable().default(null),
  reason: z.string().min(5),
  confidence: probability,
});

export const tasteProfileSchema = z.object({
  version: z.number().int().default(1),
  about_me: z.string().default(''),
  strong_interests: z.array(z.string()).default([]),
  positive_content_traits: z.array(z.string()).default([]),
  negative_content_traits: z.array(z.string()).default([]),
  editorial_notes: z.string().default(''),
  topic_priorities: z
    .array(
      z.object({
        id: z.string().min(1),
        priority: z.number().min(0).max(10),
        guidance: z.string().min(10),
      }),
    )
    .default([]),
  style_references: z
    // Same mismatch as the example descriptions below: `guidance` is the
    // dossier's `style_references[].qualities`, bounded at min(5) upstream.
    .array(z.object({ name: z.string().min(1), guidance: z.string().min(5) }))
    .default([]),
  /** Concrete calibration examples complement abstract traits without becoming hard filters. */
  /**
   * `description` is copied verbatim from the dossier's
   * `examples[].title_or_description`, which the onboarding contract bounds at
   * min(5). Requiring 10 here made the two schemas disagree about the same
   * field: a dossier naming a short title -- "Piranesi", 8 characters -- passed
   * onboarding validation and then failed profile compilation, after the reader
   * had already completed every step. A title is a legitimate description of an
   * example, so the bound follows the upstream contract rather than the reverse.
   */
  positive_examples: z
    .array(z.object({ description: z.string().min(5), reason: z.string().min(5) }))
    .default([]),
  negative_examples: z
    .array(z.object({ description: z.string().min(5), reason: z.string().min(5) }))
    .default([]),
  reader_preferences: readerPreferencesSchema.default({}),
  /** Assistant suggestions are evidence, not source definitions. Only matches
   * against validated sources.yaml entries receive a small bounded prior. */
  source_preferences: z.array(sourcePreferenceSchema).default([]),
  interest_anchors: z.array(interestAnchorSchema).default([]),
  avoid_anchors: z.array(z.object({ id: z.string().min(1), text: z.string().min(10) })).default([]),
});

// ---------------------------------------------------------------------------
// models.yaml
// ---------------------------------------------------------------------------

export const chatModelSchema = z.object({
  model: z.string().min(1),
  /**
   * Free-form on purpose: provider vocabularies change, and a new value should
   * be usable by editing YAML. Passed through verbatim; the client drops it if
   * the API says it is unsupported.
   */
  reasoning_effort: z.string().min(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().default(4),
  temperature: z.number().min(0).max(2).optional(),
  cost_per_1m_input: z.number().min(0).default(0),
  cost_per_1m_cached_input: z.number().min(0).optional(),
  cost_per_1m_output: z.number().min(0).default(0),
  mode: z.enum(['auto', 'sync', 'batch']).default('sync'),
  batch_min_items: z.number().int().positive().default(25),
  batch_poll_interval_seconds: z.number().int().positive().default(60),
  batch_max_wait_hours: z.number().positive().default(24),
  /** Provider batch discount, applied when pricing batch usage in the ledger. */
  batch_discount: probability.default(0.5),
  /** Seconds a run may wait for a batch; 0 submits and leaves it to the next. */
  batch_collect_wait_seconds: z.number().nonnegative().default(90),
});

export const embeddingModelSchema = z.object({
  model: z.string().min(1),
  dimensions: z.number().int().positive().optional(),
  cost_per_1m_input: z.number().min(0).default(0),
  batch_size: z.number().int().positive().default(96),
});

export const modelsFileSchema = z.object({
  version: z.number().int().default(1),
  models: z.object({
    triage: chatModelSchema,
    deep: chatModelSchema,
    embeddings: embeddingModelSchema,
  }),
  semantic: z
    .object({
      /** `openai` is retained as a backwards-compatible spelling for `api`. */
      provider: z.enum(['api', 'openai', 'hash']).default('api'),
      fallback: z.enum(['hash', 'none']).default('hash'),
      cache: z.boolean().default(true),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// free-ranking.yaml
// ---------------------------------------------------------------------------

const freshnessCurveSchema = z.object({
  half_life_days: z.number().positive(),
  expires_after_days: z.number().positive().nullable().default(null),
  floor: probability.default(0.1),
});

export const freeRankingFileSchema = z.object({
  version: z.number().int().default(1),
  rule_filter: z
    .object({
      enabled: z.boolean().default(true),
      filter_version: z.number().int().default(1),
      title_patterns: z.array(z.string()).default([]),
      url_patterns: z.array(z.string()).default([]),
      feed_category_blocklist: z.array(z.string()).default([]),
      min_title_length: z.number().int().min(0).default(8),
      thin_content_chars: z.number().int().min(0).default(120),
      drop_duplicate_urls: z.boolean().default(true),
      drop_podcast_items: z.boolean().default(true),
      english_only: z.boolean().default(true),
      /** Known paywall hosts, including links arriving through discovery inputs. */
      paywall_hosts: z.array(z.string()).default([]),
      stale_news_days: z.number().int().positive().default(5),
      max_item_age_days: z.number().int().positive().default(14),
    })
    .default({}),
  free_ranking: z
    .object({
      weights: z
        .object({
          source_quality_prior: z.number().default(0.25),
          category_prior: z.number().default(0.1),
          keyword_interest_score: z.number().default(0.1),
          semantic_interest_score: z.number().default(0.2),
          freshness_score: z.number().default(0.1),
          editorial_type_score: z.number().default(0.1),
          discovery_signal: z.number().default(0),
          source_uniqueness_score: z.number().default(0.15),
        })
        .default({}),
      penalties: z
        .object({
          source_volume_penalty: z.number().default(0.15),
          redundancy_penalty: z.number().default(0.2),
          clickbait_penalty: z.number().default(0.2),
          negative_interest_penalty: z.number().default(0.25),
        })
        .default({}),
      bands: z
        .object({
          a_min: z.number().default(0.473),
          b_min: z.number().default(0.37),
          c_min: z.number().default(0.32),
        })
        .default({}),
      luna_budget_per_run: z.number().int().positive().default(140),
      audit: z
        .object({
          band_c_sample_rate: probability.default(0.06),
          band_d_sample_rate: probability.default(0.01),
          max_per_run: z.number().int().min(0).default(8),
        })
        .default({}),
      keyword: z
        .object({
          title_weight: z.number().default(2),
          summary_weight: z.number().default(1),
          saturation_at: z.number().positive().default(3),
          /**
           * Credit for a multi-word interest whose words all appear but not as a
           * phrase ("videogame" and "design" separately). Exact phrases are rare
           * in headlines, so without this the whole component reads near zero.
           */
          partial_phrase_credit: z.number().min(0).max(1).default(0.6),
        })
        .default({}),
      semantic: z
        .object({
          include_source_name: z.boolean().default(true),
          max_chars: z.number().int().positive().default(1200),
          top_k_anchors: z.number().int().positive().default(3),
          rescale_min: z.number().default(0.1),
          rescale_max: z.number().default(0.55),
          negative_rescale_min: z.number().default(0.15),
          negative_rescale_max: z.number().default(0.5),
        })
        .default({}),
      editorial_type: z
        .object({
          scores: z.record(z.string(), probability).default({}),
          patterns: z.record(z.string(), z.array(z.string())).default({}),
        })
        .default({}),
      clickbait: z
        .object({
          patterns: z.array(z.string()).default([]),
          /** Off by default: all-caps is often stylistic, not clickbait. */
          shouting_enabled: z.boolean().default(false),
          shouting_uppercase_ratio: z.number().min(0).max(1).default(0.9),
          shouting_min_length: z.number().int().positive().default(24),
          per_match: z.number().default(0.35),
          max: z.number().default(1),
        })
        .default({}),
      freshness: z
        .object({
          default_content_type: z.string().default('unknown'),
          curves: z.record(z.string(), freshnessCurveSchema).default({}),
        })
        .default({}),
      source_volume: z
        .object({
          decay: z.array(z.number()).default([1, 0.92, 0.82, 0.68, 0.5, 0.36, 0.25]),
          tail: z.number().default(0.18),
          budget_scales_decay: z.boolean().default(true),
          hard_cap_per_run: z.number().int().positive().default(25),
        })
        .default({}),
      redundancy: z
        .object({
          near_duplicate_similarity: probability.default(0.94),
          cluster_member_penalty: z.number().default(0.45),
          differentiated_source_relief: z.number().default(0.5),
        })
        .default({}),
      exploration: z
        .object({
          min_items_for_confidence: z.number().int().positive().default(25),
          floor_blend: probability.default(0.6),
        })
        .default({}),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// final-ranking.yaml
// ---------------------------------------------------------------------------

export const finalRankingFileSchema = z.object({
  version: z.number().int().default(1),
  luna_gate: z
    .object({
      prompt: z.string().default('cheap-triage-v2'),
      weights: z
        .object({
          free_score: z.number().default(0.35),
          interest_match: z.number().default(0.45),
          novelty_likelihood: z.number().default(0.25),
          quality_prior: z.number().default(0.2),
          junk_probability: z.number().default(-1.2),
        })
        .default({}),
      threshold: z.number().default(0.52),
      category_thresholds: z.record(z.string(), z.number()).default({}),
      discounts: z
        .object({
          uncertain: z.number().default(0.1),
          needs_full_article: z.number().default(0.06),
          high_quality_source: z.number().default(0.12),
          band_a: z.number().default(0.06),
          exploration: z.number().default(0.15),
        })
        .default({}),
      trusted_quality_prior: probability.default(0.78),
      serendipity_bypass_max_junk: probability.default(0.35),
      terra_budget_per_run: z.number().int().positive().default(60),
      audit: z
        .object({
          rejected_sample_rate: probability.default(0.05),
          max_per_run: z.number().int().min(0).default(5),
        })
        .default({}),
    })
    .default({}),
  terra_gate: z
    .object({
      prompt: z.string().default('deep-ranking-v2'),
      restale_budget_fraction: probability.default(0.25),
      cluster: z
        .object({
          max_members_per_run: z.number().int().positive().default(3),
          second_member_min_free_score_ratio: z.number().default(0.85),
          second_member_min_uniqueness: probability.default(0.45),
        })
        .default({}),
      require_extraction: z.boolean().default(true),
    })
    .default({}),
  final_ranking: z
    .object({
      base_weights: z
        .object({
          terra_score: z.number().default(1),
          quality_prior: z.number().default(0.08),
          feed_weight: z.number().default(0.25),
          learned_source_value: z.number().default(0.12),
        })
        .default({}),
      source_diminishing: z
        .object({
          decay: z.array(z.number()).default([1, 0.9, 0.75, 0.55, 0.4, 0.28]),
          tail: z.number().default(0.2),
          hard_cap_per_feed_per_day: z.number().int().positive().default(6),
        })
        .default({}),
      topic_diminishing: z
        .object({
          decay: z.array(z.number()).default([1, 0.88, 0.72, 0.55, 0.42]),
          tail: z.number().default(0.3),
          cluster_decay: z.array(z.number()).default([1, 0.55, 0.25]),
          cluster_tail: z.number().default(0.1),
          cluster_max_duplicate_information: probability.default(0.45),
        })
        .default({}),
      correlation: z
        .object({
          enabled: z.boolean().default(true),
          min_shared_clusters: z.number().int().min(0).default(4),
          strength: z.number().default(0.25),
          max_penalty: z.number().default(0.35),
        })
        .default({}),
      attention: z
        .object({
          enabled: z.boolean().default(true),
          default_reading_minutes: z.number().positive().default(8),
          overflow_tolerance_minutes: z.number().min(0).default(10),
        })
        .default({}),
      exploration: z
        .object({
          fraction: probability.default(0.2),
          min_slots_per_day: z.number().int().min(0).default(1),
          min_anchor_distance: probability.default(0.5),
          min_serendipity: probability.default(0.5),
        })
        .default({}),
      max_feeds_per_item: z.number().int().positive().default(2),
      feed_priority: z.array(z.string()).default([]),
      feed_length: z.number().int().positive().default(60),
      tracked_links: z.boolean().default(true),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// feed-config.yaml
// ---------------------------------------------------------------------------

export const feedConfigSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  mode: z.enum(['weighted', 'serendipity']).default('weighted'),
  daily_cap: z.number().int().positive().default(8),
  target_items_per_day: z.tuple([z.number(), z.number()]).optional(),
  attention: z
    .object({ minutes_per_day: z.number().positive().nullable().default(null) })
    .default({}),
  min_score: z.number().default(0.5),
  categories: z.array(z.string()).default([]),
  /** Scales how much freshness contributes in this feed. 1 = normal. */
  freshness_weight: z.number().min(0).max(2).default(1),
  weights: z.record(z.string(), unit).default({}),
  quality_weights: z.record(z.string(), unit).default({}),
  gates: z.record(z.string(), z.number()).default({}),
  novelty_exponent: z.number().positive().default(1),
  distance_exponent: z.number().positive().default(1),
  /** Slots the portfolio builder may not spend on anything else. */
  protected_slots_per_day: z.number().int().min(0).default(0),
  diversity: z
    .object({
      max_per_category_per_day: z.number().int().positive().default(10),
      /** Per-feed override of final_ranking.source_diminishing.decay. */
      source_decay: z.array(z.number()).optional(),
      cluster_decay: z.array(z.number()).optional(),
    })
    .default({}),
});

export const feedFileSchema = z.object({
  version: z.number().int().default(1),
  categories: z.array(z.string()).min(1),
  feeds: z.array(feedConfigSchema).min(1),
});

// ---------------------------------------------------------------------------
// classics.yaml
// ---------------------------------------------------------------------------

const classicsSeedSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  source: z.string().min(1),
  author: z.string().optional(),
  published_at: z.string().optional(),
  discovery_source: z.string().default('curated_seed'),
});

export const classicsFileSchema = z.object({
  version: z.number().int().default(1),
  enabled: z.boolean().default(true),
  prompt: z.string().default('classics-ranking-v2'),
  feed: feedConfigSchema,
  discovery: z
    .object({
      min_age_days: z.number().int().positive().default(365),
      refresh_interval_days: z.number().positive().default(7),
      max_candidates: z.number().int().positive().default(1_500),
      prefetch_limit: z.number().int().positive().default(120),
      model_limit: z.number().int().positive().default(40),
      historical_hn: z
        .object({
          enabled: z.boolean().default(true),
          start_year: z.number().int().min(2006).default(2007),
          end_year: z.number().int().min(2006).optional(),
          min_points: z.number().int().nonnegative().default(150),
          min_comments: z.number().int().nonnegative().default(20),
          hits_per_year: z.number().int().min(1).max(1000).default(100),
        })
        .default({}),
      longreads: z
        .object({
          enabled: z.boolean().default(true),
          start_year: z.number().int().min(2009).default(2011),
          end_year: z.number().int().min(2009).optional(),
          hits_per_year: z.number().int().min(1).max(100).default(35),
        })
        .default({}),
      curated_seeds: z.array(classicsSeedSchema).default([]),
    })
    .default({}),
  eligibility: z
    .object({
      min_body_chars: z.number().int().positive().default(2_500),
      require_english: z.boolean().default(true),
      require_readability: z.boolean().default(true),
      reject_explicitly_paid: z.boolean().default(true),
    })
    .default({}),
  ranking: z
    .object({
      min_score: probability.default(0.84),
      min_predicted_read: probability.default(0.75),
      min_predicted_payoff: probability.default(0.90),
      weights: z.record(z.string(), z.number().min(0)).default({}),
      penalties: z.record(z.string(), z.number().min(0)).default({}),
      historical_signal_weight: z.number().min(0).max(0.2).default(0.02),
    })
    .default({}),
  publishing: z
    .object({
      max_per_run: z.number().int().positive().default(1),
      max_per_day: z.number().int().positive().default(1),
      feed_length: z.number().int().positive().default(60),
      diversity_lookback_days: z.number().int().positive().default(21),
      max_same_domain_in_lookback: z.number().int().positive().default(1),
      max_same_category_in_lookback: z.number().int().positive().default(3),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// briefing.yaml
// ---------------------------------------------------------------------------

/** "HH:MM", 24-hour, in the reader's local time. */
export const briefingTimeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'expected a 24-hour "HH:MM" time');

export const briefingFileSchema = z.object({
  version: z.number().int().default(1),
  enabled: z.boolean().default(true),
  /** Reuses the feed contract, so the briefing is scored by `scoreForFeed`. */
  feed: feedConfigSchema,
  /** Editions kept in the rendered feed. Two a day, so 60 is a month. */
  feed_length: z.number().int().positive().default(60),
  schedule: z
    .object({
      times: z.array(briefingTimeSchema).min(1).default(['08:00', '20:00']),
      /** `local` (host clock) or an IANA zone name. */
      timezone: z.string().min(1).default('local'),
      max_lateness_minutes: z.number().int().positive().default(360),
      /** How often the scheduler checks whether a slot has come due. */
      check_interval_minutes: z.number().int().positive().default(5),
    })
    .default({}),
  selection: z
    .object({
      items: z.number().int().positive().default(10),
      min_items: z.number().int().positive().default(4),
      window_hours: z.number().positive().default(14),
      max_age_hours: z.number().positive().default(36),
      max_per_cluster: z.number().int().positive().default(1),
      max_per_source: z.number().int().positive().default(3),
      repeat_across_editions: z.boolean().default(false),
    })
    .default({}),
  summary: z
    .object({
      max_chars: z.number().int().min(40).default(220),
      sources: z
        .array(z.enum(['publisher', 'why_it_surfaced']))
        .min(1)
        .default(['publisher', 'why_it_surfaced']),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// pipeline.yaml
// ---------------------------------------------------------------------------

export const pipelineFileSchema = z.object({
  version: z.number().int().default(1),
  ingest: z
    .object({
      poll_interval_minutes: z.number().int().positive().default(90),
      max_item_age_days: z.number().int().positive().default(14),
      max_items_per_source_per_poll: z.number().int().positive().default(60),
    })
    .default({}),
  extraction: z
    .object({
      enabled: z.boolean().default(true),
      respect_robots: z.boolean().default(true),
      max_bytes: z.number().int().positive().default(3_000_000),
      timeout_ms: z.number().int().positive().default(20_000),
      concurrency: z.number().int().positive().default(4),
      per_host_delay_ms: z.number().int().min(0).default(1500),
      cache_ttl_days: z.number().int().positive().default(30),
      min_extracted_chars: z.number().int().min(0).default(400),
      max_chars_for_model: z.number().int().positive().default(14_000),
    })
    .default({}),
  clustering: z
    .object({
      time_window_hours: z.number().positive().default(96),
      similarity_threshold: probability.default(0.845),
      title_similarity_threshold: probability.default(0.62),
      entity_similarity_threshold: probability.default(0.45),
      gist_similarity_threshold: probability.default(0.6),
      embedding_floor: probability.default(0.45),
      signal_weights: z
        .object({
          embedding: z.number().default(0.83),
          time_proximity: z.number().default(0.17),
          same_source_penalty: z.number().default(-0.17),
          fallback_entities: z.number().default(0.55),
          fallback_title: z.number().default(0.3),
          fallback_gist: z.number().default(0.2),
        })
        .default({}),
      same_story_confidence: probability.default(0.42),
      perspective: z
        .object({
          title_divergence_weight: z.number().default(0.6),
          wording_gap_weight: z.number().default(0.1),
          semantic_overlap_penalty: z.number().default(0.5),
          distinct_threshold: probability.default(0.1),
        })
        .default({}),
    })
    .default({}),
  alternate_formats: z
    .object({
      enabled: z.boolean().default(true),
      min_confidence: probability.default(0.72),
      weights: z.record(z.string(), z.number()).default({}),
      title_match_threshold: probability.default(0.7),
      semantic_similarity_threshold: probability.default(0.8),
      max_date_distance_hours: z.number().positive().default(96),
      spotify_links: z.boolean().default(true),
    })
    .default({}),
  feedback: z
    .object({
      poll_interval_minutes: z.number().int().positive().default(60),
      signal_weights: z.record(z.string(), z.number()).default({}),
      dedupe_opens: z.boolean().default(true),
    })
    .default({}),
  learning: z
    .object({
      enabled: z.boolean().default(true),
      learning_rate: probability.default(0.04),
      /** Bayesian smoothing: 2 good posts out of 2 must not make a source perfect. */
      prior_strength: z.number().positive().default(12),
      uniqueness_prior_strength: z.number().positive().default(8),
      uniqueness_calibration: z
        .object({
          min_multi_item_clusters: z.number().int().nonnegative().default(25),
          min_multi_item_rate: probability.default(0.08),
          max_sources_without_evidence: probability.default(0.1),
        })
        .default({}),
      value_function: z
        .object({
          surfaced: z.number().default(0),
          opened: z.number().default(1),
          explicit_positive: z.number().default(5),
          explicit_negative: z.number().default(-5),
        })
        .default({}),
      max_learned_source_value: z.number().default(0.4),
      min_learned_source_value: z.number().default(-0.25),
      max_interest_weight: z.number().default(2),
      min_interest_weight: z.number().default(0.2),
      min_events_before_update: z.number().int().min(0).default(8),
      protected_penalties: z.record(z.string(), z.number()).default({}),
      ignore_opens_when_ragebait_above: probability.default(0.35),
      exploration_fraction: probability.default(0.2),
    })
    .default({}),
  costs: z.object({ monthly_budget_warning: z.number().default(15) }).default({}),
});

// ---------------------------------------------------------------------------

export type SourceConfig = z.output<typeof sourceSchema> & {
  /** Always resolved by the loader, from the source or the file defaults. */
  lanes: Array<'feeds' | 'briefing' | 'classics'>;
  feed_type: 'article' | 'podcast' | 'linkblog';
  language: string;
  enabled: boolean;
  publishable: boolean;
  access: 'free' | 'mixed' | 'paywalled';
  item_kind: 'article' | 'product';
  quality_prior: number;
  volume_budget: number;
  exploration_floor: number;
};
export type SourceHardRules = z.output<typeof sourceHardRulesSchema>;
export type TasteProfile = z.output<typeof tasteProfileSchema>;
export type ReaderPreferences = z.output<typeof readerPreferencesSchema>;
export type ModelsConfig = z.output<typeof modelsFileSchema>;
export type ChatModelConfig = z.output<typeof chatModelSchema>;
export type EmbeddingModelConfig = z.output<typeof embeddingModelSchema>;
export type FreeRankingConfig = z.output<typeof freeRankingFileSchema>;
export type FinalRankingConfig = z.output<typeof finalRankingFileSchema>;
export type FeedConfig = z.output<typeof feedConfigSchema>;
export type FeedFileConfig = z.output<typeof feedFileSchema>;
export type ClassicsConfig = z.output<typeof classicsFileSchema>;
export type BriefingConfig = z.output<typeof briefingFileSchema>;
export type OptionalFeeds = z.output<typeof optionalFeedsSchema>;
export type PipelineConfig = z.output<typeof pipelineFileSchema>;
export type FreshnessCurve = z.output<typeof freshnessCurveSchema>;


// --- budget.yaml -----------------------------------------------------------

const modeSchema = z.object({
  monthly_target_usd: z.number().positive(),
  monthly_hard_limit_usd: z.number().positive(),
  free_reject_audit_rate: probability,
  luna_reject_audit_rate: probability,
  audit_max_per_run: z
    .object({
      free_to_luna: z.number().int().nonnegative().default(8),
      luna_to_terra: z.number().int().nonnegative().default(5),
    })
    .default({}),
  extra_diagnostics: z.boolean().default(false),
});

export type ModeConfig = z.output<typeof modeSchema>;

export const budgetFileSchema = z.object({
  mode: z.enum(['calibration', 'steady_state']).default('steady_state'),
  modes: z.record(z.string(), modeSchema),
  budget: z
    .object({
      luna_share_target: probability.default(0.1),
      terra_share_target: probability.default(0.9),
      calibration_share: probability.default(0.1),
      reset: z.enum(['monthly']).default('monthly'),
      degradation: z
        .array(
          z.object({
            at_fraction_of_target: z.number().nonnegative(),
            min_opportunity: probability,
            label: z.string(),
          }),
        )
        .min(1),
      hard_limit_reserved_for: z.array(z.string()).default([]),
      requeue_max_age_hours: z.record(z.string(), z.number().positive()).default({}),
    }),
  terra_opportunity: z
    .object({
      weights: z.record(z.string(), z.number()).default({}),
      penalties: z.record(z.string(), z.number()).default({}),
      uncertainty_bonus: z.number().default(0.1),
      saturated_feed_multiplier: z.number().default(0.55),
    })
    .default({}),
});

export type BudgetFile = z.output<typeof budgetFileSchema>;
