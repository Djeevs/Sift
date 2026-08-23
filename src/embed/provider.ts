import type { AppConfig } from '../config/index.js';
import type { AiClient } from '../ai/client.js';
import { deterministicVector } from './index.js';
import { logger } from '../util/log.js';

const log = logger('semantic');

/**
 * Pluggable semantic provider for stage 3.
 *
 * Stage 3 is meant to be cheap. The API provider uses the embedding endpoint
 * selected for that role; it can be OpenAI, another compatible host, or local
 * Ollama. No inference runtime is bundled into Sift itself.
 *
 * `hash` is a genuinely free fallback that keeps the pipeline running with no API
 * key at all. It is much weaker semantically -- token-hash vectors capture
 * vocabulary overlap, not meaning -- so when it is in use, stage 3 leans on the
 * keyword and editorial-type components instead. That degradation is recorded per
 * item in free_score_components.semantic_provider, so a run scored without real
 * embeddings is never mistaken for one that had them.
 */

export type ProviderName = 'api' | 'hash' | 'none';

export interface SemanticProvider {
  readonly name: ProviderName;
  /** Vectors in input order. Never throws: returns nulls on failure. */
  embed(texts: string[]): Promise<Array<number[] | null>>;
  readonly dimensions: number;
}

class ApiProvider implements SemanticProvider {
  readonly name = 'api' as const;
  constructor(
    private readonly ai: AiClient,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];
    const { vectors } = await this.ai.embed(texts);
    return texts.map((_, i) => vectors[i] ?? null);
  }
}

class HashProvider implements SemanticProvider {
  readonly name = 'hash' as const;
  constructor(readonly dimensions: number) {}

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    return texts.map((t) => deterministicVector(t, this.dimensions));
  }
}

class NoneProvider implements SemanticProvider {
  readonly name = 'none' as const;
  readonly dimensions = 0;
  async embed(texts: string[]): Promise<Array<number[] | null>> {
    return texts.map(() => null);
  }
}

/**
 * Resolve the configured provider, falling back when it cannot run. A semantic
 * outage degrades stage 3 to heuristics rather than stopping the run.
 */
export function resolveSemanticProvider(config: AppConfig, ai: AiClient | null): SemanticProvider {
  const dimensions = config.models.models.embeddings.dimensions ?? 1536;
  const requested = config.models.semantic.provider;
  const fallback = config.models.semantic.fallback;

  const makeFallback = (): SemanticProvider =>
    fallback === 'hash' ? new HashProvider(dimensions) : new NoneProvider();

  if (requested === 'hash') return new HashProvider(dimensions);

  // Any configured OpenAI-compatible embeddings endpoint, including Ollama.
  if (!ai || ai.dryRun || !ai.available('embedding')) {
    log.debug(`no usable API client; semantic scoring falls back to "${fallback}"`);
    return makeFallback();
  }
  return new ApiProvider(ai, dimensions);
}

/** Model identity for the embeddings table, so vectors are never mixed. */
export function providerModelKey(config: AppConfig, provider: SemanticProvider): string {
  if (provider.name === 'api') {
    return config.env.modelOverrides.embedding ?? config.models.models.embeddings.model;
  }
  return `sift-${provider.name}-${provider.dimensions}`;
}
