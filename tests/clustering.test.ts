import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import {
  sameStorySignals,
  isSameStory,
  perspectiveDistance,
  isDistinctPerspective,
  type SignalInput,
} from '../src/cluster/signals.js';
import { structuralExcerpt } from '../src/util/text.js';

const config = loadConfig();

function item(over: Partial<SignalInput> = {}): SignalInput {
  return {
    id: 'a',
    source_id: 's1',
    title: 'OpenAI releases a new model',
    canonical_url: null,
    rss_summary: null,
    publication_time: 1_700_000_000_000,
    first_seen_at: 1_700_000_000_000,
    gist: null,
    vector: null,
    ...over,
  };
}

/** A unit vector at a chosen cosine distance from a reference, for exact tests. */
function vectorPair(cosineTarget: number): [Float32Array, Float32Array] {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([cosineTarget, Math.sqrt(Math.max(0, 1 - cosineTarget ** 2))]);
  return [a, b];
}

describe('same-story signals', () => {
  it('treats an identical canonical url as the same article outright', () => {
    const s = sameStorySignals(
      item({ canonical_url: 'https://x.example/a' }),
      item({ id: 'b', source_id: 's2', title: 'Totally different words', canonical_url: 'https://x.example/a' }),
      config,
    );
    expect(s.confidence).toBe(1);
    expect(s.canonical_url_match).toBe(true);
    expect(isSameStory(s, config)).toBe(true);
  });

  it('refuses to merge across the time window however similar the text', () => {
    const [va, vb] = vectorPair(0.99);
    const later = 1_700_000_000_000 + (config.pipeline.clustering.time_window_hours + 10) * 3_600_000;
    const s = sameStorySignals(
      item({ vector: va }),
      item({ id: 'b', publication_time: later, first_seen_at: later, vector: vb }),
      config,
    );
    expect(s.confidence).toBe(0);
    expect(s.reason).toMatch(/outside window/);
  });

  it('merges a near-identical headline even without embeddings', () => {
    const s = sameStorySignals(
      item({ title: 'Netflix closes two more game studios' }),
      item({ id: 'b', source_id: 's2', title: 'Netflix closes two more game studios today' }),
      config,
    );
    expect(isSameStory(s, config)).toBe(true);
  });

  /**
   * The old clusterer used a 0.845 cosine threshold, at which 5 of 92,644 real
   * pairs matched -- clustering was inert. Same-story pairs in the labelled set
   * have a median cosine near 0.73, so that region must now merge.
   */
  it('merges the similarity region where real same-story pairs actually live', () => {
    const [va, vb] = vectorPair(0.75);
    const s = sameStorySignals(
      item({ vector: va }),
      item({ id: 'b', source_id: 's2', title: 'Different headline entirely here', vector: vb }),
      config,
    );
    expect(s.confidence).toBeGreaterThanOrEqual(config.pipeline.clustering.same_story_confidence);
  });

  it('leaves genuinely unrelated items apart', () => {
    const [va, vb] = vectorPair(0.2);
    const s = sameStorySignals(
      item({ vector: va }),
      item({ id: 'b', source_id: 's2', title: 'A quiet essay about beekeeping', vector: vb }),
      config,
    );
    expect(isSameStory(s, config)).toBe(false);
  });

  it('is more reluctant to merge two items from one source', () => {
    const [va, vb] = vectorPair(0.7);
    const different = sameStorySignals(
      item({ vector: va }),
      item({ id: 'b', source_id: 's2', title: 'Some other wording', vector: vb }),
      config,
    );
    const same = sameStorySignals(
      item({ vector: va }),
      item({ id: 'b', source_id: 's1', title: 'Some other wording', vector: vb }),
      config,
    );
    expect(same.confidence).toBeLessThan(different.confidence);
  });

  it('falls back to entities and title when an item has no embedding', () => {
    const s = sameStorySignals(
      item({ title: 'Schiphol strike talks collapse', gist: 'Schiphol security strike' }),
      item({
        id: 'b',
        source_id: 's2',
        title: 'Schiphol security strike begins',
        gist: 'Schiphol security strike',
      }),
      config,
    );
    expect(s.reason).toMatch(/no embedding/);
    expect(s.confidence).toBeGreaterThan(0);
  });
});

