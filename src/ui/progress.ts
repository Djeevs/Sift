/**
 * What a running job is actually doing, for the dashboard.
 *
 * The job page used to be a raw log behind a full-page meta refresh: correct,
 * and useless to anyone who does not already know what the funnel is. A reader
 * watching it could not tell whether Sift was stuck, nearly finished, or had
 * ten minutes left.
 *
 * Nothing new is instrumented to produce this. The pipeline already writes a
 * `processing_jobs` row when it starts and a `pipeline_costs` row as each stage
 * completes, so progress is read from the reader's own database rather than
 * scraped out of log lines, which would break the first time a message changed.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export type StageState = 'done' | 'active' | 'pending';

export interface StageProgress {
  id: string;
  /** Plain language: the reader has never heard of Luna or Terra. */
  label: string;
  hint: string;
  state: StageState;
  /** "3,077 → 528", once the stage has finished. */
  detail: string | null;
}

export interface JobProgress {
  /** True when this action runs the funnel and so has stages worth showing. */
  staged: boolean;
  stages: StageProgress[];
  completed: number;
  total: number;
  /** Whole percent, for the bar. */
  percent: number;
  /** Set once the pipeline's own job row reports a terminal state. */
  pipelineStatus: 'running' | 'ok' | 'failed' | null;
}

/**
 * The six stages the pipeline records costs for, in funnel order.
 *
 * Stage 7 (writing the feed files) is part of the final stage's work and has no
 * separate cost row, so it is folded into the last label rather than shown as a
 * step that never completes.
 */
const STAGES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'aggregate', label: 'Collecting', hint: 'Fetching every source you follow' },
  { id: 'rules', label: 'Filtering', hint: 'Dropping what is obviously not worth reading' },
  { id: 'free', label: 'Scoring', hint: 'Ranking what is left, at no cost' },
  { id: 'luna', label: 'Quick review', hint: 'A cheap AI pass over the best candidates' },
  { id: 'terra', label: 'Close reading', hint: 'A careful AI read of the strongest few' },
  { id: 'final', label: 'Choosing', hint: 'Building your edition and writing the feeds' },
];

function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}

export function emptyProgress(staged: boolean): JobProgress {
  return {
    staged,
    stages: staged ? STAGES.map((stage) => ({ ...stage, state: 'pending' as StageState, detail: null })) : [],
    completed: 0,
    total: staged ? STAGES.length : 0,
    percent: 0,
    pipelineStatus: null,
  };
}

/**
 * Read progress for the pipeline run this UI job started.
 *
 * Correlated by time rather than by id: the UI spawns `npm run pipeline`, which
 * mints its own job id inside the child process, so the two are never equal.
 * A one-minute grace before the UI job's start absorbs clock jitter without
 * matching a previous run.
 */
export function readJobProgress(
  databasePath: string,
  options: { staged: boolean; startedAt: number },
): JobProgress {
  const progress = emptyProgress(options.staged);
  if (!options.staged || databasePath === ':memory:' || !existsSync(databasePath)) return progress;

  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const job = db.prepare(
        `SELECT id, status FROM processing_jobs
         WHERE kind = 'pipeline' AND started_at >= :since
         ORDER BY started_at DESC LIMIT 1`,
      ).get({ since: options.startedAt - 60_000 }) as { id: string; status: string } | undefined;
      if (!job) return progress;

      progress.pipelineStatus = job.status === 'ok' || job.status === 'failed' ? job.status : 'running';
      const rows = db.prepare(
        `SELECT stage, items_in, items_out FROM pipeline_costs WHERE job_id = :id`,
      ).all({ id: job.id }) as Array<{ stage: string; items_in: number; items_out: number }>;
      const done = new Map(rows.map((row) => [row.stage, row]));

      let seenPending = false;
      for (const stage of progress.stages) {
        const row = done.get(stage.id);
        if (row) {
          stage.state = 'done';
          stage.detail = `${formatCount(row.items_in)} → ${formatCount(row.items_out)}`;
          progress.completed += 1;
          continue;
        }
        // The first stage without a cost row is the one currently working --
        // but only while the run is still going.
        if (!seenPending && progress.pipelineStatus === 'running') {
          stage.state = 'active';
          seenPending = true;
        }
      }
      progress.percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
      return progress;
    } finally {
      db.close();
    }
  } catch {
    // A database mid-write must never break the page that is watching it.
    return progress;
  }
}
