import { describe, it, expect, beforeEach } from 'vitest';
import { AiClient, offendingParameter, resetUnsupportedCache } from '../src/ai/client.js';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { rankingConfigSchema } from '../src/config/schema.js';
import { parseBatchOutput } from '../src/ai/batch.js';

const config = loadConfig();

function withModels(overrides: Partial<AppConfig['models']['models']>): AppConfig {
  return {
    ...config,
    models: { ...config.models, models: { ...config.models.models, ...overrides } },
  };
}

const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'usr' }];

beforeEach(() => {
  resetUnsupportedCache();
});

describe('model configuration', () => {
  it('reads the three roles from ranking-config.yaml', () => {
    expect(config.models.models.triage.model).toBe('gpt-5.6-luna');
    expect(config.models.models.triage.reasoning_effort).toBe('none');
    expect(config.models.models.deep.model).toBe('gpt-5.6-terra');
    expect(config.models.models.deep.reasoning_effort).toBe('low');
    expect(config.models.models.embeddings.model).toBe('text-embedding-3-small');
  });

  it('resolves each role to its configured model', () => {
    const ai = new AiClient(config, null);
    expect(ai.modelFor('cheap')).toBe('gpt-5.6-luna');
    expect(ai.modelFor('deep')).toBe('gpt-5.6-terra');
    expect(ai.modelFor('embedding')).toBe('text-embedding-3-small');
  });

  it('resolves an independent endpoint for every role', () => {
    const portable: AppConfig = {
      ...config,
      env: {
        ...config.env,
        aiEndpoints: {
          triage: { provider: 'ollama', apiKey: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
          deep: { provider: 'anthropic', apiKey: 'secret', baseUrl: 'https://api.anthropic.com/v1/' },
          embedding: { provider: 'openai', apiKey: 'secret', baseUrl: undefined },
        },
      },
    };
    const ai = new AiClient(portable, null);
    expect(ai.providerFor('cheap')).toBe('ollama');
    expect(ai.providerFor('deep')).toBe('anthropic');
    expect(ai.providerFor('embedding')).toBe('openai');
    expect(ai.available('embedding')).toBe(true);
    expect(ai.supportsBatch('deep')).toBe(false);
  });

  it('lets an env override replace a model without touching the rest of its config', () => {
    const overridden: AppConfig = {
      ...config,
      env: { ...config.env, modelOverrides: { deep: 'some-other-model' } },
    };
    const ai = new AiClient(overridden, null);
    expect(ai.modelFor('deep')).toBe('some-other-model');
    // reasoning_effort still comes from the YAML.
    expect(ai.chatConfig('deep').reasoning_effort).toBe('low');
    expect(ai.modelFor('cheap')).toBe('gpt-5.6-luna');
  });

  it('rejects a config with a model role missing', () => {
    const broken = { ...config.ranking, models: { triage: { model: 'x' } } };
    // Re-validating through the schema is what loadConfig does.
    expect(() => rankingConfigSchema.parse(broken)).toThrow();
  });
});

describe('request body construction', () => {
  it('sends reasoning_effort and omits temperature when effort is configured', () => {
    const ai = new AiClient(config, null);
    const body = ai.buildRequestBody('deep', messages, { temperature: 0.2, jsonMode: true });
    expect(body.model).toBe('gpt-5.6-terra');
    expect(body.reasoning_effort).toBe('low');
    // Reasoning models generally reject temperature; it must not be sent.
    expect(body).not.toHaveProperty('temperature');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('passes reasoning_effort "none" through verbatim rather than dropping it', () => {
    const ai = new AiClient(config, null);
    const body = ai.buildRequestBody('cheap', messages, { temperature: 0.1 });
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('temperature');
  });

  it('still sends temperature for a model with no reasoning control', () => {
    const plain = withModels({
      deep: { model: 'plain-model', cost_per_1m_input: 1, cost_per_1m_output: 2 },
    });
    const ai = new AiClient(plain, null);
    const body = ai.buildRequestBody('deep', messages, { temperature: 0.2 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.temperature).toBe(0.2);
  });

  it('uses max_output_tokens from config, and lets a caller override it', () => {
    const ai = new AiClient(config, null);
    expect(ai.buildRequestBody('cheap', messages).max_completion_tokens).toBe(220);
    expect(ai.buildRequestBody('deep', messages).max_completion_tokens).toBe(700);
    expect(ai.buildRequestBody('deep', messages, { maxTokens: 50 }).max_completion_tokens).toBe(50);
  });

  it('prefers a temperature pinned in config over the caller\'s', () => {
    const pinned = withModels({
      deep: { model: 'plain-model', temperature: 0.9, cost_per_1m_input: 0, cost_per_1m_output: 0 },
    });
    const ai = new AiClient(pinned, null);
    expect(ai.buildRequestBody('deep', messages, { temperature: 0.2 }).temperature).toBe(0.9);
  });
});

describe('batch requests use the same body builder as sync', () => {
  /**
   * Regression: the batch path once hand-built its request body and hard-coded
   * `temperature: 0.2`. Reasoning models reject that, so all 60 requests in a
   * real batch failed validation -- and because batch failures land in an error
   * file rather than the output file, it surfaced as "zero results" with no error
   * anywhere. The body must come from one place.
   */
  it('omits temperature and includes reasoning_effort for a reasoning model', () => {
    const ai = new AiClient(config, null);
    const body = ai.buildRequestBody('deep', messages, { jsonMode: true });
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_completion_tokens).toBe(700);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('reports a failed batch line as an error rather than as empty output', () => {
    const errorLine = JSON.stringify({
      custom_id: 'item-1',
      response: {
        status_code: 400,
        body: {
          error: {
            message: "Unsupported value: 'temperature' does not support 0.2 with this model.",
            param: 'temperature',
          },
        },
      },
    });
    const outcomes = parseBatchOutput(errorLine);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.error).toContain('temperature');
    expect(outcomes[0]!.text).toBe('');
  });

  it('treats a non-200 status as a failure even without an error body', () => {
    const line = JSON.stringify({ custom_id: 'x', response: { status_code: 500, body: {} } });
    expect(parseBatchOutput(line)[0]!.error).toBeTruthy();
  });
});

describe('unsupported-parameter detection', () => {
  it('recognises the parameter a 400 is complaining about', () => {
    expect(offendingParameter({ status: 400, param: 'reasoning_effort' })).toBe('reasoning_effort');
    expect(
      offendingParameter({ status: 400, message: "Unsupported parameter: 'temperature' is not supported" }),
    ).toBe('temperature');
    expect(
      offendingParameter({ status: 400, error: { message: 'reasoning_effort is not supported with this model' } }),
    ).toBe('reasoning_effort');
  });

  it('ignores errors that are not about a parameter', () => {
    expect(offendingParameter({ status: 429, message: 'rate limited' })).toBeNull();
    expect(offendingParameter({ status: 500, message: 'server error' })).toBeNull();
    expect(offendingParameter({ status: 400, message: 'context length exceeded' })).toBeNull();
    expect(offendingParameter(new Error('network'))).toBeNull();
  });
});

describe('cost accounting', () => {
  it('uses the per-model prices from config', () => {
    const priced = withModels({
      deep: { model: 'm', reasoning_effort: 'low', cost_per_1m_input: 2, cost_per_1m_output: 10 },
    });
    const ai = new AiClient(priced, null);
    // 1M input + 1M output at $2/$10.
    ai.recordBatchUsage('deep', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 1);
    expect(ai.spentUsd).toBeCloseTo(12, 6);
  });

  it('has real prices configured for every role', () => {
    // A model change with prices left at 0 silently disables both the spend
    // report and SIFT_MAX_SPEND_PER_RUN, so this guards against shipping that.
    const { triage, deep, embeddings } = config.models.models;
    for (const [role, cfg] of [['triage', triage], ['deep', deep]] as const) {
      expect(cfg.cost_per_1m_input, `${role} input price is unset`).toBeGreaterThan(0);
      expect(cfg.cost_per_1m_output, `${role} output price is unset`).toBeGreaterThan(0);
      expect(cfg.cost_per_1m_cached_input, `${role} cached price is unset`).toBeGreaterThan(0);
      // Cached input should be cheaper than fresh, or caching is pointless.
      expect(cfg.cost_per_1m_cached_input!).toBeLessThan(cfg.cost_per_1m_input);
    }
    expect(embeddings.cost_per_1m_input).toBeGreaterThan(0);
  });

  it('computes spend from the configured prices', () => {
    const ai = new AiClient(config, null);
    const deep = config.models.models.deep;
    ai.recordBatchUsage('deep', { inputTokens: 500_000, outputTokens: 100_000 }, 1);
    const expected = (500_000 / 1e6) * deep.cost_per_1m_input + (100_000 / 1e6) * deep.cost_per_1m_output;
    expect(ai.spentUsd).toBeCloseTo(expected, 6);
  });

  it('does not invent API spend for local Ollama inference', () => {
    const local: AppConfig = {
      ...config,
      env: {
        ...config.env,
        aiEndpoints: {
          ...config.env.aiEndpoints,
          deep: { provider: 'ollama', apiKey: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
        },
      },
    };
    const ai = new AiClient(local, null);
    ai.recordBatchUsage('deep', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 1);
    expect(ai.spentUsd).toBe(0);
  });
});
