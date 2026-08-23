/**
 * URL canonicalisation.
 *
 * Two jobs: give every item a stable identity so reruns cannot duplicate it,
 * and strip the tracking noise publishers append so the same article arriving
 * from two feeds collapses to one row.
 */

const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^ref$/i,
  /^ref_src$/i,
  /^refsrc$/i,
  /^referrer$/i,
  /^source$/i,
  /^src$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^hsCtaTracking$/i,
  /^vero_id$/i,
  /^oly_enc_id$/i,
  /^oly_anon_id$/i,
  /^__twitter_impression$/i,
  /^guccounter$/i,
  /^guce_referrer/i,
  /^cmpid$/i,
  /^smid$/i,
  /^curator$/i,
  /^triedRedirect$/i,
  // Substack / Beehiiv / Ghost newsletter plumbing.
  /^publication_id$/i,
  /^post_id$/i,
  /^isFreemail$/i,
  /^r$/i,
  /^showWelcome$/i,
  /^redirect$/i,
  /^triggerShare$/i,
  /^open_?email/i,
];

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((re) => re.test(key));
}

/** Normalise a URL for identity + deduplication. Returns null if unusable. */
export function canonicalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = String(input).trim();
  if (!raw) return null;

  // Protocol-relative and bare-host URLs show up in malformed feeds.
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // Publishers are inconsistent about http/https for the same article.
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4);
  if (u.port && DEFAULT_PORTS[u.protocol] === u.port) u.port = '';
  if (!u.hostname) return null;

  // Fragments are never part of an article's identity, except for SPA routes
  // that genuinely encode the path (#!/...), which are worth keeping.
  u.hash = u.hash.startsWith('#!') ? u.hash : '';

  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  // Trailing slash is not meaningful for article URLs; the root is left alone.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');

  return u.toString();
}

/** Host without www, for per-host politeness and publisher matching. */
export function hostOf(url: string | null | undefined): string | null {
  const c = canonicalizeUrl(url);
  if (!c) return null;
  try {
    return new URL(c).hostname;
  } catch {
    return null;
  }
}

/** Registrable-ish domain, good enough to tell "same publisher". */
export function publisherDomain(url: string | null | undefined): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // Handle the common two-part public suffixes we actually meet (co.uk etc).
  const twoPart = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.nz', 'co.jp']);
  const lastTwo = parts.slice(-2).join('.');
  if (twoPart.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export function resolveUrl(base: string | null | undefined, href: string): string | null {
  try {
    return base ? new URL(href, base).toString() : new URL(href).toString();
  } catch {
    return null;
  }
}

/** Do two URLs point at the same article, ignoring tracking noise? */
export function sameArticle(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalizeUrl(a);
  const cb = canonicalizeUrl(b);
  return !!ca && !!cb && ca === cb;
}
