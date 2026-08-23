/**
 * One process: the control panel, the feed server, and the scheduler.
 *
 * These used to be separate commands on separate ports, each needing its own
 * terminal window left open. The consequence was the quietest failure in the
 * product: a reader copied a feed URL out of the dashboard, pasted it into
 * their reading app, and got nothing -- because the feed server was a second
 * command nobody had told them to run. The dashboard grew a "is it running?"
 * probe to detect exactly this. Serving both from one process removes the
 * condition instead of reporting it.
 *
 * Two ports, deliberately, not one. Feed URLs already published to readers and
 * to Cloudflare point at the feed port; moving them would break every existing
 * subscription to save a number in a config file.
 *
 * The control panel manages every reader, while the feed server and scheduler
 * act on whichever profile the environment selects. That asymmetry is real and
 * is surfaced rather than hidden: the dashboard reports the feed server as
 * running only for the profile actually being served.
 */
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { createUiApp } from '../ui/app.js';
import { UiJobRunner } from '../ui/jobs.js';
import { runPipeline } from '../pipeline/run.js';
import { pollFeedbackFeeds, resolveFeedbackFeeds } from '../feedback/reeder.js';
import { applyLearning } from '../learn/index.js';
import { startJob } from '../pipeline/journal.js';
import { LockedError } from '../util/lock.js';
import { resolveHome } from '../config/index.js';
import { logger } from '../util/log.js';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';

const log = logger('runtime');

export interface RuntimeOptions {
  projectRoot: string;
  /** Absent when no reader has been set up yet; the panel still runs. */
  context: { db: Db; config: AppConfig } | null;
  ui: boolean;
  uiPort: number;
  feeds: boolean;
  /** Overrides the configured feed port; used when running a second instance. */
  feedPort?: number;
  schedule: boolean;
}

export interface Runtime {
  uiUrl: string | null;
  feedUrl: string | null;
  stop: () => Promise<void>;
}

/**
 * Start one server without letting its failure take the others down.
 *
 * The first version let an EADDRINUSE on the feed port kill the whole process,
 * control panel included -- so the one screen that could have explained the
 * problem was the thing the problem removed. A port clash is the most likely
 * startup failure here, because the usual cause is Sift already running.
 */
function listen(
  what: string,
  port: number,
  // The two apps are separate Hono instances, so their fetch signatures differ
  // in their bindings; only the request/response shape matters here.
  fetch: Parameters<typeof serve>[0]['fetch'],
  onFail: (message: string) => void,
  hostname?: string,
): Server | null {
  try {
    const server = serve({ fetch, port, ...(hostname ? { hostname } : {}) }) as Server;
    server.on('error', (error: NodeJS.ErrnoException) => {
      onFail(error.code === 'EADDRINUSE'
        ? `${what} could not start: port ${port} is already in use. Sift may already be running.`
        : `${what} could not start: ${error.message}`);
    });
    return server;
  } catch (error) {
    onFail(`${what} could not start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function startRuntime(options: RuntimeOptions): Runtime {
  const servers: Server[] = [];
  const timers: NodeJS.Timeout[] = [];
  const jobs = new UiJobRunner(options.projectRoot, resolveHome());
  let uiUrl: string | null = null;
  let feedUrl: string | null = null;

  if (options.ui) {
    const app = createUiApp({ projectRoot: options.projectRoot, home: resolveHome(), jobRunner: jobs });
    const server = listen('The control panel', options.uiPort, app.fetch, (message) => {
      // Nothing to fall back to: without the panel this process has no purpose.
      log.error(message);
      log.error(`Try a different port:  npm run ui -- --port ${options.uiPort + 1}`);
      process.exitCode = 1;
    }, '127.0.0.1');
    if (server) {
      servers.push(server);
      uiUrl = `http://127.0.0.1:${options.uiPort}`;
      log.info(`control panel: ${uiUrl}`);
    }
  }

  const context = options.context;
  if (options.feeds && context) {
    const app = createApp(context.db, context.config);
    const port = options.feedPort ?? context.config.env.port;
    const server = listen('The feed server', port, app.fetch, (message) => {
      // The panel stays up: it is where a reader would go to understand this.
      log.error(message);
      log.warn('The control panel is still running. Feed links will not work until this is resolved.');
    });
    if (server) {
      servers.push(server);
      feedUrl = context.config.env.publicUrl;
      log.info(`feeds: ${feedUrl}/feed/<slug>.xml`);
      for (const feed of context.config.feeds) log.debug(`  ${feedUrl}/feed/${feed.slug}.xml`);
    }
  } else if (options.feeds) {
    // Onboarding runs before any reader exists, so this is normal rather than
    // an error. Saying so beats a stack trace on a first launch.
    log.warn('no reader configured yet, so no feeds are being served. Set one up in the control panel.');
  }

  if (options.schedule && context) {
    const { db, config } = context;
    let running = false;

    const runPipelineOnce = async (): Promise<void> => {
      // The in-process guard avoids spawning work the file lock would only
      // reject; the file lock is what actually protects against other processes.
      if (running) {
        log.warn('previous run is still going; skipping this tick');
        return;
      }
      running = true;
      try {
        const result = await runPipeline(db, config);
        log.info(`pipeline finished, spend $${result.spendUsd.toFixed(4)}`);
      } catch (err) {
        if (err instanceof LockedError) log.warn(`skipped: ${err.message}`);
        else log.error('pipeline run failed', err);
      } finally {
        running = false;
      }
    };

    const runFeedbackOnce = async (): Promise<void> => {
      const feeds = resolveFeedbackFeeds();
      if (feeds.length === 0) return;
      const job = startJob(db, 'feedback');
      try {
        job.finish({ ...(await pollFeedbackFeeds(db, config, feeds)) });
      } catch (err) {
        job.fail(err);
        log.error('feedback poll failed', err);
      }
    };

    const runLearnOnce = (): void => {
      if (!config.pipeline.learning.enabled) return;
      const job = startJob(db, 'learn');
      try {
        const stats = applyLearning(db, config);
        job.finish({ signals: stats.signals, updated: stats.updated.length });
      } catch (err) {
        job.fail(err);
        log.error('learning round failed', err);
      }
    };

    const pipelineMs = config.pipeline.ingest.poll_interval_minutes * 60_000;
    log.info(`scheduler on: a run every ${config.pipeline.ingest.poll_interval_minutes} minutes`);
    // Staggered so the servers answer requests before the first run starts.
    timers.push(setTimeout(() => void runPipelineOnce(), 15_000));
    timers.push(setInterval(() => void runPipelineOnce(), pipelineMs));
    timers.push(setInterval(() => void runFeedbackOnce(), config.pipeline.feedback.poll_interval_minutes * 60_000));
    timers.push(setInterval(() => runLearnOnce(), 24 * 3_600_000));
  } else if (options.schedule) {
    log.warn('scheduler requested but no reader is configured yet');
  }

  return {
    uiUrl,
    feedUrl,
    stop: async () => {
      for (const timer of timers) clearTimeout(timer as NodeJS.Timeout);
      jobs.stopAll();
      await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
      context?.db.close();
    },
  };
}
