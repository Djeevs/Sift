import { main, printTable } from './_bootstrap.js';
import { onboardingReminder } from '../onboarding/index.js';

interface OllamaTags {
  models?: Array<{ name?: string; model?: string }>;
}

async function ollamaModels(baseUrl: string): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const origin = new URL(baseUrl).origin;
    const response = await fetch(`${origin}/api/tags`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json() as OllamaTags;
    return (data.models ?? []).map((model) => model.name ?? model.model ?? '').filter(Boolean);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

await main(async ({ db, config }) => {
  const endpoints = config.env.aiEndpoints;
  const models = config.models.models;
  const rows = ([
    ['triage', models.triage.model],
    ['deep', models.deep.model],
    ['embedding', models.embeddings.model],
  ] as const).map(([role, model]) => {
    const endpoint = endpoints[role];
    return {
      role,
      provider: endpoint.provider,
      model,
      endpoint: endpoint.baseUrl ?? 'OpenAI default',
      credential: endpoint.apiKey ? (endpoint.provider === 'ollama' ? 'not required' : 'configured') : 'MISSING',
    };
  });

  console.log('Sift doctor');
  console.log(`profile: ${config.env.profileId ?? 'neutral default'}`);
  if (config.env.profileId) {
    const reminder = onboardingReminder(config.env.profileId);
    if (reminder) console.log(`onboarding: ${reminder}`);
  }
  console.log('');
  printTable(rows);

  const ollamaEndpoints = [...new Set(
    Object.values(endpoints)
      .filter((endpoint) => endpoint.provider === 'ollama' && endpoint.baseUrl)
      .map((endpoint) => endpoint.baseUrl!),
  )];
  for (const endpoint of ollamaEndpoints) {
    const installed = await ollamaModels(endpoint);
    console.log('');
    if (!installed) {
      console.log(`Ollama: not reachable at ${endpoint}`);
      continue;
    }
    console.log(`Ollama: detected (${installed.length} model${installed.length === 1 ? '' : 's'})`);
    const configured = [models.triage.model, models.deep.model, models.embeddings.model];
    for (const model of configured) {
      const found = installed.some((name) => name === model || name.startsWith(`${model}:`) || model.startsWith(`${name}:`));
      console.log(`  ${found ? 'ok' : 'missing'}  ${model}`);
    }
  }

  const counts = db.get<{ items: number; published: number }>(
    `SELECT (SELECT COUNT(*) FROM feed_items) AS items,
            (SELECT COUNT(*) FROM published_feed_items) AS published`,
  );
  console.log('');
  console.log(`database: ${config.env.dbPath} (${counts?.items ?? 0} items, ${counts?.published ?? 0} placements)`);
  console.log(`taste profile: ${config.taste.strong_interests.length} strong interests, ${config.taste.topic_priorities.length} topic priorities`);
  console.log(`sources: ${config.sources.filter((source) => source.enabled).length} enabled`);
  console.log(`model mode: ${config.env.dryRun ? 'dry run' : rows.every((row) => row.credential !== 'MISSING') ? 'ready' : 'incomplete'}`);

  if (rows.some((row) => !['openai', 'ollama'].includes(row.provider))) {
    console.log('warning: review cost_per_1m_* in config/models.yaml for non-OpenAI hosted models');
  }

  if (!config.env.accessToken || config.env.accessToken === 'change-me-please') {
    console.log('warning: feeds are not access-token protected (fine for localhost; unsafe on a public server)');
  }
  console.log('');
  console.log('Reeder subscription URLs:');
  for (const feed of [...config.feeds, config.classics.feed]) {
    const token = config.env.accessToken && config.env.accessToken !== 'change-me-please'
      ? `?t=${encodeURIComponent(config.env.accessToken)}`
      : '';
    console.log(`  ${config.env.publicUrl}/feed/${feed.slug}.xml${token}`);
  }
  console.log('');
  console.log('Static hosting: npm run export -- --public-url https://YOUR-HOST --output public');
});
