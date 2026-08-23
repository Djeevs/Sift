import { resolve } from 'node:path';
import { main, printTable } from './_bootstrap.js';
import { PROJECT_ROOT } from '../config/index.js';
import { exportStaticFeeds } from '../publish/static.js';

await main(async ({ db, config }, args) => {
  const outputDir = resolve(
    PROJECT_ROOT,
    typeof args.output === 'string' ? args.output : 'public',
  );
  const publicUrl = typeof args['public-url'] === 'string'
    ? args['public-url']
    : config.env.publicUrl;
  const result = exportStaticFeeds(db, config, outputDir, publicUrl);
  console.log(`wrote ${result.files} static files to ${result.outputDir}`);
  console.log('');
  printTable(result.feeds.map((feed) => ({
    feed: feed.id,
    items: feed.items,
    url: `${publicUrl.replace(/\/+$/, '')}/${feed.atom}`,
  })));
});
