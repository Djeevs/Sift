import type { AppConfig, FreshnessCurve, SourceConfig } from '../config/index.js';
import { categoryPrior } from '../config/index.js';
import { tokenize } from '../util/text.js';
import { DAY_MS } from '../util/time.js';

/**
 * Stage 3: free scoring.
 *
 * This layer answers exactly one question, and it is NOT "is this article good?":
 *
 *     Is this article worth spending money to understand?
 *
 * Everything here is deterministic, free, and pure. No model calls, no database,
 * no clock reads beyond the `now` passed in -- so a score can be recomputed
 * identically from stored inputs, and every component is inspectable rather than
 * folded into one opaque number.
 *
 * The components deliberately measure *opportunity*, not merit: a source prior
 * says how much benefit of the doubt to extend, not that this article is good.
 * That distinction is why source weight fades at every later stage.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface FreeScoreInput {
  id: string;
  sourceId: string;
  title: string;
  subtitle: string | null;
  summary: string | null;
  publicationTime: number | null;
  firstSeenAt: number;
  feedCategories: string[];
  /** Cosine similarities to interest anchors, highest first. */
  anchorSimilarities: number[];
  /** Highest similarity to any avoid anchor. */
  avoidSimilarity: number;
  bestAnchorId: string | null;
  /** Category the anchors/feed suggest, used for category_prior. */
  category: string;
  /** 1 = best-scoring item from this source in this run. */
  sourceRankInRun: number;
  /** Learned uniqueness for the source (0..1). 0.5 when unknown. */
  sourceUniqueness: number;
  /** True when this item joined a cluster that already has a stronger member. */
  isRedundantInCluster: boolean;
  /** Cosine similarity to the nearest already-scored item, if any. */
  nearestNeighbourSimilarity: number;
  /** How many items this source has ever contributed (for exploration). */
  sourceItemsSeen: number;
  /** Whether real embeddings were available for this item. */
  semanticAvailable: boolean;
  /** Secondary popularity/novelty evidence from a discovery service. */
  discoverySignal?: number;
}

export interface FreeScoreComponents {
  source_quality_prior: number;
  category_prior: number;
  keyword_interest_score: number;
  semantic_interest_score: number;
  freshness_score: number;
  editorial_type_score: number;
  discovery_signal: number;
  source_uniqueness_score: number;
  source_volume_penalty: number;
  redundancy_penalty: number;
  clickbait_penalty: number;
  negative_interest_penalty: number;
  free_score: number;
}

export type Band = 'A' | 'B' | 'C' | 'D';

export interface FreeScoreResult extends FreeScoreComponents {
  band: Band;
  editorialType: string;
  contentType: string;
  anchorDistance: number;
  explanation: string[];
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp | null>();

function compile(pattern: string, flags = 'i'): RegExp | null {
  const key = `${flags}:${pattern}`;
  if (regexCache.has(key)) return regexCache.get(key)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = null; // an invalid pattern in config must not break scoring
  }
  regexCache.set(key, re);
  return re;
}

/**
 * What *kind* of thing this looks like. Crude on purpose: it only needs to
 * separate an essay from a press release, and it also selects the freshness curve.
 */
export function classifyEditorialType(
  input: { title: string; subtitle: string | null; summary: string | null },
  source: SourceConfig | undefined,
  config: AppConfig,
): string {
  const override = source?.hard_rules?.content_type;
  if (override) return override;

  const cfg = config.free.free_ranking.editorial_type;
  const haystack = [input.title, input.subtitle ?? '', (input.summary ?? '').slice(0, 400)].join(' ');

  for (const [type, patterns] of Object.entries(cfg.patterns)) {
    for (const p of patterns) {
      if (compile(p)?.test(haystack)) return type;
    }
  }
  // A link blog is a type in its own right, not "unknown".
  if (source?.feed_type === 'linkblog') return 'linkblog';
  return 'unknown';
}

export function editorialTypeScore(type: string, config: AppConfig): number {
  const scores = config.free.free_ranking.editorial_type.scores;
  return scores[type] ?? scores['unknown'] ?? 0.55;
}

/**
 * Freshness, per content type. One global decay curve would be wrong: a games
 * history piece is not stale at three weeks and a hardware rumour is stale in a
 * day.
 */
