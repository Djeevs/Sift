import { describe, expect, it } from 'vitest';
import { isPublicAddress, validateOutboundUrl } from '../src/util/http.js';

describe('reserved ranges are matched at their real prefix length', () => {
  /**
   * Three ranges were written as /16 where IANA reserves only a /24, and it
   * cost half the source list: 192.0.66/78/79.x is Automattic, so every
   * WordPress.com-hosted source — longreads, acoup.blog, nautil.us, stereogum —
   * failed with "blocked non-public address" and quietly stopped producing
   * items. 21 of 45 enabled sources had published nothing for 48 hours.
   */
  it('allows the public addresses that were wrongly blocked', () => {
    for (const [ip, who] of [
      ['192.0.66.223', 'stereogum, nautil.us'],
      ['192.0.78.209', 'acoup.blog'],
      ['192.0.79.32', 'longreads.com'],
      ['198.51.45.1', 'ordinary public space in 198.51/16'],
      ['203.0.55.1', 'ordinary public space in 203.0/16'],
    ] as const) {
      expect(isPublicAddress(ip), `${ip} (${who}) must be reachable`).toBe(true);
    }
  });

  it('still blocks the /24s that are genuinely reserved', () => {
    for (const ip of ['192.0.0.8', '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1']) {
      expect(isPublicAddress(ip), `${ip} must stay blocked`).toBe(false);
    }
  });

  it('still blocks every private and loopback range', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(isPublicAddress(ip), `${ip} must stay blocked`).toBe(false);
    }
  });
});

describe('outbound URL safety', () => {
  it('accepts globally routable addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('accepts a public IPv6 URL literal without attempting DNS', async () => {
    const url = await validateOutboundUrl('https://[2606:4700:4700::1111]/feed.xml', {
      resolveAddresses: async () => { throw new Error('DNS should not run for a literal'); },
    });
    expect(url.protocol).toBe('https:');
  });

  it.each([
    '127.0.0.1', '10.0.0.1', '172.20.1.2', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
  ])('blocks non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('validates DNS results rather than trusting a public-looking hostname', async () => {
    await expect(validateOutboundUrl('https://attacker.example/article', {
      resolveAddresses: async () => ['169.254.169.254'],
    })).rejects.toThrow(/non-public address/);
  });

  it('rejects credentials and non-http schemes', async () => {
    await expect(validateOutboundUrl('file:///etc/passwd')).rejects.toThrow(/protocol/);
    await expect(validateOutboundUrl('https://user:secret@example.com')).rejects.toThrow(/credentials/);
  });

  it('allows a private address only through the explicit local-use switch', async () => {
    await expect(validateOutboundUrl('http://127.0.0.1:8787/feed.xml', { allowPrivate: true }))
      .resolves.toHaveProperty('hostname', '127.0.0.1');
  });
});
