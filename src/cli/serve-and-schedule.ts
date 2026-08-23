import { startRuntime } from '../server/runtime.js';
import { PROJECT_ROOT } from '../config/index.js';
import { bootstrap, parseArgs } from './_bootstrap.js';
import { logger } from '../util/log.js';

const log = logger('sift');

/**
 * The long-running form: feeds, the control panel, and a scheduler.
 *
 * One process is the right shape here. There is one user, latency does not
 * matter, and the pipeline is I/O-bound under a hard spend cap — a separate
 * scheduler, queue or worker fleet would add failure modes and buy nothing.
 * Concurrent runs are prevented by the database lock rather than by keeping the
 * pieces apart.
 *
 * Pass --no-schedule to serve without running anything on a timer.
 */
const args = parseArgs();
const context = bootstrap({ syncSources: args['no-sync'] !== true });
const uiPort = Number(typeof args['ui-port'] === 'string' ? args['ui-port'] : process.env.SIFT_UI_PORT ?? 8790);

const runtime = startRuntime({
  projectRoot: PROJECT_ROOT,
  context,
  ui: args['no-ui'] !== true,
  uiPort,
  feeds: true,
  feedPort: typeof args['feed-port'] === 'string' ? Number(args['feed-port']) : undefined,
  schedule: args['no-schedule'] !== true,
});

log.info('Press Control-C to stop.');

const shutdown = () => {
  log.info('shutting down');
  void runtime.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