export function freshnessScore(
  publishedAt: number | null,
  firstSeenAt: number,
  contentType: string,
  config: AppConfig,
  now: number,
): { score: number; curve: FreshnessCurve } {
  const curves = config.free.free_ranking.freshness.curves;
  const fallbackName = config.free.free_ranking.freshness.default_content_type;
  const curve =
    curves[contentType] ??
    curves[fallbackName] ?? { half_life_days: 14, expires_after_days: null, floor: 0.3 };

  const timestamp = publishedAt ?? firstSeenAt;
  const ageDays = Math.max(0, (now - timestamp) / DAY_MS);
  // Exponential decay to a floor: half_life_days is where it reaches 0.5.
  const decayed = Math.pow(0.5, ageDays / curve.half_life_days);
  const score = curve.floor + (1 - curve.floor) * decayed;
  return { score: Math.max(0, Math.min(1, score)), curve };
}

/** Has this content type outlived its usefulness? Drives the stale-news rule. */
export function isExpired(
  publishedAt: number | null,
  contentType: string,
  config: AppConfig,
  now: number,
): { expired: boolean; afterDays: number | null } {
  const curves = config.free.free_ranking.freshness.curves;
  const curve = curves[contentType];
  const afterDays = curve?.expires_after_days ?? null;
  if (afterDays === null || publishedAt === null) return { expired: false, afterDays };
  return { expired: now - publishedAt > afterDays * DAY_MS, afterDays };
}

/**
 * Lexical interest: how many of the reader's stated interests appear, weighted by
 * where. Complementary to embeddings rather than a substitute -- it catches exact
 * proper nouns ("FromSoftware", "Amsterdam") that cosine similarity blurs.
 */
export function keywordInterestScore(
  input: { title: string; subtitle: string | null; summary: string | null },
  config: AppConfig,
): number {
  const cfg = config.free.free_ranking.keyword;
  const interests = config.taste.strong_interests;
  if (interests.length === 0) return 0;

  const title = input.title.toLowerCase();
  const body = `${input.subtitle ?? ''} ${input.summary ?? ''}`.toLowerCase();

  let weighted = 0;
  for (const interest of interests) {
    const needle = interest.toLowerCase();

    if (!needle.includes(' ')) {
      // Word-boundary match on the raw text rather than on tokens. The tokenizer
      // drops anything under three characters, which silently discarded "AI" and
      // "UX" -- two of the most important terms this reader has.
      if (containsWord(title, needle)) weighted += cfg.title_weight;
      else if (containsWord(body, needle)) weighted += cfg.summary_weight;
      continue;
    }

    // Multi-word interests almost never appear verbatim -- nobody writes a
    // headline containing the phrase "videogame design". An exact phrase match
    // scores full weight; all of its significant words appearing separately
    // scores a fraction, which is what actually fires in practice.
    const words = needle.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) continue;

    if (title.includes(needle)) {
      weighted += cfg.title_weight;
    } else if (body.includes(needle)) {
      weighted += cfg.summary_weight;
    } else if (words.every((w) => containsWord(title, w))) {
      weighted += cfg.title_weight * cfg.partial_phrase_credit;
    } else if (words.every((w) => containsWord(body, w))) {
      weighted += cfg.summary_weight * cfg.partial_phrase_credit;
    }
  }

  // Saturating: five mentions is not five times one.
  return Math.min(1, weighted / (cfg.saturation_at * cfg.title_weight));
}

/**
 * Whole-word containment on raw lowercase text. Used instead of the tokenizer
 * because that filters short words, and "AI" and "UX" are neither noise nor
 * optional here.
 */
