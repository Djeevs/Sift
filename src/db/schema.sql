-- ---------------------------------------------------------------------------
-- Sift schema.
--
-- Design rules:
--   * every AI judgement records model + prompt_version + config hash + raw JSON
--   * every stage writes its decision, including rejections, so nothing is lost
--   * ids are deterministic, so a rerun overwrites rather than duplicates
-- ---------------------------------------------------------------------------

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- --- Sources ---------------------------------------------------------------
-- Mirrors sources.yaml, plus learned state and fetch bookkeeping.
CREATE TABLE IF NOT EXISTS sources (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  feed_type           TEXT NOT NULL DEFAULT 'article',
  language            TEXT NOT NULL DEFAULT 'en',
  enabled             INTEGER NOT NULL DEFAULT 1,
  publishable         INTEGER NOT NULL DEFAULT 1,
  categories_json     TEXT NOT NULL DEFAULT '[]',
  config_prior        REAL NOT NULL DEFAULT 0,   -- from sources.yaml
  learned_prior       REAL NOT NULL DEFAULT 0,   -- adjusted by `npm run learn`
  etag                TEXT,
  last_modified       TEXT,
  last_fetch_at       INTEGER,
  last_success_at     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  disabled_until      INTEGER,                   -- backoff for broken feeds
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- --- Feed items ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_items (
  id                  TEXT PRIMARY KEY,          -- stable: source + guid/url
  source_id           TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid                TEXT,
  original_url        TEXT,
  canonical_url       TEXT,
  title               TEXT NOT NULL,
  subtitle            TEXT,
  rss_summary         TEXT,
  rss_content         TEXT,                      -- content:encoded when present
  author              TEXT,
  publication_time    INTEGER,
  feed_categories_json TEXT NOT NULL DEFAULT '[]',
  enclosure_url       TEXT,                      -- podcast/audio enclosure
  enclosure_type      TEXT,
  enclosure_length    INTEGER,
  duration_minutes    INTEGER,                   -- podcast episodes
  raw_feed_metadata   TEXT,                      -- JSON of anything else useful
  feed_images_json    TEXT NOT NULL DEFAULT '[]', -- original item-associated RSS/Atom images
  item_kind           TEXT NOT NULL DEFAULT 'article', -- article | product
  language            TEXT,
  is_podcast          INTEGER NOT NULL DEFAULT 0,
  first_seen_at       INTEGER NOT NULL,
  -- Pipeline state machine: one row always knows where it is.
  status              TEXT NOT NULL DEFAULT 'new',
  -- new | filtered | embedded | triaged | rejected_cheap | deep_queued
  -- | deep_evaluated | published | error | skipped_duplicate
  status_reason       TEXT,
  status_updated_at   INTEGER NOT NULL,
  error_count         INTEGER NOT NULL DEFAULT 0,
  cluster_id          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_guid ON feed_items(source_id, guid)
  WHERE guid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_canonical ON feed_items(canonical_url);
CREATE INDEX IF NOT EXISTS idx_items_status ON feed_items(status);
CREATE INDEX IF NOT EXISTS idx_items_pubtime ON feed_items(publication_time DESC);
CREATE INDEX IF NOT EXISTS idx_items_source ON feed_items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_cluster ON feed_items(cluster_id);
CREATE INDEX IF NOT EXISTS idx_items_first_seen ON feed_items(first_seen_at DESC);

-- --- Extracted article content --------------------------------------------
CREATE TABLE IF NOT EXISTS article_content (
  item_id           TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  fetched_url       TEXT,
  canonical_url     TEXT,
  title             TEXT,
  subtitle          TEXT,
  author            TEXT,
  published_at      INTEGER,
  body_text         TEXT,
  body_chars        INTEGER NOT NULL DEFAULT 0,
  word_count        INTEGER NOT NULL DEFAULT 0,
  reading_minutes   INTEGER,
  site_name         TEXT,
  lead_image_url    TEXT,
  structured_data   TEXT,                        -- JSON-LD blobs we kept
  audio_links       TEXT,                        -- JSON array of discovered audio
  extraction_method TEXT NOT NULL,               -- readability | rss_fallback | failed
  http_status       INTEGER,
  error             TEXT,
  fetched_at        INTEGER NOT NULL
);

-- --- Embeddings ------------------------------------------------------------
-- Stored as raw float32 blobs. Brute-force cosine in JS is far below the
-- noise floor at personal scale (tens of thousands of vectors).
CREATE TABLE IF NOT EXISTS embeddings (
  owner_type  TEXT NOT NULL,      -- item | anchor | avoid_anchor | podcast_episode
  owner_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  dimensions  INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  input_hash  TEXT NOT NULL,      -- so re-embedding is skipped when text is same
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id, model)
);

-- --- Story clusters --------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_clusters (
  id             TEXT PRIMARY KEY,
  cluster_topic  TEXT,
  representative_item_id TEXT,
  member_count   INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS story_cluster_members (
  cluster_id   TEXT NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  similarity   REAL NOT NULL DEFAULT 0,
  match_reason TEXT NOT NULL DEFAULT '',   -- canonical_url | title | embedding | entity
  signals_json TEXT,                       -- every contributing signal, for inspection
  perspective_distance REAL NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (cluster_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_members_item ON story_cluster_members(item_id);

-- --- Cheap triage ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS cheap_evaluations (
  item_id            TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  action             TEXT NOT NULL,          -- KEEP | DROP | UNCERTAIN
  categories_json    TEXT NOT NULL DEFAULT '[]',
  interest_match     REAL NOT NULL DEFAULT 0,
  novelty_likelihood REAL NOT NULL DEFAULT 0,
  junk_probability   REAL NOT NULL DEFAULT 0,
  needs_full_article INTEGER NOT NULL DEFAULT 0,
  serendipity_candidate INTEGER NOT NULL DEFAULT 0,
  gist               TEXT,
  anchor_similarity  REAL NOT NULL DEFAULT 0,  -- model-free embedding prior
  best_anchor_id     TEXT,
  avoid_similarity   REAL NOT NULL DEFAULT 0,
  triage_score       REAL NOT NULL DEFAULT 0,  -- code-level score
  threshold_used     REAL NOT NULL DEFAULT 0,
  passed             INTEGER NOT NULL DEFAULT 0,
  pass_reason        TEXT,
  is_audit_sample    INTEGER NOT NULL DEFAULT 0,
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  config_hash        TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  raw_json           TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cheap_passed ON cheap_evaluations(passed);
CREATE INDEX IF NOT EXISTS idx_cheap_audit ON cheap_evaluations(is_audit_sample);

-- --- Deep evaluation -------------------------------------------------------
CREATE TABLE IF NOT EXISTS deep_evaluations (
  item_id                  TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  personal_interest        REAL NOT NULL DEFAULT 0,
  intellectual_depth       REAL NOT NULL DEFAULT 0,
  novelty                  REAL NOT NULL DEFAULT 0,
  practical_usefulness     REAL NOT NULL DEFAULT 0,
  entertainment            REAL NOT NULL DEFAULT 0,
  storytelling             REAL NOT NULL DEFAULT 0,
  authorial_voice          REAL NOT NULL DEFAULT 0,
  critique                 REAL NOT NULL DEFAULT 0,
  humor                    REAL NOT NULL DEFAULT 0,
  obsessive_expertise      REAL NOT NULL DEFAULT 0,
  rabbit_hole              REAL NOT NULL DEFAULT 0,
  delight                  REAL NOT NULL DEFAULT 0,
  headline_sufficiency     REAL NOT NULL DEFAULT 0,
  source_quality           REAL NOT NULL DEFAULT 0,
  serendipity              REAL NOT NULL DEFAULT 0,
  ragebait                 REAL NOT NULL DEFAULT 0,
  duplicate_information    REAL NOT NULL DEFAULT 0,
  expected_attention_value REAL NOT NULL DEFAULT 0,
  category                 TEXT,
  recommended_feeds_json   TEXT NOT NULL DEFAULT '[]',
  why_it_surfaced          TEXT,
  estimated_reading_minutes INTEGER,
  anchor_distance          REAL NOT NULL DEFAULT 0,  -- for serendipity routing
  content_source           TEXT,                     -- full_article | rss_only
  is_audit_sample          INTEGER NOT NULL DEFAULT 0,
  model                    TEXT NOT NULL,
  prompt_version           TEXT NOT NULL,
  config_hash              TEXT NOT NULL,
  input_tokens             INTEGER NOT NULL DEFAULT 0,
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  raw_json                 TEXT,
  created_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deep_audit ON deep_evaluations(is_audit_sample);
CREATE INDEX IF NOT EXISTS idx_deep_created ON deep_evaluations(created_at DESC);

-- --- Routing decisions -----------------------------------------------------
-- Written for every (item, feed) pair considered, published or not, so
-- "why was this not in Essential?" is always answerable.
CREATE TABLE IF NOT EXISTS routing_decisions (
  item_id      TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  feed_id      TEXT NOT NULL,
  score        REAL NOT NULL,
  threshold    REAL NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL,
  config_hash  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (item_id, feed_id)
);

CREATE INDEX IF NOT EXISTS idx_routing_feed ON routing_decisions(feed_id, score DESC);

-- --- Alternate formats -----------------------------------------------------
CREATE TABLE IF NOT EXISTS alternate_formats (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  format_type    TEXT NOT NULL,  -- audio_version | podcast_version
                                 -- | companion_podcast | video_version | transcript
  url            TEXT NOT NULL,
  title          TEXT,
  publisher      TEXT,
  duration_minutes INTEGER,
  published_at   INTEGER,
  confidence     REAL NOT NULL,
  signals_json   TEXT NOT NULL DEFAULT '{}',
  spotify_url    TEXT,           -- public deeplink; no Spotify API involved
  source_episode_item_id TEXT,   -- when matched against an ingested podcast feed
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alt_item ON alternate_formats(item_id, confidence DESC);

-- --- Published output ------------------------------------------------------
CREATE TABLE IF NOT EXISTS published_feed_items (
  feed_id       TEXT NOT NULL,
  item_id       TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  score         REAL NOT NULL,
  rank_position INTEGER,
  why_it_surfaced TEXT,
  published_at  INTEGER NOT NULL,
  day_key       TEXT NOT NULL,
  PRIMARY KEY (feed_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_published_feed_time ON published_feed_items(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_published_day ON published_feed_items(feed_id, day_key);

-- --- Archival discovery ----------------------------------------------------
-- Candidates reuse feed_items/article_content for identity, extraction,
-- feedback, and open tracking, but have an independent discovery and ranking
-- lane so old work can never leak into an ordinary daily edition.
CREATE TABLE IF NOT EXISTS classics_candidates (
  item_id                TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  source_name            TEXT NOT NULL,
  original_author        TEXT,
  original_published_at  INTEGER,
  best_discovery_source  TEXT NOT NULL,
  discovery_sources_json TEXT NOT NULL DEFAULT '[]',
  historical_signal      REAL NOT NULL DEFAULT 0,
  hn_points              INTEGER NOT NULL DEFAULT 0,
  hn_comments            INTEGER NOT NULL DEFAULT 0,
  hn_submissions         INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'discovered',
  rejection_reason       TEXT,
  first_discovered_at    INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_classics_status ON classics_candidates(status, historical_signal DESC);
CREATE INDEX IF NOT EXISTS idx_classics_source ON classics_candidates(source_name);

CREATE TABLE IF NOT EXISTS classics_candidate_discoveries (
  item_id          TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  discovery_source TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  signal           REAL NOT NULL DEFAULT 0,
  metadata_json    TEXT NOT NULL DEFAULT '{}',
  discovered_at    INTEGER NOT NULL,
  PRIMARY KEY (item_id, discovery_source, external_id)
);

CREATE TABLE IF NOT EXISTS classics_evaluations (
  item_id                  TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  analysis                 REAL NOT NULL DEFAULT 0,
  storytelling             REAL NOT NULL DEFAULT 0,
  authorial_voice          REAL NOT NULL DEFAULT 0,
  entertainment            REAL NOT NULL DEFAULT 0,
  obsessive_expertise      REAL NOT NULL DEFAULT 0,
  rabbit_hole              REAL NOT NULL DEFAULT 0,
  critique                 REAL NOT NULL DEFAULT 0,
  humor                    REAL NOT NULL DEFAULT 0,
  enduring_value           REAL NOT NULL DEFAULT 0,
  personal_interest        REAL NOT NULL DEFAULT 0,
  historical_quality       REAL NOT NULL DEFAULT 0,
  homework                 REAL NOT NULL DEFAULT 0,
  datedness                REAL NOT NULL DEFAULT 0,
  ragebait                 REAL NOT NULL DEFAULT 0,
  predicted_read           REAL NOT NULL DEFAULT 0,
  predicted_payoff         REAL NOT NULL DEFAULT 0,
  predicted_satisfaction   REAL NOT NULL DEFAULT 0,
  archival_score           REAL NOT NULL DEFAULT 0,
  category                 TEXT NOT NULL DEFAULT 'other',
  pleasure_class           TEXT,
  why_picked               TEXT,
  enduring_reason          TEXT,
  model                    TEXT NOT NULL,
  prompt_version           TEXT NOT NULL,
  config_hash              TEXT NOT NULL,
  input_tokens             INTEGER NOT NULL DEFAULT 0,
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  raw_json                 TEXT,
  created_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_classics_score ON classics_evaluations(archival_score DESC);

-- --- Feedback --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS open_events (
  id           TEXT PRIMARY KEY,      -- deterministic when deduping is on
  item_id      TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  feed_id      TEXT,
  original_url TEXT NOT NULL,
  opened_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_open_item ON open_events(item_id);

CREATE TABLE IF NOT EXISTS explicit_feedback (
  id           TEXT PRIMARY KEY,      -- deterministic: item + signal + source
  item_id      TEXT REFERENCES feed_items(id) ON DELETE CASCADE,
  signal       TEXT NOT NULL,         -- excellent | not_for_me
  origin       TEXT NOT NULL,         -- reeder_feed | manual | admin
  matched_by   TEXT,                  -- url | title | tracked_link
  raw_title    TEXT,
  raw_url      TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_item ON explicit_feedback(item_id);

-- --- Taste profile versions ------------------------------------------------
CREATE TABLE IF NOT EXISTS taste_profile_versions (
  id            TEXT PRIMARY KEY,
  config_hash   TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,       -- full profile + learned adjustments
  note          TEXT,
  created_at    INTEGER NOT NULL
);

-- Learned adjustments, kept separate from the YAML you hand-edit.
CREATE TABLE IF NOT EXISTS learned_weights (
  scope       TEXT NOT NULL,   -- source | anchor | category | trait
  key         TEXT NOT NULL,
  value       REAL NOT NULL,
  events      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

-- --- Jobs, runs and errors -------------------------------------------------
CREATE TABLE IF NOT EXISTS processing_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,        -- ingest | process | publish | feedback | learn
  status       TEXT NOT NULL,        -- running | ok | failed
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  stats_json   TEXT NOT NULL DEFAULT '{}',
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_kind ON processing_jobs(kind, started_at DESC);

CREATE TABLE IF NOT EXISTS processing_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,        -- source id, item id, or stage name
  stage       TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_errors_created ON processing_errors(created_at DESC);

-- --- Cost ledger -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stage         TEXT NOT NULL,      -- embedding | cheap | deep
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  -- Of input_tokens, how many the provider served from its prompt cache.
  -- Lets us verify caching is actually working rather than assuming it.
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  requests      INTEGER NOT NULL DEFAULT 1,
  estimated_cost REAL NOT NULL DEFAULT 0,
  job_id        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage(created_at DESC);

-- --- Batch tracking (provider batch API) -----------------------------------
CREATE TABLE IF NOT EXISTS batch_jobs (
  id              TEXT PRIMARY KEY,   -- provider batch id
  stage           TEXT NOT NULL,
  status          TEXT NOT NULL,      -- submitted | in_progress | completed | failed | expired
  item_ids_json   TEXT NOT NULL,
  input_file_id   TEXT,
  output_file_id  TEXT,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  submitted_at    INTEGER NOT NULL,
  completed_at    INTEGER,
  error           TEXT
);

-- ===========================================================================
-- Funnel architecture tables (stages 2, 3, 4, 5, 6)
--
-- Every boundary in the funnel writes down what it decided and why, so both
-- questions are answerable without guessing:
--   "why did this article reach me?"  and  "why did this article disappear?"
-- ===========================================================================

-- --- Stage 2: rule filtering ----------------------------------------------
CREATE TABLE IF NOT EXISTS rule_filter_evaluations (
  item_id        TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  filter_result  TEXT NOT NULL,      -- keep | drop
  filter_reason  TEXT NOT NULL,
  filter_version INTEGER NOT NULL,
  matched_rule   TEXT,               -- the specific pattern or rule that fired
  rule_scope     TEXT,               -- global | source | derived
  is_thin        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_filter_result ON rule_filter_evaluations(filter_result);

-- --- Stage 3: free scoring --------------------------------------------------
-- Components are stored individually, never only the final number: a score you
-- cannot take apart is an opaque recommender.
CREATE TABLE IF NOT EXISTS free_score_components (
  item_id                 TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  source_quality_prior    REAL NOT NULL DEFAULT 0,
  category_prior          REAL NOT NULL DEFAULT 0,
  keyword_interest_score  REAL NOT NULL DEFAULT 0,
  semantic_interest_score REAL NOT NULL DEFAULT 0,
  freshness_score         REAL NOT NULL DEFAULT 0,
  editorial_type_score    REAL NOT NULL DEFAULT 0,
  discovery_signal        REAL NOT NULL DEFAULT 0.5,
  source_uniqueness_score REAL NOT NULL DEFAULT 0,
  source_volume_penalty   REAL NOT NULL DEFAULT 0,
  redundancy_penalty      REAL NOT NULL DEFAULT 0,
  clickbait_penalty       REAL NOT NULL DEFAULT 0,
  negative_interest_penalty REAL NOT NULL DEFAULT 0,
  free_score              REAL NOT NULL DEFAULT 0,
  band                    TEXT NOT NULL DEFAULT 'D',   -- A | B | C | D
  -- Supporting detail that explains the components above.
  editorial_type          TEXT,
  content_type            TEXT,       -- which freshness curve was applied
  best_anchor_id          TEXT,
  anchor_distance         REAL NOT NULL DEFAULT 0,
  source_rank_in_run      INTEGER NOT NULL DEFAULT 0,  -- 1 = best from its source
  semantic_provider       TEXT,       -- openai | hash | none
  config_version          INTEGER NOT NULL DEFAULT 0,
  config_hash             TEXT NOT NULL DEFAULT '',
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_free_score ON free_score_components(free_score DESC);
CREATE INDEX IF NOT EXISTS idx_free_band ON free_score_components(band);

-- --- Source statistics ------------------------------------------------------
-- Learned, empirical, and kept strictly separate from the priors in
-- sources.yaml. Both are combined at scoring time; neither overwrites the other.
CREATE TABLE IF NOT EXISTS source_statistics (
  source_id           TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  items_seen          INTEGER NOT NULL DEFAULT 0,
  items_surfaced      INTEGER NOT NULL DEFAULT 0,
  items_opened        INTEGER NOT NULL DEFAULT 0,
  explicit_positive   INTEGER NOT NULL DEFAULT 0,
  explicit_negative   INTEGER NOT NULL DEFAULT 0,
  -- Smoothed value in roughly -1..1. Bayesian-style: needs evidence to move.
  learned_value       REAL NOT NULL DEFAULT 0,
  -- 1 - (share of items redundant with another source's coverage).
  uniqueness          REAL NOT NULL DEFAULT 0.5,
  clustered_items     INTEGER NOT NULL DEFAULT 0,
  redundant_items     INTEGER NOT NULL DEFAULT 0,
  -- Rolling mean of Terra's expected_attention_value for this source.
  mean_terra_value    REAL,
  terra_evaluations   INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_category_statistics (
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  items_seen        INTEGER NOT NULL DEFAULT 0,
  items_surfaced    INTEGER NOT NULL DEFAULT 0,
  explicit_positive INTEGER NOT NULL DEFAULT 0,
  explicit_negative INTEGER NOT NULL DEFAULT 0,
  learned_value     REAL NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (source_id, category)
);

-- Two sources that keep covering the same clusters carry correlated
-- information. Used to discount the second one's marginal value in an edition.
CREATE TABLE IF NOT EXISTS source_overlap_statistics (
  source_a        TEXT NOT NULL,
  source_b        TEXT NOT NULL,
  shared_clusters INTEGER NOT NULL DEFAULT 0,
  a_clusters      INTEGER NOT NULL DEFAULT 0,
  b_clusters      INTEGER NOT NULL DEFAULT 0,
  overlap         REAL NOT NULL DEFAULT 0,   -- shared / min(a, b)
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (source_a, source_b)
);

-- --- Audit sampling ---------------------------------------------------------
-- Preserved samples of rejected items at every significant boundary. The point
-- is measuring false negatives, so these never enter a feed automatically.
CREATE TABLE IF NOT EXISTS audit_samples (
  item_id          TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  boundary         TEXT NOT NULL,   -- free_to_luna | luna_to_terra
  normal_decision  TEXT NOT NULL,   -- what would have happened
  audit_selected   INTEGER NOT NULL DEFAULT 1,
  audit_result     TEXT,            -- filled in once the stage has run
  downstream_score REAL,            -- the score the deeper stage produced
  would_have_published INTEGER,     -- 1 if it would have reached a feed
  band             TEXT,
  free_score       REAL,
  sample_rate      REAL,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  PRIMARY KEY (item_id, boundary)
);

CREATE INDEX IF NOT EXISTS idx_audit_boundary ON audit_samples(boundary, created_at DESC);

-- --- Stage 6: final ranking -------------------------------------------------
-- One row per (item, feed) considered, with every adjustment that moved it.
CREATE TABLE IF NOT EXISTS final_ranking_decisions (
  item_id           TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  feed_id           TEXT NOT NULL,
  base_score        REAL NOT NULL DEFAULT 0,   -- from Terra + feed formula
  feed_weight       REAL NOT NULL DEFAULT 1,
  quality_adjust    REAL NOT NULL DEFAULT 0,
  learned_adjust    REAL NOT NULL DEFAULT 0,
  source_penalty    REAL NOT NULL DEFAULT 1,   -- multiplicative, 1 = none
  topic_penalty     REAL NOT NULL DEFAULT 1,
  cluster_penalty   REAL NOT NULL DEFAULT 1,
  correlation_penalty REAL NOT NULL DEFAULT 1,
  final_score       REAL NOT NULL DEFAULT 0,
  threshold         REAL NOT NULL DEFAULT 0,
  selection_order   INTEGER,                   -- pick order within the edition
  published         INTEGER NOT NULL DEFAULT 0,
  exploration_slot  INTEGER NOT NULL DEFAULT 0,
  reason            TEXT NOT NULL DEFAULT '',
  estimated_minutes REAL,
  config_hash       TEXT NOT NULL DEFAULT '',
  day_key           TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (item_id, feed_id)
);

CREATE INDEX IF NOT EXISTS idx_final_feed ON final_ranking_decisions(feed_id, final_score DESC);
CREATE INDEX IF NOT EXISTS idx_final_day ON final_ranking_decisions(day_key, feed_id);

-- --- Attention --------------------------------------------------------------
-- One article is not one article: a 35-minute essay costs far more than a
-- 4-minute post, and feeds are budgeted in minutes as well as items.
CREATE TABLE IF NOT EXISTS attention_estimates (
  item_id          TEXT PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
  reading_minutes  REAL,
  listening_minutes REAL,
  word_count       INTEGER,
  source           TEXT NOT NULL,   -- extracted | terra | enclosure | default
  created_at       INTEGER NOT NULL
);

-- --- Cost per stage ---------------------------------------------------------
-- api_usage records individual calls; this rolls a run up per stage so the
-- funnel report can show cost per surfaced/opened/positive item.
CREATE TABLE IF NOT EXISTS pipeline_costs (
  job_id        TEXT NOT NULL,
  stage         TEXT NOT NULL,     -- aggregate | rules | free | luna | terra | final
  items_in      INTEGER NOT NULL DEFAULT 0,
  items_out     INTEGER NOT NULL DEFAULT 0,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (job_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_costs_time ON pipeline_costs(created_at DESC);

-- --- Terra allocation -------------------------------------------------------
-- Why an item did or did not get a deep evaluation. Separate from
-- final_ranking_decisions because this is about spending money, not about
-- editorial merit -- an item can be excellent and still not worth buying today.
CREATE TABLE IF NOT EXISTS terra_allocation_decisions (
  item_id          TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  job_id           TEXT,
  opportunity      REAL NOT NULL,
  components_json  TEXT NOT NULL DEFAULT '{}',
  feed_need        REAL NOT NULL DEFAULT 0,
  min_opportunity  REAL NOT NULL DEFAULT 0,
  budget_stage     TEXT NOT NULL DEFAULT '',
  selected         INTEGER NOT NULL DEFAULT 0,
  reason           TEXT NOT NULL DEFAULT '',
  is_audit         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (item_id, created_at)
);

CREATE INDEX IF NOT EXISTS idx_terra_alloc_item ON terra_allocation_decisions(item_id);
CREATE INDEX IF NOT EXISTS idx_terra_alloc_created ON terra_allocation_decisions(created_at);

-- Month-to-date spend snapshots, so budget history survives even if api_usage
-- is pruned.
CREATE TABLE IF NOT EXISTS budget_snapshots (
  month_key        TEXT NOT NULL,
  job_id           TEXT,
  spent_usd        REAL NOT NULL,
  luna_usd         REAL NOT NULL,
  terra_usd        REAL NOT NULL,
  target_usd       REAL NOT NULL,
  hard_limit_usd   REAL NOT NULL,
  projected_usd    REAL NOT NULL,
  stage            TEXT NOT NULL,
  mode             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (month_key, created_at)
);

-- --- The twice-daily briefing ----------------------------------------------
-- A briefing is one *edition* per slot, not a set of published items, so it
-- gets its own tables rather than rows in published_feed_items.
--
-- That separation is the whole design. published_feed_items is what every other
-- stage treats as "already recommended": publishEdition and publishClassics
-- both skip any item that appears in it. Writing briefing lines there would
-- have made a mention on line seven of the morning briefing permanently
-- disqualify that article from Essential -- the briefing would quietly consume
-- the feeds it is meant to summarise. Overlap between the briefing and the
-- feeds is intended.
CREATE TABLE IF NOT EXISTS briefing_editions (
  id             TEXT PRIMARY KEY,
  feed_id        TEXT NOT NULL,
  -- Local day, not the UTC day_key used for daily caps: a briefing is a
  -- time-of-day ritual, and "the 8am one" must mean the reader's 8am.
  local_day      TEXT NOT NULL,
  slot           TEXT NOT NULL,
  slot_label     TEXT NOT NULL DEFAULT '',
  -- When the slot was due, and when it was actually built. They differ whenever
  -- the Mac was asleep, and the gap is what max_lateness_minutes bounds.
  scheduled_for  INTEGER NOT NULL,
  published_at   INTEGER NOT NULL,
  item_count     INTEGER NOT NULL DEFAULT 0,
  candidates     INTEGER NOT NULL DEFAULT 0,
  window_start   INTEGER NOT NULL,
  -- The hash of briefing.yaml, not the combined `ranking` identity the feeds
  -- record. A briefing weight cannot move a feed placement and a feed weight
  -- cannot move a briefing line, so sharing one hash would mark every stored
  -- decision as made under a changed config whenever either was touched. The
  -- Terra scores behind each line carry their own hash in deep_evaluations.
  config_hash    TEXT NOT NULL DEFAULT '',
  UNIQUE (feed_id, local_day, slot)
);

CREATE INDEX IF NOT EXISTS idx_briefing_editions_time ON briefing_editions(feed_id, published_at DESC);

CREATE TABLE IF NOT EXISTS briefing_edition_items (
  edition_id     TEXT NOT NULL REFERENCES briefing_editions(id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  rank_position  INTEGER NOT NULL,
  score          REAL NOT NULL,
  -- The summary is frozen at build time. It is assembled from the publisher's
  -- own words, and an edition already delivered to a reader must not change
  -- because an extraction or re-evaluation later replaced its source text.
  summary        TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (edition_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_briefing_items_item ON briefing_edition_items(item_id);
