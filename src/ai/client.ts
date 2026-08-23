import OpenAI from 'openai';
import type { Db } from '../db/index.js';
import type { AppConfig, ChatModelConfig } from '../config/index.js';
import { logger } from '../util/log.js';
import { sleep } from '../util/time.js';
import { hardenModelMessages } from './prompts.js';

const log = logger('ai');

/**
 * The only place that talks to a model provider.
 *
 * Everything is addressed by *role* (triage / deep / embedding), never by model
 * id: those live in ranking-config.yaml under `models:`. Any OpenAI-compatible
 * endpoint works via OPENAI_BASE_URL.
 */

export type Role = 'cheap' | 'deep' | 'embedding';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Of inputTokens, how many the provider served from its prompt cache. */
  cachedInputTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
}

export class SpendLimitError extends Error {
  constructor(spent: number, limit: number) {
    super(`spend limit reached for this run: $${spent.toFixed(4)} of $${limit.toFixed(2)}`);
    this.name = 'SpendLimitError';
  }
}

/**
 * Parameters a given model turned out not to accept. Providers differ on
 * `temperature`, `reasoning_effort` and `response_format`, and a hard failure
 * on the first item of a run would waste the whole run — so an unsupported
 * parameter is remembered and dropped for the rest of the process.
 */
const unsupported = new Map<string, Set<string>>();

function markUnsupported(model: string, param: string): void {
  const set = unsupported.get(model) ?? new Set<string>();
  set.add(param);
  unsupported.set(model, set);
  log.warn(`${model} rejected "${param}"; dropping it for the rest of this run`);
}

function isUnsupported(model: string, param: string): boolean {
  return unsupported.get(model)?.has(param) ?? false;
}

/** Which parameter (if any) an API error is complaining about. */
export function offendingParameter(err: unknown): string | null {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return null;
  const message = String(
    (err as { message?: string })?.message ?? (err as { error?: { message?: string } })?.error?.message ?? '',
  );
  const param = (err as { param?: string })?.param ?? (err as { error?: { param?: string } })?.error?.param;
  if (typeof param === 'string' && param) return param;
  for (const candidate of [
    'reasoning_effort', 'temperature', 'response_format', 'max_completion_tokens',
    'prompt_cache_key', 'dimensions',
  ]) {
    if (message.includes(candidate)) return candidate;
  }
  return null;
}

export function resetUnsupportedCache(): void {
  unsupported.clear();
}