function containsWord(haystack: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is unreliable next to non-ASCII, so boundaries are explicit.
  const re = compile(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re ? re.test(haystack) : haystack.includes(word);
}

function rescale(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Mean of the top-k anchor similarities, rescaled to spread the useful range. */
export function semanticInterestScore(anchorSimilarities: number[], config: AppConfig): number {
  const cfg = config.free.free_ranking.semantic;
  if (anchorSimilarities.length === 0) return 0;
  const top = [...anchorSimilarities].sort((a, b) => b - a).slice(0, cfg.top_k_anchors);
  const mean = top.reduce((s, v) => s + v, 0) / top.length;
  return rescale(mean, cfg.rescale_min, cfg.rescale_max);
}

export function negativeInterestPenalty(avoidSimilarity: number, config: AppConfig): number {
  const cfg = config.free.free_ranking.semantic;
  return rescale(avoidSimilarity, cfg.negative_rescale_min, cfg.negative_rescale_max);
}

/** Structural clickbait tells only. Judging manipulation properly is Terra's job. */
export function clickbaitPenalty(title: string, config: AppConfig): number {
  const cfg = config.free.free_ranking.clickbait;
  let matches = 0;
  for (const pattern of cfg.patterns) {
    if (compile(pattern)?.test(title)) matches += 1;
  }
  if (isShouting(title, config)) matches += 1;
  return Math.min(cfg.max, matches * cfg.per_match);
}

/**
 * A SHOUTING HEADLINE -- disabled by default, and deliberately so.
 *
 * All-caps is a weak clickbait signal and a strong false-positive risk: acronym
 * dense titles read as caps, some publishers set every headline in caps (which
 * would penalise the source rather than the article), and plenty of honest
 * headlines are emphatic. The mechanism is kept because it is occasionally the
 * right tool for one misbehaving source, but it is opt-in per configuration.
 *
 * Lives in code rather than in `patterns` because patterns are compiled
 * case-insensitively, so an all-caps regex would match any letters-only title.
 */
export function isShouting(title: string, config: AppConfig): boolean {
  const cfg = config.free.free_ranking.clickbait;
  if (!cfg.shouting_enabled) return false;
  const letters = title.replace(/[^a-zA-Z]/g, '');
  if (letters.length < cfg.shouting_min_length) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= cfg.shouting_uppercase_ratio;
}

/**
 * Diminishing returns for a source's Nth-best item in this run -- not a cap.
 * Returned as a penalty in 0..1 so it composes with the other penalties, and so
 * an exceptional fourth item can still outscore a mediocre first one.
 */
export function sourceVolumePenalty(
  rankInRun: number,
  source: SourceConfig | undefined,
  config: AppConfig,
): number {
  const cfg = config.free.free_ranking.source_volume;
  if (rankInRun <= 1) return 0;

  // A tight volume_budget compresses the curve: the source hits the steep part
  // sooner, without ever being hard-capped for it.
  const budget = source?.volume_budget ?? 1;
  const effectiveIndex = cfg.budget_scales_decay && budget > 0
    ? Math.floor((rankInRun - 1) / Math.max(0.2, budget))
    : rankInRun - 1;

  const multiplier = cfg.decay[effectiveIndex] ?? cfg.tail;
  return Math.max(0, 1 - multiplier);
}

export function redundancyPenalty(
  input: Pick<FreeScoreInput, 'isRedundantInCluster' | 'nearestNeighbourSimilarity' | 'sourceUniqueness'>,
  config: AppConfig,
): number {
  const cfg = config.free.free_ranking.redundancy;
  let penalty = 0;

  if (input.nearestNeighbourSimilarity >= cfg.near_duplicate_similarity) {
    penalty = 1; // effectively the same text as something already scored
  } else if (input.isRedundantInCluster) {
    penalty = cfg.cluster_member_penalty;
    // A differentiated source covering the same story is the case worth keeping:
    // the technical explainer plus the sceptical critique.
    const relief = cfg.differentiated_source_relief * input.sourceUniqueness;
    penalty *= Math.max(0, 1 - relief);
  }

  return Math.max(0, Math.min(1, penalty));
}

/**
 * Blend a source's quality prior toward its exploration floor while it has too
 * little history to judge, so a new source cannot be scored into permanent
 * invisibility before it has had a chance.
 */
export function explorationAdjustedQuality(
  source: SourceConfig | undefined,
  itemsSeen: number,
  config: AppConfig,
): { quality: number; exploring: boolean } {
  const quality = source?.quality_prior ?? 0.55;
  const cfg = config.free.free_ranking.exploration;
  if (itemsSeen >= cfg.min_items_for_confidence) return { quality, exploring: false };

  const floor = source?.exploration_floor ?? 0.08;
  // Below the confidence threshold, lift low priors toward a floor-derived value.
  const floorValue = Math.max(quality, 0.5 + floor);
  const blended = quality + cfg.floor_blend * (floorValue - quality);
  return { quality: Math.max(0, Math.min(1, blended)), exploring: true };
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

export function bandFor(score: number, config: AppConfig): Band {
  const b = config.free.free_ranking.bands;
  if (score >= b.a_min) return 'A';
  if (score >= b.b_min) return 'B';
  if (score >= b.c_min) return 'C';
  return 'D';
}

/**
 * Combine the components. Positive weights are normalised by their own total so
 * the positive part lands in 0..1 regardless of how the weights are tuned;
 * penalties then subtract. That keeps the band thresholds meaningful after a
 * weight change instead of silently rescaling the whole distribution.
 */
export function computeFreeScore(
  input: FreeScoreInput,
  source: SourceConfig | undefined,
  config: AppConfig,
  now: number = Date.now(),
): FreeScoreResult {
  const fr = config.free.free_ranking;
  const explanation: string[] = [];

  const editorialType = classifyEditorialType(input, source, config);
  const contentType = source?.hard_rules?.content_type ?? editorialType;
  const { score: freshness } = freshnessScore(
    input.publicationTime,
    input.firstSeenAt,
    contentType,
    config,
    now,
  );

  const { quality, exploring } = explorationAdjustedQuality(source, input.sourceItemsSeen, config);
  if (exploring) explanation.push(`source under-sampled (${input.sourceItemsSeen} items), quality lifted toward its exploration floor`);

  const components: FreeScoreComponents = {
    source_quality_prior: quality,
    category_prior: categoryPrior(source, input.category),
    keyword_interest_score: keywordInterestScore(input, config),
    semantic_interest_score: input.semanticAvailable
      ? semanticInterestScore(input.anchorSimilarities, config)
      : 0,
    freshness_score: freshness,
    editorial_type_score: editorialTypeScore(editorialType, config),
    discovery_signal: Math.max(0, Math.min(1, input.discoverySignal ?? 0.5)),
    source_uniqueness_score: input.sourceUniqueness,
    source_volume_penalty: sourceVolumePenalty(input.sourceRankInRun, source, config),
    redundancy_penalty: redundancyPenalty(input, config),
    clickbait_penalty: clickbaitPenalty(input.title, config),
    negative_interest_penalty: input.semanticAvailable
      ? negativeInterestPenalty(input.avoidSimilarity, config)
      : 0,
    free_score: 0,
  };

  // Positive part, normalised by total positive weight.
  const w = fr.weights;
  let positive = 0;
  let weightSum = 0;
  const positiveKeys: Array<keyof typeof w> = [
    'source_quality_prior',
    'category_prior',
    'keyword_interest_score',
    'semantic_interest_score',
    'freshness_score',
    'editorial_type_score',
    'discovery_signal',
    'source_uniqueness_score',
  ];
  for (const key of positiveKeys) {
    const weight = w[key];
    if (!weight) continue;
    positive += weight * components[key];
    weightSum += weight;
  }
  if (weightSum > 0) positive /= weightSum;

  // When semantic scoring is unavailable its weight would silently drag every
  // score down, so it is removed from the denominator instead.
  if (!input.semanticAvailable && w.semantic_interest_score) {
    const withoutSemantic = weightSum - w.semantic_interest_score;
    if (withoutSemantic > 0) {
      positive = (positive * weightSum) / withoutSemantic;
      explanation.push('semantic scoring unavailable; its weight was redistributed');
    }
  }

  const p = fr.penalties;
  const penalty =
    p.source_volume_penalty * components.source_volume_penalty +
    p.redundancy_penalty * components.redundancy_penalty +
    p.clickbait_penalty * components.clickbait_penalty +
    p.negative_interest_penalty * components.negative_interest_penalty;

  components.free_score = Math.max(0, Math.min(1, positive - penalty));

  const band = bandFor(components.free_score, config);

  if (components.source_volume_penalty > 0) {
    explanation.push(
      `#${input.sourceRankInRun} from this source in this run (-${components.source_volume_penalty.toFixed(2)} before weighting)`,
    );
  }
  if (components.redundancy_penalty > 0) {
    explanation.push(`redundant with existing coverage (-${components.redundancy_penalty.toFixed(2)})`);
  }
  if (components.clickbait_penalty > 0) {
    explanation.push(`clickbait pattern in the headline (-${components.clickbait_penalty.toFixed(2)})`);
  }
  if (components.negative_interest_penalty > 0.3) {
    explanation.push(`close to an avoid anchor (-${components.negative_interest_penalty.toFixed(2)})`);
  }
  explanation.push(`type=${editorialType}, freshness=${freshness.toFixed(2)}`);

  const anchorDistance = input.anchorSimilarities.length
    ? Math.max(0, Math.min(1, 1 - semanticRawTopMean(input.anchorSimilarities, config)))
    : 0.5;

  return {
    ...components,
    band,
    editorialType,
    contentType,
    anchorDistance,
    explanation,
  };
}

/** Raw (un-rescaled) top-k mean, used for serendipity distance. */
export function semanticRawTopMean(similarities: number[], config: AppConfig): number {
  const k = config.free.free_ranking.semantic.top_k_anchors;
  if (similarities.length === 0) return 0;
  const top = [...similarities].sort((a, b) => b - a).slice(0, k);
  return top.reduce((s, v) => s + v, 0) / top.length;
}
