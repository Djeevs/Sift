import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { testDb, seedItem } from './helpers.js';
import {
  freeStageReport,
  lunaStageReport,
  breakdowns,
  measurementReadiness,
} from '../src/pipeline/falseNegatives.js';
import { clusteringStats } from '../src/cluster/diagnostics.js';
import type { Db } from '../src/db/index.js';

const config = loadConfig();

function auditSample(
  db: Db,
  id: string,
  boundary: string,
  over: Record<string, unknown> = {},
): void {
  seedItem(db, { id, sourceId: 'quanta', title: `Sample ${id}`, status: 'rejected_free' });
  db.run(
    `INSERT INTO audit_samples
       (item_id, boundary, normal_decision, audit_selected, audit_stage, audit_reason,
        band, free_score, sample_rate, source_id, category, semantic_interest,
        is_serendipity, content_type, source_prior, audit_result, would_have_published, created_at)
     VALUES (:id, :b, 'reject', 1, :stage, 'sampled', :band, :score, 0.2, :source, :cat,
             :sem, :ser, :ct, :prior, :result, :pub, 0)`,
    {
      id,
      b: boundary,
      stage: over.stage ?? 'free_reject',
      band: over.band ?? 'C',
      score: over.score ?? 0.4,
      source: over.source ?? 'quanta',
      cat: over.cat ?? 'ideas_science',
      sem: over.sem ?? 0.5,
      ser: over.ser ?? 0,
      ct: over.ct ?? 'analysis',
      prior: over.prior ?? 0.9,
      result: over.result ?? null,
      pub: over.pub ?? null,
    },
  );
}

function deepEval(db: Db, id: string, eav: number): void {
  db.run(
    `INSERT INTO deep_evaluations (item_id, expected_attention_value, category, model, prompt_version, config_hash, created_at)
     VALUES (:id, :e, 'ideas_science', 'm', 'p', 'h', 0)`,
    { id, e: eav },
  );
}

describe('free-stage false negatives', () => {
  it('reports nothing rather than a fabricated rate with no data', () => {
    const { db } = testDb();
    const r = freeStageReport(db);
    expect(r.sampled).toBe(0);
    expect(r.falseNegativeRate).toBeNull();
  });

  /**
   * An UNCERTAIN counts as half a miss. Luna itself could not decide, so treating
   * it as a full false negative would overstate how wrong the free ranker was.
   */
  it('counts a KEEP as a full miss and an UNCERTAIN as half', () => {
    const { db } = testDb();
    auditSample(db, 'k1', 'free_to_luna', { result: 'luna_would_keep' });
    auditSample(db, 'u1', 'free_to_luna', { result: 'luna_uncertain' });
    auditSample(db, 'd1', 'free_to_luna', { result: 'luna_drop' });
    auditSample(db, 'd2', 'free_to_luna', { result: 'luna_drop' });

    const r = freeStageReport(db);
    expect(r.resolved).toBe(4);
    expect(r.lunaKeep).toBe(1);
    expect(r.lunaUncertain).toBe(1);
    // (1 + 0.5) / 4
    expect(r.falseNegativeRate).toBeCloseTo(0.375, 6);
  });

  it('reports the stricter would-have-published rate separately', () => {
    const { db } = testDb();
    auditSample(db, 'p1', 'free_to_luna', { result: 'luna_would_keep', pub: 1 });
    deepEval(db, 'p1', 0.85);
    auditSample(db, 'p2', 'free_to_luna', { result: 'luna_would_keep', pub: 0 });
    deepEval(db, 'p2', 0.4);

    const r = freeStageReport(db);
    expect(r.reachedTerra).toBe(2);
    expect(r.terraHigh).toBe(1);
    expect(r.wouldHavePublished).toBe(1);
    expect(r.publishableMissRate).toBeCloseTo(0.5, 6);
  });
});

describe('Luna-stage false negatives', () => {
  it('summarises the Terra score distribution of Luna rejects', () => {
    const { db } = testDb();
    for (const [id, eav] of [['l1', 0.2], ['l2', 0.5], ['l3', 0.85]] as const) {
      auditSample(db, id, 'luna_to_terra', { stage: 'luna_reject' });
      deepEval(db, id, eav);
    }
    const r = lunaStageReport(db);
    expect(r.resolved).toBe(3);
    expect(r.medianTerraScore).toBeCloseTo(0.5, 6);
    expect(r.terraHigh).toBe(1);
    expect(r.falseNegativeRate).toBeCloseTo(1 / 3, 6);
  });
});

