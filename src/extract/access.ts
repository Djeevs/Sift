import type { SourceConfig } from '../config/index.js';

export interface ArticleAccessRecord {
  extraction_method: string | null;
  body_chars: number | null;
  structured_data: string | null;
}

export interface ArticleAccessVerdict {
  eligible: boolean;
  reason: string;
}

type JsonObject = Record<string, unknown>;

function asAccessBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return null;
}

function objectsIn(node: unknown, depth = 0): JsonObject[] {
  if (node == null || depth > 8) return [];
  if (Array.isArray(node)) return node.flatMap((entry) => objectsIn(entry, depth + 1));
  if (typeof node !== 'object') return [];
  const object = node as JsonObject;
  return [object, ...Object.values(object).flatMap((entry) => objectsIn(entry, depth + 1))];
}

function typesOf(object: JsonObject): string[] {
  const raw = object['@type'];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
  return typeof raw === 'string' ? [raw] : [];
}

/**
 * Read schema.org's per-article access declaration conservatively. Article-like
 * nodes win over generic WebPage nodes, and any conflicting false wins over true.
 */
export function explicitFreeAccess(structuredData: string | null): boolean | null {
  if (!structuredData) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(structuredData);
  } catch {
    return null;
  }

  const objects = objectsIn(parsed);
  const articleObjects = objects.filter((object) =>
    typesOf(object).some((type) => /(?:news)?article|blogposting|report/i.test(type)),
  );
  const candidates = articleObjects.length > 0 ? articleObjects : objects;
  const declarations = candidates
    .map((object) => asAccessBoolean(object.isAccessibleForFree))
    .filter((value): value is boolean => value !== null);

  if (declarations.includes(false)) return false;
  if (declarations.includes(true)) return true;
  return null;
}

/** Apply configured access rules after fetching the canonical article page. */
export function evaluateArticleAccess(
  source: SourceConfig,
  record: ArticleAccessRecord | undefined,
  minExtractedChars: number,
): ArticleAccessVerdict {
  if (source.hard_rules?.require_explicit_free_article) {
    const explicit = explicitFreeAccess(record?.structured_data ?? null);
    if (explicit === false) return { eligible: false, reason: 'article metadata marks this post as subscriber-only' };
    if (explicit !== true) return { eligible: false, reason: 'article has no explicit free-access declaration' };
  }

  if (source.hard_rules?.require_readable_article) {
    const readable =
      record?.extraction_method === 'readability' &&
      (record.body_chars ?? 0) >= minExtractedChars;
    if (!readable) {
      return { eligible: false, reason: 'linked article was not verifiably fully readable' };
    }
  }

  return { eligible: true, reason: 'article passed configured access checks' };
}
