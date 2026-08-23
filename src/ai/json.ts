import { z } from 'zod';

/**
 * Models return JSON that is *usually* valid. This module makes the remaining
 * cases survivable: code fences, prose preambles, trailing commas, smart quotes,
 * NaN, and scores expressed as percentages or strings.
 */

export function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  let text = raw.trim();

  // ```json ... ``` fences.
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return null;

  // Walk to the matching brace, ignoring braces inside strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unterminated object: return what we have and let repair try.
  return text.slice(start);
}

function repair(text: string): string {
  return text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\bNaN\b/g, '0')
    .replace(/\b(Infinity|-Infinity)\b/g, '0')
    .replace(/\bNone\b/g, 'null')
    .replace(/\b(True|False)\b/g, (m) => m.toLowerCase());
}

export function parseLooseJson(raw: string): unknown {
  const extracted = extractJsonObject(raw);
  if (!extracted) throw new Error('no JSON object found in model output');
  try {
    return JSON.parse(extracted);
  } catch {
    try {
      return JSON.parse(repair(extracted));
    } catch {
      // A truncated response: close any open braces and retry once.
      const closed = closeOpenStructures(repair(extracted));
      return JSON.parse(closed);
    }
  }
}

function closeOpenStructures(text: string): string {
  let depth = 0;
  let arrays = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '[') arrays += 1;
    else if (ch === ']') arrays -= 1;
  }
  let out = text.trimEnd().replace(/,$/, '');
  if (inString) out += '"';
  out += ']'.repeat(Math.max(0, arrays));
  out += '}'.repeat(Math.max(0, depth));
  return out;
}

/** A 0..1 score, however the model chose to express it. */
export const scoreSchema = z
  .union([z.number(), z.string()])
  .transform((v) => {
    let n = typeof v === 'number' ? v : Number(String(v).replace(/[%\s]/g, ''));
    if (!Number.isFinite(n)) return 0;
    // "85" or "85%" clearly means 0.85. But 1.7 is a model overshooting a 0-1
    // scale, not 1.7% -- reading it as a percentage would turn a near-maximum
    // score into a near-zero one, which is far worse than clamping.
    if (n >= 2 && n <= 100) n /= 100;
    return Math.max(0, Math.min(1, n));
  })
  .pipe(z.number().min(0).max(1));

export const looseBool = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return /^(true|yes|1)$/i.test(v.trim());
  });

export const looseStringArray = z
  .union([z.array(z.union([z.string(), z.number()])), z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return [] as string[];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return v
      .split(/[,;]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  });

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  raw: string;
}

/** Parse + validate a model response. Never throws. */
export function parseModelJson<S extends z.ZodTypeAny>(raw: string, schema: S): ParseResult<z.output<S>> {
  let parsed: unknown;
  try {
    parsed = parseLooseJson(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), raw };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `schema mismatch: ${issues}`, raw };
  }
  return { ok: true, value: result.data, raw };
}
