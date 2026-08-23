import { serve } from '@hono/node-server';
import { createApp } from '../server/app.js';
import { bootstrap } from './_bootstrap.js';
import { runPipeline } from '../pipeline/run.js';
import { pollFeedbackFeeds, resolveFeedbackFeeds } from '../feedback/reeder.js';
import { applyLearning } from '../learn/index.js';
import { startJob } from '../pipeline/journal.js';
import { logger } from '../util/log.js';

const log = logger('scheduler');

/**
 * One process: serves the feeds and runs the pipeline on a timer.
 *
 * A single process is the right shape here. There is one user, latency does not
 * matter, and the pipeline is I/O-bound with a hard spend cap — so a separate
 * scheduler, queue or worker fleet would add failure modes without buying
 * anything. If you prefer system cron, run `npm run serve` here and invoke
 * `npm run pipeline` from crontab instead.
 */

const { db, config } = bootstrap();
const app = createApp(db, config);

const pipelineIntervalMs = config.pipeline.ingest.poll_interval_minutes * 60_000;
const feedbackIntervalMs = config.pipeline.feedback.poll_interval_minutes * 60_000;
const learnIntervalMs = 24 * 3_600_000;

let pipelineRunning = false;

async function runPipelineOnce(): Promise<void> {
  // Overlapping runs would double-charge for models, so a run in progress
  // simply skips the tick.
  if (pipelineRunning) {
    log.warn('previous pipeline run is still going; skipping this tick');
    return;
  }
  pipelineRunning = true;
  try {
    const result = await runPipeline(db, config);
    log.info(`pipeline finished, spend $${result.spendUsd.toFixed(4)}`);
  } catch (err) {
    // A failed run must never take the feed server down with it.
    log.error('pipeline run failed', err);
  } finally {
    pipelineRunning = false;
  }
}

async function runFeedbackOnce(): Promise<void> {
  const feeds = resolveFeedbackFeeds();
  if (feeds.length === 0) return;
  const job = startJob(db, 'feedback');
  try {
    const stats = await pollFeedbackFeeds(db, config, feeds);
    job.finish({ ...stats });
  } catch (err) {
    job.fail(err);
    log.error('feedback poll failed', err);
  }
}

function runLearnOnce(): void {
  if (!config.pipeline.learning.enabled) return;
  const job = startJob(db, 'learn');
  try {
    const stats = applyLearning(db, config);
    job.finish({ signals: stats.signals, updated: stats.updated.length });
  } catch (err) {
    job.fail(err);
    log.error('learning round failed', err);
  }
}

const server = serve({ fetch: app.fetch, port: config.env.port }, (info) => {
  log.info(`serving on port ${info.port}`);
  log.info(`pipeline every ${config.pipeline.ingest.poll_interval_minutes} minutes`);
  for (const feed of config.feeds) {
    log.info(`  ${config.env.publicUrl}/feed/${feed.slug}.xml`);
  }
});

// Stagger the first pipeline run so the server is answering requests first.
setTimeout(() => void runPipelineOnce(), 15_000);
const pipelineTimer = setInterval(() => void runPipelineOnce(), pipelineIntervalMs);
const feedbackTimer = setInterval(() => void runFeedbackOnce(), feedbackIntervalMs);
const learnTimer = setInterval(() => runLearnOnce(), learnIntervalMs);

const shutdown = () => {
  log.info('shutting down');
  clearInterval(pipelineTimer);
  clearInterval(feedbackTimer);
  clearInterval(learnTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
