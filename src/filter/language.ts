import { collapseWhitespace, stripHtml } from '../util/text.js';

export type LanguageVerdict = 'english' | 'non_english' | 'uncertain';

export interface LanguageResult {
  verdict: LanguageVerdict;
  language: string | null;
  confidence: number;
  reason: string;
}

const ENGLISH = new Set(
  'the a an and or but if then than this that these those to of in on for from with without by as at is are was were be been being it its they their them we our you your he she his her not no do does did can could will would should may might about into over under after before why how what when where who new says said more most some any all one two first last has have had'.split(
    ' ',
  ),
);

const DUTCH = new Set(
  'de het een en of maar als dan dit dat deze die naar van in op voor met zonder bij is zijn was waren wordt worden niet geen ook om uit over onder na vóór waarom hoe wat wanneer waar wie nieuwe zegt meer meeste sommige alle eerste laatste heeft hebben had'.split(
    ' ',
  ),
);

const OTHER = new Set(
  'le la les un une et ou mais dans des du pour avec sans est sont pas que qui sur en el los las una y o pero del por con sin es son no der die das ein eine und oder aber von zu mit ist sind nicht im auf für'.split(
    ' ',
  ),
);

function declaredLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (!code || code === 'und' || code === 'mul') return null;
  return code;
}

function wordsFrom(parts: Array<string | null | undefined>): string[] {
  return collapseWhitespace(stripHtml(parts.filter(Boolean).join(' ')))
    .toLocaleLowerCase('en')
    .match(/\p{L}[\p{L}'’.-]*/gu)
    ?.map((word) => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((word) => word.length >= 2) ?? [];
}

/**
 * Conservative article-level language check. Explicit non-English declarations
 * win immediately. Otherwise function words provide a transparent signal; when
 * the text is too short or ambiguous, the caller excludes it.
 */
export function classifyArticleLanguage(
  parts: Array<string | null | undefined>,
  declared?: string | null,
): LanguageResult {
  const declaredCode = declaredLanguage(declared);
  if (declaredCode && declaredCode !== 'en') {
    return {
      verdict: 'non_english',
      language: declaredCode,
      confidence: 1,
      reason: `declared language is ${declaredCode}`,
    };
  }

  const words = wordsFrom(parts).slice(0, 1200);
  let en = 0;
  let nl = 0;
  let other = 0;
  for (const word of words) {
    if (ENGLISH.has(word)) en += 1;
    if (DUTCH.has(word)) nl += 1;
    if (OTHER.has(word)) other += 1;
  }

  // Dutch shares several short words with English. Require both a meaningful
  // absolute signal and a clear lead before rejecting an English-declared feed.
  if (nl >= 5 && nl >= en * 1.35) {
    return {
      verdict: 'non_english',
      language: 'nl',
      confidence: Math.min(0.99, 0.65 + (nl - en) / Math.max(20, words.length)),
      reason: `Dutch function words dominate (${nl} vs ${en} English)`,
    };
  }
  if (other >= 5 && other >= en * 1.35) {
    return {
      verdict: 'non_english',
      language: null,
      confidence: Math.min(0.95, 0.62 + (other - en) / Math.max(20, words.length)),
      reason: `non-English function words dominate (${other} vs ${en} English)`,
    };
  }

  if (en >= 4 && en >= Math.max(nl, other) * 1.25) {
    return {
      verdict: 'english',
      language: 'en',
      confidence: Math.min(0.99, 0.68 + en / Math.max(25, words.length)),
      reason: `English function words dominate (${en})`,
    };
  }

  if (declaredCode === 'en' && words.length >= 8 && nl < 3 && other < 3) {
    return {
      verdict: 'english',
      language: 'en',
      confidence: 0.72,
      reason: 'declared English with no conflicting language signal',
    };
  }

  return {
    verdict: 'uncertain',
    language: declaredCode,
    confidence: 0,
    reason: `insufficient language evidence (${words.length} words, ${en} English markers)`,
  };
}

