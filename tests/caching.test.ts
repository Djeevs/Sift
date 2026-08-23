import { describe, it, expect } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import { migrate } from '../src/db/index.js';
import { loadPrompt, render, tasteVars, feedVars } from '../src/ai/prompts.js';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { testDb } from './helpers.js';

const config = loadConfig();
const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'usr' }];

describe('prompt cache key', () => {
  it('is stable across calls for the same role', () => {
    const ai = new AiClient(config, null);
    expect(ai.cacheKey('cheap')).toBe(ai.cacheKey('cheap'));
    expect(ai.buildRequestBody('cheap', messages).prompt_cache_key).toBe(ai.cacheKey('cheap'));
  });

  it('differs per role, so the two stages do not fight over one cache entry', () => {
    const ai = new AiClient(config, null);
    expect(ai.cacheKey('cheap')).not.toBe(ai.cacheKey('deep'));
  });

  it('changes when the taste profile changes, invalidating a stale cache', () => {
    const ai = new AiClient(config, null);
    const edited: AppConfig = { ...config, hashes: { ...config.hashes, taste: 'different' } };
    expect(new AiClient(edited, null).cacheKey('deep')).not.toBe(ai.cacheKey('deep'));
  });
});

describe('static prefix', () => {
  it('puts the identical system prompt first in every request', () => {
    const ai = new AiClient(config, null);
    const body = ai.buildRequestBody('deep', messages);
    const sent = body.messages as Array<{ role: string; content: string }>;
    expect(sent[0]?.role).toBe('system');
  });

  it('renders a system prompt long enough to be cacheable', () => {
    // Providers only cache prompts above a minimum length (1024 tokens for
    // OpenAI). A trimmed taste profile once put the triage prompt just under it,
    // which silently disabled caching for the highest-volume stage. Both prompts
    // are checked here so that regression cannot happen unnoticed.
    const MIN_CACHEABLE_CHARS = 4200; // ~1050+ tokens, conservatively
    for (const [role, vars] of [
      ['triage', config.final.luna_gate.prompt],
      ['deep', config.final.terra_gate.prompt],
    ] as const) {
      const rendered = render(loadPrompt(config, vars).body, { ...tasteVars(config.taste), ...feedVars(config) });
      expect(rendered.length, `${role} system prompt is too short to be cached`).toBeGreaterThan(MIN_CACHEABLE_CHARS);
    }
  });
});

describe('cached-token accounting', () => {
  it('prices cached input at the discounted rate', () => {
    const priced: AppConfig = {
      ...config,
      models: {
        ...config.models,
        models: {
          ...config.models.models,
          deep: {
            model: 'm',
            cost_per_1m_input: 10,
            cost_per_1m_cached_input: 1,
            cost_per_1m_output: 0,
          },
        },
      },
    };
    const ai = new AiClient(priced, null);
    // 1M input tokens, 900k of them cached: 100k at $10/M + 900k at $1/M.
    ai.recordBatchUsage('deep', { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 }, 1);
    expect(ai.spentUsd).toBeCloseTo(1 + 0.9, 6);
  });

  it('falls back to the full input price when no cached rate is configured', () => {
    const priced: AppConfig = {
      ...config,
      models: {
        ...config.models,
        models: {
          ...config.models.models,
          deep: { model: 'm', cost_per_1m_input: 10, cost_per_1m_output: 0 },
        },
      },
    };
    const ai = new AiClient(priced, null);
    // Over-estimating is the safe direction for an unknown cached rate.
    ai.recordBatchUsage('deep', { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 }, 1);
    expect(ai.spentUsd).toBeCloseTo(10, 6);
  });

  it('never counts more cached tokens than input tokens', () => {
    const priced: AppConfig = {
      ...config,
      models: {
        ...config.models,
        models: {
          ...config.models.models,
          deep: { model: 'm', cost_per_1m_input: 10, cost_per_1m_cached_input: 0, cost_per_1m_output: 0 },
        },
      },
    };
    const ai = new AiClient(priced, null);
    ai.recordBatchUsage('deep', { inputTokens: 1000, cachedInputTokens: 999_999, outputTokens: 0 }, 1);
    expect(ai.spentUsd).toBe(0);
  });

  it('records cached tokens in the usage ledger', () => {
    const { db, config: cfg } = testDb();
    const ai = new AiClient(cfg, db);
    ai.recordBatchUsage('cheap', { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 }, 1);
    const row = db.get<{ input_tokens: number; cached_input_tokens: number }>(
      `SELECT input_tokens, cached_input_tokens FROM api_usage ORDER BY id DESC LIMIT 1`,
    );
    expect(row).toMatchObject({ input_tokens: 1000, cached_input_tokens: 800 });
    db.close();
  });
});

describe('schema migration', () => {
  it('adds cached_input_tokens to a database created before it existed', () => {
    const { db } = testDb();
    // Simulate the old shape, then re-run the migration.
    db.exec('DROP TABLE api_usage');
    db.exec(`CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 1, estimated_cost REAL NOT NULL DEFAULT 0,
      job_id TEXT, created_at INTEGER NOT NULL)`);

    const before = db.all<{ name: string }>(`PRAGMA table_info(api_usage)`).map((c) => c.name);
    expect(before).not.toContain('cached_input_tokens');

    migrate(db);

    const after = db.all<{ name: string }>(`PRAGMA table_info(api_usage)`).map((c) => c.name);
    expect(after).toContain('cached_input_tokens');
    db.close();
  });
});
