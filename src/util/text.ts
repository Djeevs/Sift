const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const num = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(num) && num > 0 && num <= 0x10ffff) {
        try {
          return String.fromCodePoint(num);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** HTML to readable plain text. Deliberately simple and dependency-free. */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/?(p|div|br|li|tr|h[1-6]|blockquote|section|article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function escapeXml(input: string | null | undefined): string {
  if (input == null) return '';
  return String(input)
    // Control characters are illegal in XML 1.0 and break strict parsers.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'as',
  'how', 'why', 'what', 'when', 'who', 'we', 'you', 'i', 'not', 'can', 'will', 'has', 'have', 'had',
  'de', 'het', 'een', 'van', 'en', 'op', 'te', 'is', 'met', 'voor', 'naar', 'over',
]);

/** Content tokens used for title similarity and cheap entity overlap. */
export function tokenize(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = a instanceof Set ? a : new Set(a);
  const sb = b instanceof Set ? b : new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return jaccard(tokenize(a), tokenize(b));
}

/**
 * Capitalised multi-word phrases and acronyms. A cheap stand-in for real NER,
 * which is plenty for deciding whether two articles are about the same event.
 */
export function namedEntities(input: string | null | undefined): string[] {
  if (!input) return [];
  const found = new Set<string>();
  const text = String(input).slice(0, 4000);
  const phrase = /\b([A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = phrase.exec(text)) !== null) {
    const value = m[1]!.trim();
    if (value.length < 3) continue;
    const words = value.split(/\s+/);
    if (words.length === 1 && (STOPWORDS.has(value.toLowerCase()) || value.length < 4)) continue;
    found.add(value.toLowerCase());
  }
  for (const acr of text.match(/\b[A-Z]{2,6}\b/g) ?? []) found.add(acr.toLowerCase());
  return [...found];
}

/** Rough reading time. Fine for a personal system; no need for real analysis. */
export function estimateReadingMinutes(text: string | null | undefined, wordsPerMinute = 230): number | null {
  if (!text) return null;
  const words = text.trim().split(/\s+/).length;
  if (words < 40) return null;
  return Math.max(1, Math.round(words / wordsPerMinute));
}

/**
 * Cut a long article down to a budget while keeping both ends.
 *
 * Plain head truncation is the wrong shape for judging an argument. A 49,000-
 * character essay cut at 14,000 shows the model the setup and never the payoff,
 * so it cannot tell a piece that earns its length from one that meanders -- and
 * "does this actually deliver?" is most of what deep evaluation is for.
 *
 * Keeping the opening and the closing is deterministic, uses no model call, and
 * gives back the part where an argument either lands or does not. The elision is
 * marked explicitly so the model knows it is reading an excerpt rather than a
 * complete short piece, which would otherwise skew a length-aware judgement.
 */
export function structuralExcerpt(
  body: string,
  maxChars: number,
  headShare = 0.6,
): { text: string; excerpted: boolean; omittedChars: number } {
  if (!body || body.length <= maxChars) {
    return { text: body ?? '', excerpted: false, omittedChars: 0 };
  }

  const marker = '\n\n[... middle of the article omitted ...]\n\n';
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(available * headShare);
  const tailChars = available - headChars;

  // Prefer to cut at a paragraph break so neither end starts or stops mid-thought.
  const head = body.slice(0, headChars);
  const headCut = head.lastIndexOf('\n\n');
  const headText = headCut > headChars * 0.6 ? head.slice(0, headCut) : head;

  const tail = body.slice(body.length - tailChars);
  const tailCut = tail.indexOf('\n\n');
  const tailText = tailCut >= 0 && tailCut < tailChars * 0.4 ? tail.slice(tailCut + 2) : tail;

  return {
    text: `${headText}${marker}${tailText}`,
    excerpted: true,
    omittedChars: body.length - headText.length - tailText.length,
  };
}
