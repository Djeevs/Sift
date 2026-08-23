import { rmSync, existsSync } from 'node:fs';
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { loadConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { syncSources } from '../ingest/index.js';

/** Create (or reset) the database and mirror sources.yaml into it. */
loadEnvFile();
const args = parseArgs();
const config = loadConfig();

if (args.reset) {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${config.env.dbPath}${suffix}`;
    if (existsSync(path)) {
      rmSync(path);
      console.log(`removed ${path}`);
    }
  }
}

const db = initDb(config.env.dbPath);
syncSources(db, config);

const counts = db.get<{ sources: number; items: number }>(
  `SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM feed_items) AS items`,
);
console.log(`database ready at ${config.env.dbPath}`);
console.log(`  sources: ${counts?.sources ?? 0}`);
console.log(`  items:   ${counts?.items ?? 0}`);
console.log('');
console.log(`enabled feeds: ${config.feeds.map((f) => f.slug).join(', ')}`);
db.close();
