import { spawn } from 'node:child_process';
import { startRuntime } from '../server/runtime.js';
import { PROJECT_ROOT } from '../config/index.js';
import { bootstrap, loadEnvFile, parseArgs } from './_bootstrap.js';
import { logger } from '../util/log.js';

const log = logger('sift');

/**
 * Sift Home: the control panel, and the feeds it hands you links to.
 *
 * Serving both from one process is the point. They used to be two commands in
 * two terminal windows, and a reader who ran only this one got feed URLs that
 * returned nothing.
 *
 * The scheduler stays off here unless asked for. Opening a control panel should
 * not start spending money on a timer; `npm run serve` is the command that says
 * "keep this running and keep it fresh".
 */
loadEnvFile();
const args = parseArgs();
const port = Number(typeof args.port === 'string' ? args.port : process.env.SIFT_UI_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('The control panel port must be a whole number from 1024 to 65535.');
}

// A first launch has no reader and therefore no database. That is the case this
// screen exists to fix, so it must not be an error.
let context: ReturnType<typeof bootstrap> | null = null;
try {
  context = bootstrap({ syncSources: false });
} catch (error) {
  log.warn(`starting the control panel only: ${error instanceof Error ? error.message : String(error)}`);
}

const runtime = startRuntime({
  projectRoot: PROJECT_ROOT,
  context,
  ui: true,
  uiPort: port,
  feeds: args['no-feeds'] !== true,
  feedPort: typeof args['feed-port'] === 'string' ? Number(args['feed-port']) : undefined,
  schedule: args.schedule === true,
});

log.info('Bound to this Mac only. Press Control-C to stop.');
if (args.open !== false && args['no-open'] !== true && process.platform === 'darwin' && runtime.uiUrl) {
  spawn('open', [runtime.uiUrl], { stdio: 'ignore' }).unref();
}

process.on('SIGINT', () => void runtime.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void runtime.stop().then(() => process.exit(0)));
