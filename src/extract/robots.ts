import { fetchText } from '../util/http.js';
import { hostOf } from '../util/url.js';
import { logger } from '../util/log.js';

const log = logger('robots');

/**
 * A small, strict robots.txt client.
 *
 * When in doubt this returns "not allowed". Sift is a well-behaved reader:
 * it never attempts to bypass paywalls, logins or crawl restrictions, and it
 * always has the RSS summary to fall back on.
 */

interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number | null;
  fetchedAt: number;
}

const cache = new Map<string, RobotsRules>();
const CACHE_TTL_MS = 12 * 3_600_000;

function parseRobots(text: string, userAgent: string): RobotsRules {
  const rules: RobotsRules = { allow: [], disallow: [], crawlDelayMs: null, fetchedAt: Date.now() };
  const ua = userAgent.toLowerCase();

  // Collect group blocks, then prefer a block naming us over the wildcard one.
  let currentAgents: string[] = [];
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[]; delay: number | null }> = [];
  let group: (typeof groups)[number] | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (group && (group.allow.length || group.disallow.length || group.delay !== null)) {
        groups.push(group);
        group = null;
        currentAgents = [];
      }
      currentAgents.push(value.toLowerCase());
      group ??= { agents: [], allow: [], disallow: [], delay: null };
      group.agents = [...currentAgents];
      continue;
    }
    if (!group) continue;
    if (field === 'allow' && value) group.allow.push(value);
    else if (field === 'disallow') group.disallow.push(value);
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) group.delay = n * 1000;
    }
  }
  if (group) groups.push(group);

  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = specific ?? wildcard;
  if (chosen) {
    rules.allow = chosen.allow;
    rules.disallow = chosen.disallow;
    rules.crawlDelayMs = chosen.delay;
  }
  return rules;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  // robots.txt supports * wildcards and a trailing $ anchor.
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return path.startsWith(pattern.replace(/\*/g, ''));
  }
}

async function getRules(origin: string, userAgent: string): Promise<RobotsRules | null> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const res = await fetchText(`${origin}/robots.txt`, { retries: 1, timeoutMs: 8000, maxBytes: 500_000 });
  if (!res.ok) {
    // No robots.txt (or unreachable) conventionally means "no restrictions".
    const permissive: RobotsRules = { allow: [], disallow: [], crawlDelayMs: null, fetchedAt: Date.now() };
    cache.set(origin, permissive);
    return permissive;
  }
  const rules = parseRobots(res.body, userAgent);
  cache.set(origin, rules);
  return rules;
}

export interface RobotsVerdict {
  allowed: boolean;
  crawlDelayMs: number | null;
  reason: string;
}

export async function checkRobots(url: string, userAgent: string): Promise<RobotsVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, crawlDelayMs: null, reason: 'invalid URL' };
  }
  const origin = `${parsed.protocol}//${parsed.host}`;

  try {
    const rules = await getRules(origin, userAgent);
    if (!rules) return { allowed: true, crawlDelayMs: null, reason: 'no rules' };

    const path = parsed.pathname + parsed.search;
    // The longest matching rule wins; Allow beats Disallow at equal length.
    let bestDisallow = -1;
    let bestAllow = -1;
    for (const rule of rules.disallow) {
      if (pathMatches(rule, path)) bestDisallow = Math.max(bestDisallow, rule.length);
    }
    for (const rule of rules.allow) {
      if (pathMatches(rule, path)) bestAllow = Math.max(bestAllow, rule.length);
    }

    if (bestDisallow >= 0 && bestAllow >= bestDisallow) {
      return { allowed: true, crawlDelayMs: rules.crawlDelayMs, reason: 'allowed by more specific Allow rule' };
    }
    if (bestDisallow >= 0) {
      return { allowed: false, crawlDelayMs: rules.crawlDelayMs, reason: 'disallowed by robots.txt' };
    }
    return { allowed: true, crawlDelayMs: rules.crawlDelayMs, reason: 'allowed' };
  } catch (err) {
    log.debug(`robots check failed for ${origin}`, err);
    return { allowed: true, crawlDelayMs: null, reason: 'robots check failed, treating as allowed' };
  }
}

export function clearRobotsCache(): void {
  cache.clear();
}

export { parseRobots, pathMatches };