export class AiClient {
  private clients = new Map<Role, OpenAI>();
  private spent = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db | null,
    private readonly jobId: string | null = null,
  ) {}

  get dryRun(): boolean {
    return this.config.env.dryRun || (!this.available('cheap') && !this.available('deep'));
  }

  available(role: Role): boolean {
    const endpoint = this.endpoint(role);
    return !!endpoint.apiKey;
  }

  providerFor(role: Role): string {
    return this.endpoint(role).provider;
  }

  /** The files/batches API is not part of OpenAI chat compatibility. */
  supportsBatch(role: Exclude<Role, 'embedding'>): boolean {
    return this.providerFor(role) === 'openai';
  }

  private endpoint(role: Role) {
    return this.config.env.aiEndpoints[role === 'cheap' ? 'triage' : role];
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** Resolved model config for a chat role, honouring any env override. */
  chatConfig(role: Exclude<Role, 'embedding'>): ChatModelConfig {
    const models = this.config.models.models;
    const base = role === 'cheap' ? models.triage : models.deep;
    const override = role === 'cheap' ? this.config.env.modelOverrides.triage : this.config.env.modelOverrides.deep;
    return override ? { ...base, model: override } : base;
  }

  modelFor(role: Role): string {
    if (role === 'embedding') {
      return this.config.env.modelOverrides.embedding ?? this.config.models.models.embeddings.model;
    }
    return this.chatConfig(role).model;
  }

  /** Stable cache key for a role, versioned by prompt + taste + ranking config. */
  cacheKey(role: Exclude<Role, 'embedding'>): string {
    const promptId = role === 'cheap' ? this.config.final.luna_gate.prompt : this.config.final.terra_gate.prompt;
    return `sift-${role}-${promptId}-${this.config.hashes.taste}-${this.config.hashes.ranking}`;
  }

  embeddingDimensions(): number | undefined {
    return this.config.models.models.embeddings.dimensions;
  }

  private priceFor(role: Role, usage: Usage): number {
    if (this.providerFor(role) === 'ollama') return 0;
    const models = this.config.models.models;
    if (role === 'embedding') {
      return (usage.inputTokens / 1_000_000) * models.embeddings.cost_per_1m_input;
    }
    const cfg = role === 'cheap' ? models.triage : models.deep;
    // Cached input is billed at a discount, so it is priced separately rather
    // than lumped in with fresh input.
    const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
    const fresh = usage.inputTokens - cached;
    const cachedRate = cfg.cost_per_1m_cached_input ?? cfg.cost_per_1m_input;
    return (
      (fresh / 1_000_000) * cfg.cost_per_1m_input +
      (cached / 1_000_000) * cachedRate +
      (usage.outputTokens / 1_000_000) * cfg.cost_per_1m_output
    );
  }

  private record(role: Role, model: string, usage: Usage, requests = 1, priceMultiplier = 1): void {
    const cost = this.priceFor(role, usage) * priceMultiplier;
    this.spent += cost;
    if (!this.db) return;
    this.db.run(
      `INSERT INTO api_usage (stage, model, input_tokens, cached_input_tokens, output_tokens,
                              requests, estimated_cost, job_id, created_at)
       VALUES (:stage, :model, :in, :cached, :out, :req, :cost, :job, :ts)`,
      {
        stage: role,
        model,
        in: usage.inputTokens,
        cached: usage.cachedInputTokens ?? 0,
        out: usage.outputTokens,
        req: requests,
        cost,
        job: this.jobId,
        ts: Date.now(),
      },
    );
  }

  private assertBudget(): void {
    const limit = this.config.env.maxSpendPerRun;
    if (limit > 0 && this.spent >= limit) throw new SpendLimitError(this.spent, limit);
  }

  private sdk(role: Role): OpenAI {
    let client = this.clients.get(role);
    if (!client) {
      const endpoint = this.endpoint(role);
      if (!endpoint.apiKey) {
        throw new Error(
          `No API key is configured for ${role} (${endpoint.provider}); ` +
          'choose a local provider or run with SIFT_DRY_RUN=1',
        );
      }
      client = new OpenAI({
        apiKey: endpoint.apiKey,
        baseURL: endpoint.baseUrl,
        maxRetries: 0, // retries are handled here, with our own backoff
      });
      this.clients.set(role, client);
    }
    return client;
  }

  /**
   * Build the request body for a chat role.
   *
   * `temperature` is only sent when the model has no reasoning_effort
   * configured: reasoning models generally reject it, and sampling temperature
   * is not a meaningful control for them anyway.
   */
  buildRequestBody(
    role: Exclude<Role, 'embedding'>,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: { maxTokens?: number; temperature?: number; jsonMode?: boolean } = {},
  ): Record<string, unknown> {
    const cfg = this.chatConfig(role);
    const model = cfg.model;
    const body: Record<string, unknown> = {
      model,
      messages: hardenModelMessages(messages),
      max_completion_tokens: opts.maxTokens ?? cfg.max_output_tokens ?? (role === 'cheap' ? 300 : 900),
    };

    if (cfg.reasoning_effort && !isUnsupported(model, 'reasoning_effort')) {
      body.reasoning_effort = cfg.reasoning_effort;
    }

    const temperature = cfg.temperature ?? opts.temperature;
    if (!cfg.reasoning_effort && temperature !== undefined && !isUnsupported(model, 'temperature')) {
      body.temperature = temperature;
    }

    if (opts.jsonMode && !isUnsupported(model, 'response_format')) {
      body.response_format = { type: 'json_object' };
    }

    // The system prompt is byte-identical across every item in a stage, and it
    // is the prefix of every request, so the provider can serve it from cache.
    // A stable key per (role, prompt+config version) keeps requests routed to
    // the same cache; it changes automatically when the prompt or taste profile
    // changes, which is exactly when the cache should be considered stale.
    if (!isUnsupported(model, 'prompt_cache_key')) {
      body.prompt_cache_key = this.cacheKey(role);
    }

    return body;
  }

  /** A single chat completion returning raw text. */
  async complete(
    role: Exclude<Role, 'embedding'>,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: { maxTokens?: number; temperature?: number; jsonMode?: boolean; retries?: number } = {},
  ): Promise<CompletionResult> {
    this.assertBudget();
    const model = this.modelFor(role);
    const retries = opts.retries ?? 3;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const body = this.buildRequestBody(role, messages, opts);
      try {
        // The body is assembled dynamically (parameters vary per model), so it
        // cannot be statically typed as the SDK's param object.
        const res = await this.sdk(role).chat.completions.create(
          body as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
        );
        const completion = res as OpenAI.Chat.Completions.ChatCompletion;

        const usage: Usage = {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
          cachedInputTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        };
        this.record(role, model, usage);
        return { text: completion.choices[0]?.message?.content ?? '', usage, model };
      } catch (err) {
        // An unsupported parameter is not a transient failure: drop it and
        // retry immediately rather than backing off or giving up.
        const param = offendingParameter(err);
        if (param && body[param] !== undefined && !isUnsupported(model, param)) {
          markUnsupported(model, param);
          continue;
        }

        const retryable = isRetryable(err);
        log.warn(`${role} completion failed (attempt ${attempt + 1}/${retries + 1})`, err);
        if (!retryable || attempt === retries) throw err;
        await sleep(Math.min(60_000, 1500 * 2 ** attempt) + Math.random() * 500);
      }
    }
    throw new Error('unreachable');
  }

  /** Embeddings for a batch of texts, in input order. */
  async embed(texts: string[]): Promise<{ vectors: number[][]; model: string }> {
    if (texts.length === 0) return { vectors: [], model: this.modelFor('embedding') };
    this.assertBudget();
    const model = this.modelFor('embedding');
    const dimensions = this.embeddingDimensions();

    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const sendDimensions = dimensions !== undefined && !isUnsupported(model, 'dimensions');
      try {
        const res = await this.sdk('embedding').embeddings.create({
          model,
          input: texts,
          ...(sendDimensions ? { dimensions } : {}),
        });
        const vectors = res.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding as number[]);
        this.record('embedding', model, { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: 0 });
        return { vectors, model };
      } catch (err) {
        const param = offendingParameter(err);
        if (param === 'dimensions' && sendDimensions) {
          markUnsupported(model, 'dimensions');
          continue;
        }
        if (!isRetryable(err) || attempt === 3) throw err;
        log.warn(`embedding failed (attempt ${attempt + 1})`, err);
        await sleep(Math.min(60_000, 1500 * 2 ** attempt));
      }
    }
    throw new Error('unreachable');
  }

  /** Direct SDK access, used only by the batch-API helper. */
  rawSdk(role: Exclude<Role, 'embedding'> = 'deep'): OpenAI {
    return this.sdk(role);
  }

  /**
   * Record usage that went through the batch API.
   *
   * Priced at the batch rate, not the sync rate. Reporting the sync price was
   * meant to keep the ledger conservative, but month-to-date spend is what the
   * degradation ladder and `affordableTerraCalls` are computed from -- so a
   * batch-heavy month made the pipeline halve its own allowance and start
   * degrading at half the real spend. A deliberately wrong number stops being
   * conservative once something makes decisions from it.
   */
  recordBatchUsage(role: Exclude<Role, 'embedding'>, usage: Usage, requests: number): void {
    const discount = role === 'deep' ? this.config.models.models.deep.batch_discount : 1;
    this.record(role, this.modelFor(role), usage, requests, discount);
  }
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(message);
}
