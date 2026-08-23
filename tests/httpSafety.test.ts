import { describe, expect, it } from 'vitest';
import { isPublicAddress, validateOutboundUrl } from '../src/util/http.js';

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
