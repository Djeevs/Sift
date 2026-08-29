import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { atomicWrite } from '../onboarding/index.js';

/** Read a `.env`-shaped file, dropping anything that did not parse to a string. */
export function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return Object.fromEntries(
      Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

export function safeEnvValue(value: string, label: string, max = 1000): string {
  if (value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${label} contains invalid characters.`);
  return value.trim();
}

/**
 * Preserve unrelated settings and comments. Values are always quoted so
 * API-key or token punctuation can never become dotenv syntax.
 */
export function updateEnv(path: string, updates: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^${key}=`).test(line));
    const rendered = `${key}=${JSON.stringify(value)}`;
    if (index >= 0) lines[index] = rendered;
    else lines.push(rendered);
  }
  atomicWrite(path, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}
