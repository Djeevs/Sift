import { describe, expect, it } from 'vitest';
import { pendingBatchItemIds, pendingBatches } from '../src/ai/batch.js';
import { testDb } from './helpers.js';

function submitted(db: ReturnType<typeof testDb>['db'], over: Partial<{ id: string; status: string; ids: string[]; prompt: string }> = {}) {
  db.run(
    `INSERT INTO batch_jobs (id, stage, status, item_ids_json, model, prompt_version, submitted_at)
     VALUES (:id, 'deep', :status, :ids, 'm', :prompt, :ts)`,
    {
      id: over.id ?? 'batch_1',
      status: over.status ?? 'in_progress',
      ids: JSON.stringify(over.ids ?? ['item-a', 'item-b']),
      prompt: over.prompt ?? 'deep-ranking-v3',
      ts: Date.now(),
    },
  );
}

/**
 * A run now submits a batch and returns rather than waiting for it, so the
 * items keep their `triaged` status — correctly, since nothing has evaluated
 * them. These guard the two things that then go wrong if nobody is careful.
 */
describe('batch lifecycle', () => {
  it('reports the prompt a pending batch was submitted under', () => {
    const { db } = testDb();
    submitted(db, { prompt: 'deep-ranking-v3' });
    // Results must be stored against this, not against whatever is configured
    // when they are collected: scores from different prompt versions are not
    // comparable, and mislabelling them hides a superseded prompt from the
    // re-scoring pass permanently.
    expect(pendingBatches(db, 'deep')[0]!.prompt_version).toBe('deep-ranking-v3');
  });

  it('lists items awaiting a batch so they are not submitted twice', () => {
    const { db } = testDb();
    submitted(db, { ids: ['item-a', 'item-b'] });
    const inFlight = pendingBatchItemIds(db, 'deep');
    expect([...inFlight].sort()).toEqual(['item-a', 'item-b']);
  });

  it('stops treating items as in flight once the batch resolves', () => {
    const { db } = testDb();
    submitted(db, { id: 'batch_done', status: 'completed', ids: ['item-a'] });
    submitted(db, { id: 'batch_failed', status: 'failed', ids: ['item-b'] });
    // Self-healing: nothing has to remember to clear these, so a failed batch
    // cannot strand its items forever.
    expect(pendingBatchItemIds(db, 'deep').size).toBe(0);
  });

  it('survives a malformed item list rather than failing the run', () => {
    const { db } = testDb();
    db.run(
      `INSERT INTO batch_jobs (id, stage, status, item_ids_json, model, prompt_version, submitted_at)
       VALUES ('bad', 'deep', 'in_progress', 'not json', 'm', 'p', :ts)`,
      { ts: Date.now() },
    );
    expect(pendingBatchItemIds(db, 'deep').size).toBe(0);
  });

  it('ignores batches belonging to another stage', () => {
    const { db } = testDb();
    db.run(
      `INSERT INTO batch_jobs (id, stage, status, item_ids_json, model, prompt_version, submitted_at)
       VALUES ('c1', 'cheap', 'in_progress', '["x"]', 'm', 'p', :ts)`,
      { ts: Date.now() },
    );
    expect(pendingBatchItemIds(db, 'deep').size).toBe(0);
  });
});
