/**
 * Clustering health. Answers "is clustering doing anything, and is what it did
 * defensible?" -- the question that went unasked while it sat inert.
 */
import { loadConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { clusteringStats, sampleClusters } from '../cluster/diagnostics.js';
import { loadEnvFile } from './_bootstrap.js';

loadEnvFile();
const config = loadConfig();
const db = initDb(config.env.dbPath);
const rebuild = process.argv.includes('--rebuild');

if (rebuild) {
  const { rebuildClusters } = await import('../cluster/index.js');
  const { AiClient } = await import('../ai/client.js');
  const ai = new AiClient(config, db);
  const stats = rebuildClusters(db, config, ai.modelFor('embedding'));
  console.log(`rebuilt: ${stats.newClusters} clusters, ${stats.joined} joins from ${stats.examined} items\n`);
}

const s = clusteringStats(db, config);
console.log('=== clustering ===');
console.log(`  clusters                       ${s.clusters}`);
console.log(`  multi-item clusters            ${s.multiItemClusters} (${(s.multiItemRate * 100).toFixed(1)}% of clustered items)`);
console.log(`  average cluster size           ${s.averageSize.toFixed(2)}`);
console.log(`  median cluster size            ${s.medianSize}`);
console.log(`  largest cluster                ${s.largestSize}`);
console.log(`  items clustered with another source  ${s.crossSourceItems} (${(s.crossSourceRate * 100).toFixed(1)}%)`);
console.log(`  same-source duplicate pairs    ${s.sameSourcePairs}`);
console.log(`  cross-source duplicate pairs   ${s.crossSourcePairs}`);
console.log(`  members kept as distinct takes ${s.distinctMembers} of ${s.nonSeedMembers} non-seed members`);
console.log(`\n  source uniqueness calibrated:  ${s.uniquenessCalibrated ? 'YES' : 'NO'} ${s.uniquenessNote}`);

console.log('\n=== largest clusters ===');
for (const c of s.largest) {
  console.log(`  [${c.member_count}] ${(c.cluster_topic ?? '').slice(0, 70)}`);
}

console.log('\n=== sample clusters (why were these one story?) ===');
for (const c of sampleClusters(db, 6)) {
  console.log(`\n  cluster ${c.cluster_id} (${c.members.length} members)`);
  for (const m of c.members) {
    console.log(`    - [${m.source_id}] ${m.title.slice(0, 66)}`);
    console.log(`        joined: ${m.match_reason}`);
    if (m.perspective_distance !== null) {
      const verdict = m.perspective_distance >= config.pipeline.clustering.perspective.distinct_threshold
        ? 'distinct take -- stays eligible'
        : 'redundant -- suppressed';
      console.log(`        perspective distance ${m.perspective_distance.toFixed(3)} (${verdict})`);
    }
  }
}
