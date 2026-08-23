import { logger } from './log.js';
import { hostOf } from './url.js';
import { sleep } from './time.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const log = logger('http');

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  retries?: number;
  /** Conditional GET support: feeds are polled every 90 minutes. */
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  /** 304 Not Modified: nothing changed since the previous poll. */
  notModified: boolean;
  body: string;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  error?: string;
}

const DEFAULT_TIMEOUT = Number(process.env.SIFT_HTTP_TIMEOUT_MS ?? 20_000);
const USER_AGENT =
  process.env.SIFT_USER_AGENT ?? 'SiftPersonalReader/0.1 (+personal RSS curation)';

/** Status codes where retrying is pointless. */
const PERMANENT = new Set([400, 401, 403, 404, 405, 410, 451]);

/** Politeness: never hammer one host, whatever the concurrency setting says. */
const lastRequestByHost = new Map<string, number>();

type AddressResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Public-web fetches must not become a proxy into localhost, a home network or
 * cloud metadata endpoints. Private access can be explicitly enabled for a
 * trusted local Reeder/feed setup with SIFT_ALLOW_PRIVATE_NETWORK=1. */
export async function validateOutboundUrl(
  raw: string,
  options: { allowPrivate?: boolean; resolveAddresses?: AddressResolver } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked URL protocol: ${url.protocol || '(none)'}`);
  }
  if (url.username || url.password) throw new Error('blocked URL containing credentials');
  if (!url.hostname) throw new Error('blocked URL without a hostname');
  if (options.allowPrivate) return url;

  // WHATWG URL keeps brackets around IPv6 literals; node:net and DNS do not.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname) ? [hostname] : await (options.resolveAddresses ?? defaultResolver)(hostname);
  if (literal.length === 0) throw new Error(`hostname did not resolve: ${hostname}`);
  const blocked = literal.find((address) => !isPublicAddress(address));
  if (blocked) throw new Error(`blocked non-public address for ${hostname}: ${blocked}`);
  return url;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = octets as [number, number, number, number];
    // Each reserved range is matched at its real prefix length. Three of these
    // were written as /16 when IANA reserves only a /24, which blocked large
    // amounts of ordinary public internet: 192.0.66/78/79.x is Automattic, so
    // every WordPress.com-hosted source -- longreads, acoup.blog, nautil.us,
    // stereogum -- failed to fetch with "blocked non-public address".
    return !(
      a === 0 ||                                  // 0.0.0.0/8      this network
      a === 10 ||                                 // 10.0.0.0/8     private
      a === 127 ||                                // 127.0.0.0/8    loopback
      (a === 100 && b >= 64 && b <= 127) ||       // 100.64.0.0/10  CGNAT
      (a === 169 && b === 254) ||                 // 169.254.0.0/16 link-local
      (a === 172 && b >= 16 && b <= 31) ||        // 172.16.0.0/12  private
      (a === 192 && b === 0 && c === 0) ||        // 192.0.0.0/24   IETF assignments
      (a === 192 && b === 0 && c === 2) ||        // 192.0.2.0/24   TEST-NET-1
      (a === 192 && b === 168) ||                 // 192.168.0.0/16 private
      (a === 192 && b === 88 && c === 99) ||      // 192.88.99.0/24 6to4 relay
      (a === 198 && (b === 18 || b === 19)) ||    // 198.18.0.0/15  benchmarking
      (a === 198 && b === 51 && c === 100) ||     // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) ||      // 203.0.113.0/24 TEST-NET-3
      a >= 224                                    // 224.0.0.0/4 multicast, 240/4 reserved
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === '::' || lower === '::1') return false;
    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
    if (lower.startsWith('2001:db8:')) return false; // documentation range
    return true;
  }
  return false;
}

export async function politeDelay(url: string, minGapMs: number): Promise<void> {
  const host = hostOf(url);
  if (!host || minGapMs <= 0) return;
  const last = lastRequestByHost.get(host) ?? 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestByHost.set(host, Date.now());
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let lastError = 'unknown error';
  let lastStatus = 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      log.debug(`retry ${attempt} in ${backoff}ms`, url);
      await sleep(backoff);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const allowPrivate = /^(?:1|true)$/i.test(process.env.SIFT_ALLOW_PRIVATE_NETWORK ?? '');
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
        'accept-language': 'en,nl;q=0.8',
        ...opts.headers,
      };
      if (opts.etag) headers['if-none-match'] = opts.etag;
      if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

      let current = url;
      let res: Response | null = null;
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        await validateOutboundUrl(current, { allowPrivate });
        res = await fetch(current, { redirect: 'manual', signal: controller.signal, headers });
        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        const location = res.headers.get('location');
        if (!location) throw new Error(`redirect ${res.status} without Location header`);
        if (redirects === 5) throw new Error('too many redirects');
        await res.body?.cancel().catch(() => {});
        current = new URL(location, current).toString();
      }
      if (!res) throw new Error('request produced no response');
      lastStatus = res.status;

      if (res.status === 304) {
        return {
          ok: true,
          status: 304,
          notModified: true,
          body: '',
          finalUrl: current,
          etag: opts.etag ?? null,
          lastModified: opts.lastModified ?? null,
          contentType: res.headers.get('content-type'),
        };
      }

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        if (PERMANENT.has(res.status)) break;
        continue;
      }

      const body = await readLimited(res, opts.maxBytes ?? 5_000_000);
      return {
        ok: true,
        status: res.status,
        notModified: false,
        body,
        finalUrl: current,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        contentType: res.headers.get('content-type'),
      };
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // An aborted request is worth one retry; a DNS failure usually is not.
      if (/ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL/.test(lastError)) break;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    notModified: false,
    body: '',
    finalUrl: url,
    etag: null,
    lastModified: null,
    contentType: null,
    error: lastError,
  };
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Whether a failure is worth ever trying again. */
export function isPermanentFailure(status: number): boolean {
  return PERMANENT.has(status);
}
