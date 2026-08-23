import { describe, it, expect } from 'vitest';
import { compareItems, clusterRecentItems, limitClusterMembers, type ClusterCandidate } from '../src/cluster/index.js';
import { loadConfig } from '../src/config/index.js';
import { deterministicVector } from '../src/embed/index.js';
import { testDb, seedItem, seedVector, seedCheapEvaluation, seedDeepEvaluation } from './helpers.js';
import { HOUR_MS } from '../src/util/time.js';

const config = loadConfig();
const MODEL = 'test-embed';

function candidate(overrides: Partial<ClusterCandidate> = {}): ClusterCandidate {
  const now = Date.now();
  return {
    id: 'a',
    source_id: 's1',
    title: 'OpenAI launches a new agent framework',
    canonical_url: 'https://a.com/1',
    rss_summary: null,
    publication_time: now,
    first_seen_at: now,
    gist: null,
    cluster_id: null,
    vector: null,
    ...overrides,
  };
}

describe('compareItems', () => {
  it('treats an identical canonical URL as the same story', () => {
    const a = candidate({ id: 'a', canonical_url: 'https://x.com/p' });
    const b = candidate({ id: 'b', canonical_url: 'https://x.com/p', title: 'Completely different words here' });
    const result = compareItems(a, b, config);
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('canonical_url');
  });

  it('links near-identical headlines from different outlets', () => {
    const a = candidate({ id: 'a', title: 'OpenAI launches new agent framework for developers' });
    const b = candidate({
      id: 'b',
      canonical_url: 'https://b.com/2',
      title: 'OpenAI launches agent framework for developers today',
    });
    expect(compareItems(a, b, config).matched).toBe(true);
  });

  it('refuses to link items outside the time window', () => {
    const a = candidate({ id: 'a', publication_time: Date.now() });
    const b = candidate({
      id: 'b',
      canonical_url: 'https://b.com/2',
      publication_time: Date.now() - 400 * HOUR_MS,
    });
    const result = compareItems(a, b, config);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/time window/);
  });

  it('does not link unrelated articles', () => {
    const a = candidate({ id: 'a', title: 'A new metroidvania about grief and cartography' });
    const b = candidate({
      id: 'b',
      canonical_url: 'https://b.com/2',
      title: 'Dutch rail operator changes its timetable structure',
    });
    expect(compareItems(a, b, config).matched).toBe(false);
  });

  it('links via embeddings when headlines differ but content matches', () => {
    const shared =
      'openai released a new framework for building autonomous agents with tool use and memory persistence';
    const a = candidate({
      id: 'a',
      title: 'A closer look at the release',
      vector: new Float32Array(deterministicVector(shared, 256)),
    });
    const b = candidate({
      id: 'b',
      canonical_url: 'https://b.com/2',
      title: 'What this means for builders',
      vector: new Float32Array(deterministicVector(shared, 256)),
    });
    const result = compareItems(a, b, config);
    expect(result.matched).toBe(true);
    expect(result.reason).toMatch(/embedding/);
  });
});

describe('clusterRecentItems', () => {
  it('groups coverage of one event and leaves unrelated items alone', () => {
    const { db, config: cfg } = testDb();
    const shared = 'openai announces persistent memory for its agent platform';

    const ids = [
      seedItem(db, { sourceId: '404media', title: 'OpenAI announces persistent memory for agents' }),
      seedItem(db, { sourceId: 'simon_willison', title: 'OpenAI announces persistent memory for agents, annotated' }),
      seedItem(db, { sourceId: 'aftermath', title: 'A small horror game about a lighthouse keeper' }),
    ];
    seedVector(db, ids[0]!, shared, MODEL);
    seedVector(db, ids[1]!, shared, MODEL);
    seedVector(db, ids[2]!, 'a small independent horror game set in a lighthouse', MODEL);

    const stats = clusterRecentItems(db, cfg, MODEL);
    expect(stats.examined).toBe(3);

    const clusterA = db.get<{ cluster_id: string }>(`SELECT cluster_id FROM feed_items WHERE id = :id`, { id: ids[0] });
    const clusterB = db.get<{ cluster_id: string }>(`SELECT cluster_id FROM feed_items WHERE id = :id`, { id: ids[1] });
    const clusterC = db.get<{ cluster_id: string }>(`SELECT cluster_id FROM feed_items WHERE id = :id`, { id: ids[2] });

    expect(clusterA?.cluster_id).toBeTruthy();
    expect(clusterB?.cluster_id).toBe(clusterA?.cluster_id);
    expect(clusterC?.cluster_id).not.toBe(clusterA?.cluster_id);
    db.close();
  });

  it('is idempotent: rerunning creates no new clusters', () => {
    const { db, config: cfg } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'A result about prime gaps' });
    seedVector(db, id, 'prime gaps number theory result', MODEL);

    const first = clusterRecentItems(db, cfg, MODEL);
    const second = clusterRecentItems(db, cfg, MODEL);
    expect(first.newClusters).toBe(1);
    expect(second.newClusters).toBe(0);
    expect(second.examined).toBe(0);

    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM story_clusters`);
    expect(count?.c).toBe(1);
    db.close();
  });

  it('keeps member_count in step with the members table', () => {
    const { db, config: cfg } = testDb();
    const shared = 'the same underlying announcement about a chip fabrication process';
    const a = seedItem(db, { sourceId: 'ieee_spectrum', title: 'New chip fabrication process announced' });
    const b = seedItem(db, { sourceId: '404media', title: 'New chip fabrication process announced, explained' });
    seedVector(db, a, shared, MODEL);
    seedVector(db, b, shared, MODEL);
    clusterRecentItems(db, cfg, MODEL);

    const row = db.get<{ id: string; member_count: number }>(
      `SELECT id, member_count FROM story_clusters ORDER BY member_count DESC LIMIT 1`,
    );
    const actual = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM story_cluster_members WHERE cluster_id = :c`, {
      c: row?.id,
    });
    expect(row?.member_count).toBe(actual?.c);
    db.close();
  });
});

