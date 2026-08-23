import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { createUiApp } from '../ui/app.js';
import { UiJobRunner } from '../ui/jobs.js';
import { PROJECT_ROOT } from '../config/index.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';

loadEnvFile();
const args = parseArgs();
const port = Number(typeof args.port === 'string' ? args.port : process.env.SIFT_UI_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('UI port must be a whole number from 1024 to 65535.');
const host = '127.0.0.1';
const url = `http://${host}:${port}`;
const jobs = new UiJobRunner(PROJECT_ROOT);
const app = createUiApp({ projectRoot: PROJECT_ROOT, jobRunner: jobs });

const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`Sift Home is running at ${url}`);
  console.log('It is bound to this Mac only. Press Control-C to stop.');
  if (args.open !== false && args['no-open'] !== true && process.platform === 'darwin') {
    const opener = spawn('open', [url], { stdio: 'ignore' });
    opener.unref();
  }
});
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`Sift Home could not start: ${url} is already in use. Try --port ${port + 1}.`);
  else console.error(`Sift Home could not start: ${error.message}`);
  process.exitCode = 1;
});

const shutdown = () => {
  jobs.stopAll();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
