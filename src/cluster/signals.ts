/**
 * Same-story detection from several cheap signals.
 *
 * Clustering used to hinge on one embedding threshold. Measured against the
 * labelled pair set that turned out to be a weak discriminator on its own: the
 * best achievable F1 from embedding alone was 0.68, because "same story" and
 * "related topic, different story" overlap heavily (medians 0.727 vs 0.662).
 * No single cut separates them.
 *
 * So the signals are combined instead. Each is cheap -- no model call is made
 * to decide clustering -- and every contribution is stored so a cluster
 * decision can be inspected afterwards.
 */
import type { AppConfig } from '../config/index.js';
import { cosine } from '../embed/index.js';
import { jaccard, namedEntities, titleSimilarity, tokenize } from '../util/text.js';

const HOUR_MS = 3_600_000;

export interface SignalInput {
  id: string;
  source_id: string;
  title: string;
  canonical_url: string | null;
  rss_summary: string | null;
  publication_time: number | null;
  first_seen_at: number;
  gist: string | null;
  vector: Float32Array | null;
}

/** Every signal that fed a decision, kept for inspection. */
export interface SameStorySignals {
  canonical_url_match: boolean;
  title_similarity: number;
  embedding_similarity: number;
  entity_overlap: number;
  gist_similarity: number;
  hours_apart: number;
  time_proximity: number;
  same_source: boolean;
  confidence: number;
  reason: string;
}

function timeOf(x: SignalInput): number {
  return x.publication_time ?? x.first_seen_at;
}

/**
 * Entities carry most of the "same event" signal: two outlets covering one
 * announcement share proper nouns even when their headlines share no wording.
 */
function entityOverlap(a: SignalInput, b: SignalInput): number {
  const ea = new Set(namedEntities(`${a.title}. ${a.gist ?? a.rss_summary ?? ''}`));
  const eb = new Set(namedEntities(`${b.title}. ${b.gist ?? b.rss_summary ?? ''}`));
  return jaccard(ea, eb);
}

export function sameStorySignals(
  a: SignalInput,
  b: SignalInput,
  config: AppConfig,
): SameStorySignals {
  const c = config.pipeline.clustering;
  const w = c.signal_weights;

  const hoursApart = Math.abs(timeOf(a) - timeOf(b)) / HOUR_MS;
  // Decays to zero at the edge of the window rather than cutting off hard, so a
  // story that breaks either side of the boundary is not arbitrarily split.
  const timeProximity = Math.max(0, 1 - hoursApart / c.time_window_hours);

  const canonicalMatch = Boolean(a.canonical_url && b.canonical_url && a.canonical_url === b.canonical_url);
  const titleSim = titleSimilarity(a.title, b.title);
  const embeddingSim = a.vector && b.vector ? cosine(a.vector, b.vector) : 0;
  const entitySim = entityOverlap(a, b);
  const gistSim = a.gist && b.gist ? jaccard(tokenize(a.gist), tokenize(b.gist)) : 0;
  const sameSource = a.source_id === b.source_id;

  const base: Omit<SameStorySignals, 'confidence' | 'reason'> = {
    canonical_url_match: canonicalMatch,
    title_similarity: titleSim,
    embedding_similarity: embeddingSim,
    entity_overlap: entitySim,
    gist_similarity: gistSim,
    hours_apart: Number(hoursApart.toFixed(2)),
    time_proximity: timeProximity,
    same_source: sameSource,
  };

  // The same URL is the same article. Nothing else needs consulting.
  if (canonicalMatch) {
    return { ...base, confidence: 1, reason: 'identical canonical url' };
  }

  // Outside the window two items are not the same story, however alike they read.
  if (hoursApart > c.time_window_hours) {
    return { ...base, confidence: 0, reason: `${Math.round(hoursApart)}h apart, outside window` };
  }

  // A near-identical headline is decisive on its own -- syndication and rewrites.
  if (titleSim >= c.title_similarity_threshold) {
    return { ...base, confidence: Math.max(0.9, titleSim), reason: `title similarity ${titleSim.toFixed(2)}` };
  }

  // Embedding similarity is rescaled before weighting. Unrelated pairs sit
  // around 0.46 median, so the raw cosine spends most of its range saying
  // nothing; what matters is the distance above that floor.
  const embeddingLift = Math.max(0, (embeddingSim - c.embedding_floor) / (1 - c.embedding_floor));

  // Entities, title tokens and gists were measured against the labelled set and
  // made same-story detection *worse* when mixed into the main score (F1 0.806
  // -> 0.742): the regex entity extractor is crude and only a third of items
  // carry a gist, so they mostly contribute noise on top of a stronger signal.
  // They are not deleted, because they are the only thing left when an item has
  // no embedding -- they serve as the fallback path rather than a component of
  // the primary one.
  if (!a.vector || !b.vector) {
    const fallback =
      w.fallback_entities * entitySim +
      w.fallback_title * titleSim +
      w.fallback_gist * gistSim +
      w.time_proximity * timeProximity;
    return {
      ...base,
      confidence: Math.max(0, Math.min(1, fallback)),
      reason: `no embedding; entities ${entitySim.toFixed(2)}, title ${titleSim.toFixed(2)}`,
    };
  }

  const confidence =
    w.embedding * embeddingLift +
    w.time_proximity * timeProximity +
    (sameSource ? w.same_source_penalty : 0);

  const parts = [`embedding ${embeddingSim.toFixed(3)}`, `${Math.round(hoursApart)}h apart`];
  if (sameSource) parts.push('same source');

  return {
    ...base,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: parts.join(', '),
  };
}

/**
 * Same story, or merely the same subject? Above this the two carry the same
 * information; below it they are different stories that happen to rhyme.
 */
export function isSameStory(signals: SameStorySignals, config: AppConfig): boolean {
  return signals.confidence >= config.pipeline.clustering.same_story_confidence;
}

/**
 * How much a second article adds beyond the one already in the cluster.
 *
 * Story identity and perspective identity are different questions. Routine
 * coverage of an announcement and a technical teardown of it are one story, but
 * only one of them is redundant. Clustering them together is right; dropping the
 * teardown because of it is not.
 *
 * Measured honestly, cheap signals separate the two poorly -- the best balanced
 * accuracy available from lexical and embedding features on the labelled set was
 * 0.69. That distinction is semantic, and nothing short of a model call really
 * settles it. So this is deliberately tuned asymmetrically rather than for
 * balanced accuracy: losing a genuinely different take is the expensive error,
 * while letting a duplicate through merely spends a slot. At the shipped
 * settings it retains 86% of different-perspective pairs and still suppresses
 * 44% of duplicates.
 */
export function perspectiveDistance(
  a: SignalInput,
  b: SignalInput,
  signals: SameStorySignals,
  config: AppConfig,
): number {
  const c = config.pipeline.clustering.perspective;
  if (signals.canonical_url_match) return 0;

  // Near-identical wording means near-identical content, whoever published it.
  let distance = (1 - signals.title_similarity) * c.title_divergence_weight;

  // Same subject, different words: the signature of a different treatment.
  const wordingGap = Math.max(0, signals.embedding_similarity - signals.title_similarity);
  distance += wordingGap * c.wording_gap_weight;

  // But very high semantic similarity means the same information regardless.
  distance -= signals.embedding_similarity * c.semantic_overlap_penalty;

  return Math.max(0, Math.min(1, distance));
}

/** Does this member add enough to deserve its own evaluation? */
export function isDistinctPerspective(distance: number, config: AppConfig): boolean {
  return distance >= config.pipeline.clustering.perspective.distinct_threshold;
}