describe('limitClusterMembers', () => {
  it('caps how many members of one story reach the deep model', () => {
    const { db, config: cfg } = testDb();
    const max = cfg.final.terra_gate.cluster.max_members_per_run;
    const clusterId = 'cluster-1';
    db.run(
      `INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at) VALUES (:id, 0, :ts, :ts)`,
      { id: clusterId, ts: Date.now() },
    );

    // High uniqueness so every member clears the differentiation rule and the
    // cap is what the test actually exercises.
    db.run(
      `INSERT INTO source_statistics (source_id, uniqueness, updated_at) VALUES ('quanta', 0.9, :ts)
       ON CONFLICT(source_id) DO UPDATE SET uniqueness = 0.9`,
      { ts: Date.now() },
    );
    const ids: string[] = [];
    for (let i = 0; i < max + 2; i += 1) {
      const id = seedItem(db, { sourceId: 'quanta', title: `Take number ${i} on one event`, clusterId });
      seedCheapEvaluation(db, id, { score: 0.9 - i * 0.01 });
      db.run(
        `INSERT INTO story_cluster_members (cluster_id, item_id, similarity, match_reason, joined_at)
         VALUES (:c, :i, 0.9, 'test', :ts)`,
        { c: clusterId, i: id, ts: Date.now() },
      );
      ids.push(id);
    }

    const { allowed, deferred } = limitClusterMembers(db, cfg, ids);
    expect(allowed).toHaveLength(max);
    expect(deferred).toHaveLength(2);
    // The highest triage scores are the ones that get through.
    expect(allowed).toContain(ids[0]);
    db.close();
  });

  it('counts deep evaluations from earlier runs, so the cap holds over time', () => {
    const { db, config: cfg } = testDb();
    const clusterId = 'cluster-2';
    db.run(
      `INSERT INTO story_clusters (id, member_count, first_seen_at, last_updated_at) VALUES (:id, 0, :ts, :ts)`,
      { id: clusterId, ts: Date.now() },
    );
    const max = cfg.final.terra_gate.cluster.max_members_per_run;

    // Fill the cluster's quota with items already evaluated in a previous run.
    for (let i = 0; i < max; i += 1) {
      const old = seedItem(db, { sourceId: 'quanta', title: `Earlier take ${i}`, clusterId });
      db.run(
        `INSERT INTO story_cluster_members (cluster_id, item_id, similarity, match_reason, joined_at)
         VALUES (:c, :i, 0.9, 'test', :ts)`,
        { c: clusterId, i: old, ts: Date.now() },
      );
      seedDeepEvaluation(db, old);
    }

    const fresh = seedItem(db, { sourceId: '404media', title: 'A late arriving take', clusterId });
    db.run(
      `INSERT INTO story_cluster_members (cluster_id, item_id, similarity, match_reason, joined_at)
       VALUES (:c, :i, 0.9, 'test', :ts)`,
      { c: clusterId, i: fresh, ts: Date.now() },
    );
    seedCheapEvaluation(db, fresh);

    const { allowed, deferred } = limitClusterMembers(db, cfg, [fresh]);
    expect(allowed).toEqual([]);
    expect(deferred[0]?.reason).toMatch(/already has/);
    db.close();
  });

  it('never defers items that have no cluster', () => {
    const { db, config: cfg } = testDb();
    const id = seedItem(db, { sourceId: 'quanta', title: 'A singleton article', clusterId: null });
    seedCheapEvaluation(db, id);
    const { allowed, deferred } = limitClusterMembers(db, cfg, [id]);
    expect(allowed).toEqual([id]);
    expect(deferred).toEqual([]);
    db.close();
  });
});
