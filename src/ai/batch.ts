import type OpenAI from 'openai';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import type { AiClient } from './client.js';
import { logger } from '../util/log.js';
import { sleep } from '../util/time.js';

const log = logger('batch');

/**
 * Optional use of the provider's batch API (§21).
 *
 * Latency does not matter here: an article appearing hours later is fine, and
 * batch pricing is typically half of sync. Submitted batches are tracked in the
 * database, so a crash mid-batch loses nothing -- the next run collects the
 * results.
 *
 * This is written against the OpenAI batch shape. On an endpoint that does not
 * implement it, `submitBatch` throws and the caller falls back to sync calls.
 */

export interface BatchRequest {
  customId: string;
  body: Record<string, unknown>;
}

export interface BatchOutcome {
  customId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export async function submitBatch(
  db: Db,
  ai: AiClient,
  stage: 'cheap' | 'deep',
  promptVersion: string,
  requests: BatchRequest[],
): Promise<string> {
  const sdk = ai.rawSdk(stage);
  const model = ai.modelFor(stage);

  const jsonl = requests
    .map((r) =>
      JSON.stringify({
        custom_id: r.customId,
        method: 'POST',
        url: '/v1/chat/completions',
        body: { model, ...r.body },
      }),
    )
    .join('\n');

  const file = await sdk.files.create({
    file: new File([jsonl], 'sift-batch.jsonl', { type: 'application/jsonl' }),
    purpose: 'batch',
  });

  const batch = await sdk.batches.create({
    input_file_id: file.id,
    endpoint: '/v1/chat/completions',
    completion_window: '24h',
  });

  db.run(
    `INSERT INTO batch_jobs (id, stage, status, item_ids_json, input_file_id, model, prompt_version, submitted_at)
     VALUES (:id, :stage, 'submitted', :ids, :file, :model, :prompt, :ts)
     ON CONFLICT(id) DO NOTHING`,
    {
      id: batch.id,
      stage,
      ids: JSON.stringify(requests.map((r) => r.customId)),
      file: file.id,
      model,
      prompt: promptVersion,
      ts: Date.now(),
    },
  );

  log.info(`submitted batch ${batch.id} with ${requests.length} requests`);
  return batch.id;
}

/** Poll one batch until it finishes (or the configured wait expires). */
export async function awaitBatch(
  db: Db,
  ai: AiClient,
  config: AppConfig,
  batchId: string,
): Promise<BatchOutcome[]> {
  const sdk = ai.rawSdk('deep');
  const intervalMs = config.models.models.deep.batch_poll_interval_seconds * 1000;
  const deadline = Date.now() + config.models.models.deep.batch_max_wait_hours * 3_600_000;

  while (Date.now() < deadline) {
    const batch = await sdk.batches.retrieve(batchId);
    db.run(`UPDATE batch_jobs SET status = :s WHERE id = :id`, { id: batchId, s: batch.status });

    if (batch.status === 'completed') {
      db.run(
        `UPDATE batch_jobs SET output_file_id = :out, completed_at = :ts, status = 'completed' WHERE id = :id`,
        { id: batchId, out: batch.output_file_id ?? null, ts: Date.now() },
      );

      const counts = batch.request_counts;
      if (counts) {
        log.info(
          `batch ${batchId} completed: ${counts.completed ?? 0} succeeded, ${counts.failed ?? 0} failed`,
        );
      }

      // "Completed" does not mean "succeeded". A batch whose requests all failed
      // validation completes with no output file and everything in an error file.
      // Reading only the output file made that look like an empty result set.
      const errors = batch.error_file_id ? await readErrorFile(sdk, batch.error_file_id) : [];
      if (errors.length > 0) {
        const sample = errors[0]!;
        log.error(
          `batch ${batchId}: ${errors.length} request(s) failed. First: ${sample.error ?? 'unknown'}`,
        );
        db.run(`UPDATE batch_jobs SET error = :err WHERE id = :id`, {
          id: batchId,
          err: `${errors.length} failed: ${sample.error ?? 'unknown'}`.slice(0, 1000),
        });
      }

      const outputs = batch.output_file_id
        ? parseBatchOutput(await (await sdk.files.content(batch.output_file_id)).text())
        : [];
      return [...outputs, ...errors];
    }

    if (batch.status === 'failed' || batch.status === 'expired' || batch.status === 'cancelled') {
      db.run(`UPDATE batch_jobs SET status = :s, error = :err, completed_at = :ts WHERE id = :id`, {
        id: batchId,
        s: batch.status,
        err: JSON.stringify(batch.errors ?? {}).slice(0, 1000),
        ts: Date.now(),
      });
      throw new Error(`batch ${batchId} ${batch.status}`);
    }

    log.info(`batch ${batchId} is ${batch.status}; waiting ${intervalMs / 1000}s`);
    await sleep(intervalMs);
  }

  throw new Error(`batch ${batchId} did not finish within the configured window`);
}

/**
 * A batch's error file, in the same shape as its outputs. Returned alongside them
 * so a caller sees failures instead of silence.
 */
async function readErrorFile(sdk: OpenAI, fileId: string): Promise<BatchOutcome[]> {
  try {
    const text = await (await sdk.files.content(fileId)).text();
    return parseBatchOutput(text).map((o) => ({
      ...o,
      error: o.error ?? 'request failed with no error body',
    }));
  } catch (err) {
    log.warn(`could not read batch error file ${fileId}`, err);
    return [];
  }
}

export function parseBatchOutput(jsonl: string): BatchOutcome[] {
  const outcomes: BatchOutcome[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        custom_id?: string;
        response?: {
          status_code?: number;
          body?: {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
        };
        error?: unknown;
      };
      const customId = parsed.custom_id ?? '';
      if (!customId) continue;

      // An error line carries its message inside response.body.error, which is
      // also where a non-200 status_code puts it.
      const bodyError = (parsed.response?.body as { error?: { message?: string } } | undefined)?.error;
      const status = parsed.response?.status_code;
      if (parsed.error || bodyError || (status !== undefined && status >= 400)) {
        outcomes.push({
          customId,
          text: '',
          inputTokens: 0,
          outputTokens: 0,
          error: (
            bodyError?.message ??
            (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error ?? {}))
          ).slice(0, 500),
        });
        continue;
      }
      if (!parsed.response?.body) {
        outcomes.push({ customId, text: '', inputTokens: 0, outputTokens: 0, error: 'no response body' });
        continue;
      }

      outcomes.push({
        customId,
        text: parsed.response.body.choices?.[0]?.message?.content ?? '',
        inputTokens: parsed.response.body.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.response.body.usage?.completion_tokens ?? 0,
      });
    } catch {
      // A single malformed line must not discard the rest of the batch.
      log.warn('skipped an unparseable batch output line');
    }
  }
  return outcomes;
}

/** Batches submitted by an earlier run that are still outstanding. */
export function pendingBatches(db: Db, stage?: string): Array<{ id: string; stage: string; item_ids_json: string }> {
  return stage
    ? db.all(`SELECT id, stage, item_ids_json FROM batch_jobs WHERE status IN ('submitted','in_progress','validating','finalizing') AND stage = :s`, { s: stage })
    : db.all(`SELECT id, stage, item_ids_json FROM batch_jobs WHERE status IN ('submitted','in_progress','validating','finalizing')`);
}

/** Decide sync vs batch for a queue of this size. */
export function shouldUseBatch(config: AppConfig, queueSize: number): boolean {
  const mode = config.models.models.deep.mode;
  if (mode === 'sync') return false;
  if (mode === 'batch') return queueSize > 0;
  return queueSize >= config.models.models.deep.batch_min_items;
}
