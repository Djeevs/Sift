import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDb } from '../src/db/index.js';
import { emptyProgress, readJobProgress } from '../src/ui/progress.js';

function dbWithRun(options: { status: string; stages: string[]; startedAt: number }): string {
  const path = resolve(mkdtempSync(resolve(tmpdir(), 'sift-progress-')), 'p.db');
  const db = initDb(path);
  db.run(
    `INSERT INTO processing_jobs (id, kind, status, started_at) VALUES ('j1', 'pipeline', :s, :t)`,
    { s: options.status, t: options.startedAt },
  );
  for (const stage of options.stages) {
    db.run(
      `INSERT INTO pipeline_costs (job_id, stage, items_in, items_out, created_at)
       VALUES ('j1', :stage, 100, 40, :t)`,
      { stage, t: options.startedAt },
    );
  }
  db.close();
  return path;
}

describe('job progress', () => {
  const startedAt = Date.now();

  it('marks completed stages and the one currently working', () => {
    const path = dbWithRun({ status: 'running', stages: ['aggregate', 'rules'], startedAt });
    const progress = readJobProgress(path, { staged: true, startedAt });
    expect(progress.stages.map((stage) => stage.state)).toEqual([
      'done', 'done', 'active', 'pending', 'pending', 'pending',
    ]);
    expect(progress.completed).toBe(2);
    expect(progress.percent).toBe(33);
    // A finished stage shows what it actually did, not its generic hint.
    expect(progress.stages[0]!.detail).toBe('100 → 40');
  });

  // Nothing should look like it is still working once the run has stopped.
  it('shows no active stage once the run has finished', () => {
    const path = dbWithRun({ status: 'ok', stages: ['aggregate'], startedAt });
    const progress = readJobProgress(path, { staged: true, startedAt });
    expect(progress.stages.some((stage) => stage.state === 'active')).toBe(false);
    expect(progress.pipelineStatus).toBe('ok');
  });

  // The UI job and the pipeline's own job row have different ids, so they are
  // correlated by time; an older run must not be mistaken for this one.
  it('ignores a pipeline run that started before this job', () => {
    const path = dbWithRun({ status: 'ok', stages: ['aggregate'], startedAt: startedAt - 3_600_000 });
    expect(readJobProgress(path, { staged: true, startedAt }).completed).toBe(0);
  });

  it('returns nothing for actions that do not run the funnel', () => {
    const path = dbWithRun({ status: 'running', stages: ['aggregate'], startedAt });
    expect(readJobProgress(path, { staged: false, startedAt }).stages).toEqual([]);
    expect(emptyProgress(false).total).toBe(0);
  });

  // A database being written by the pipeline must never break the page.
  it('degrades quietly when the database is missing', () => {
    const progress = readJobProgress('/nonexistent/p.db', { staged: true, startedAt });
    expect(progress.completed).toBe(0);
    expect(progress.stages).toHaveLength(6);
  });
});