describe('perspective distance', () => {
  it('gives an identical article no distance at all', () => {
    const a = item({ canonical_url: 'https://x.example/a' });
    const b = item({ id: 'b', canonical_url: 'https://x.example/a' });
    const s = sameStorySignals(a, b, config);
    expect(perspectiveDistance(a, b, s, config)).toBe(0);
  });

  /**
   * The distinction this protects: routine coverage of an announcement and a
   * technical teardown of it are one story, but suppressing the teardown loses
   * the thing worth reading. Same subject, different words must read as distinct.
   */
  it('rates same-subject-different-wording as a distinct take', () => {
    const [va, vb] = vectorPair(0.78);
    const a = item({ title: 'OpenAI ships GPT-5.6 Terra', vector: va });
    const b = item({
      id: 'b',
      source_id: 's2',
      title: 'What the new reasoning model actually changes for engineers',
      vector: vb,
    });
    const s = sameStorySignals(a, b, config);
    expect(isDistinctPerspective(perspectiveDistance(a, b, s, config), config)).toBe(true);
  });

  it('rates near-identical wording as redundant', () => {
    const [va, vb] = vectorPair(0.97);
    const a = item({ title: 'Netflix closes two more game studios', vector: va });
    const b = item({
      id: 'b',
      source_id: 's2',
      title: 'Netflix closes two more game studios',
      vector: vb,
    });
    const s = sameStorySignals(a, b, config);
    expect(perspectiveDistance(a, b, s, config)).toBeLessThan(
      config.pipeline.clustering.perspective.distinct_threshold,
    );
  });
});

/**
 * Measured performance against the labelled fixture. This is the guard that
 * stops clustering silently regressing to inert again: it asserts the outcome
 * that was actually tuned for, not the parameters that produced it.
 */
describe('clustering quality against the labelled pair set', () => {
  const path = resolve(process.cwd(), 'tests/fixtures/cluster-pairs.json');

  it('has a labelled fixture to tune against', () => {
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, 'utf8')) as { pairs: unknown[] };
    expect(data.pairs.length).toBeGreaterThanOrEqual(100);
  });

  it('detects same-story pairs with usable precision and recall', () => {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      pairs: Array<{
        label: string;
        embedding_similarity: number;
        a: { source: string; title: string };
        b: { source: string; title: string };
      }>;
    };

    // Driven through the real scorer. Vectors are synthesised to reproduce the
    // stored cosine exactly, and both items are given the same timestamp -- the
    // common case for same-story pairs -- so this exercises the shipped code
    // path rather than a reimplementation of it.
    let tp = 0, fp = 0, fn = 0, unrelatedMerged = 0;
    for (const p of data.pairs) {
      const [va, vb] = vectorPair(p.embedding_similarity);
      const a = item({ source_id: p.a.source, title: p.a.title, vector: va });
      const b = item({ id: 'b', source_id: p.b.source, title: p.b.title, vector: vb });
      const predicted = isSameStory(sameStorySignals(a, b, config), config);
      const actual = p.label.startsWith('SAME_STORY');
      if (predicted && actual) tp++;
      else if (predicted && !actual) {
        fp++;
        if (p.label === 'UNRELATED') unrelatedMerged++;
      } else if (!predicted && actual) fn++;
    }

    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);

    // The old configuration scored recall 0.03 here. Anything near that means
    // clustering has gone inert again, which is the regression this guards.
    expect(recall).toBeGreaterThan(0.65);
    expect(precision).toBeGreaterThan(0.65);
    // Merging related-topic pairs is a mild error; merging unrelated ones is not.
    expect(unrelatedMerged).toBeLessThanOrEqual(3);
  });
});

describe('structural excerpting for long articles', () => {
  it('leaves a short article untouched', () => {
    const r = structuralExcerpt('short body', 1000);
    expect(r.excerpted).toBe(false);
    expect(r.text).toBe('short body');
  });

  /**
   * Head-only truncation showed the model a long essay's setup and never its
   * payoff, so it could not judge whether the length was earned.
   */
  it('keeps both the opening and the closing of a long article', () => {
    const body = `OPENING PARAGRAPH.\n\n${'filler sentence. '.repeat(2000)}\n\nCLOSING ARGUMENT.`;
    const r = structuralExcerpt(body, 4000);
    expect(r.excerpted).toBe(true);
    expect(r.text).toContain('OPENING PARAGRAPH');
    expect(r.text).toContain('CLOSING ARGUMENT');
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.omittedChars).toBeGreaterThan(0);
  });

  it('marks the elision so the model knows it is reading an excerpt', () => {
    const r = structuralExcerpt('x'.repeat(50_000), 5_000);
    expect(r.text).toContain('omitted');
  });
});
