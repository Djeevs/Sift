import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from '../cli/_bootstrap.js';
import { logger } from '../util/log.js';

const log = logger('main');

const { db, config } = bootstrap();
const app = createApp(db, config);

const server = serve({ fetch: app.fetch, port: config.env.port }, (info) => {
  log.info(`listening on http://localhost:${info.port}`);
  const suffix =
    config.env.accessToken && config.env.accessToken !== 'change-me-please'
      ? `?t=${config.env.accessToken}`
      : '';
  for (const feed of config.feeds) {
    log.info(`  ${config.env.publicUrl}/feed/${feed.slug}.xml${suffix}`);
  }
  log.info(`  admin: ${config.env.publicUrl}/admin${suffix}`);
});

const shutdown = () => {
  log.info('shutting down');
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