describe('what kinds of things get dropped', () => {
  it('groups misses by every dimension a tuning decision would need', () => {
    const { db } = testDb();
    auditSample(db, 'b1', 'free_to_luna', { result: 'luna_would_keep', source: 'quanta', ct: 'analysis' });
    auditSample(db, 'b2', 'free_to_luna', { result: 'luna_drop', source: 'quanta', ct: 'analysis' });
    auditSample(db, 'b3', 'free_to_luna', { result: 'luna_would_keep', source: 'aeon', ct: 'essay' });

    const dims = breakdowns(db, config).map((b) => b.dimension);
    for (const expected of [
      'source', 'category', 'free-score band', 'content type',
      'article length', 'source prior', 'semantic interest', 'serendipity',
    ]) {
      expect(dims).toContain(expected);
    }

    const bySource = breakdowns(db, config).find((b) => b.dimension === 'source')!;
    const quanta = bySource.rows.find((r) => r.key === 'quanta')!;
    expect(quanta.sampled).toBe(2);
    expect(quanta.misses).toBe(1);
    expect(quanta.rate).toBeCloseTo(0.5, 6);
  });
});

describe('measurement readiness', () => {
  it('refuses to call a handful of samples a rate', () => {
    const { db } = testDb();
    for (let i = 0; i < 5; i += 1) auditSample(db, `r${i}`, 'free_to_luna', { result: 'luna_drop' });
    const r = measurementReadiness(db, config);
    expect(r.ready).toBe(false);
    expect(r.note).toMatch(/needs/);
  });

  it('reports ready once both boundaries have enough resolved observations', () => {
    const { db } = testDb();
    for (let i = 0; i < 32; i += 1) auditSample(db, `f${i}`, 'free_to_luna', { result: 'luna_drop' });
    for (let i = 0; i < 32; i += 1) {
      auditSample(db, `t${i}`, 'luna_to_terra', { stage: 'luna_reject', result: 'terra_ordinary' });
      deepEval(db, `t${i}`, 0.3);
    }
    expect(measurementReadiness(db, config).ready).toBe(true);
  });
});

describe('clustering diagnostics', () => {
  it('reports uniqueness as uncalibrated when nothing has clustered', () => {
    const { db } = testDb();
    const s = clusteringStats(db, config);
    expect(s.clusters).toBe(0);
    expect(s.uniquenessCalibrated).toBe(false);
    expect(s.uniquenessNote).toMatch(/needs/);
  });

  /**
   * The metric that would have caught the inert clusterer. Average size 1.02 with
   * 495 clusters was visible in the data all along; nothing reported it.
   */
  it('separates multi-item clusters from singletons', () => {
    const { db } = testDb();
    db.run(`INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at) VALUES ('c1', 0, 0, 0)`);
    db.run(`INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at) VALUES ('c2', 0, 0, 0)`);
    seedItem(db, { id: 'm1', sourceId: 'quanta', title: 'A' });
    seedItem(db, { id: 'm2', sourceId: 'aeon', title: 'B' });
    seedItem(db, { id: 'm3', sourceId: 'aeon', title: 'C' });
    db.run(`INSERT INTO story_cluster_members (cluster_id, item_id, match_reason, perspective_distance, joined_at) VALUES ('c1','m1','cluster seed',1,0)`);
    db.run(`INSERT INTO story_cluster_members (cluster_id, item_id, match_reason, perspective_distance, joined_at) VALUES ('c1','m2','embedding 0.8',0.6,0)`);
    db.run(`INSERT INTO story_cluster_members (cluster_id, item_id, match_reason, perspective_distance, joined_at) VALUES ('c2','m3','cluster seed',1,0)`);

    const s = clusteringStats(db, config);
    expect(s.clusters).toBe(2);
    expect(s.multiItemClusters).toBe(1);
    expect(s.averageSize).toBeCloseTo(1.5, 6);
    expect(s.largestSize).toBe(2);
    // m1 and m2 come from different sources, so that pair is cross-source.
    expect(s.crossSourcePairs).toBe(1);
    expect(s.sameSourcePairs).toBe(0);
  });
});
