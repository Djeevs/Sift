import { createHash } from 'node:crypto';

/** Short, stable, collision-resistant-enough id for a single-user system. */
export function stableId(...parts: (string | null | undefined)[]): string {
  const h = createHash('sha256');
  h.update(parts.map((p) => p ?? '').join(' '));
  return h.digest('hex').slice(0, 20);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash of a config file's content, recorded alongside every AI judgement. */
export function contentHash(input: string): string {
  return sha256(input).slice(0, 12);
}
