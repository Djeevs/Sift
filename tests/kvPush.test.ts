import { describe, expect, it } from 'vitest';
import { selectChangedEntries } from '../src/cloudflare/kv.js';

const feed = (value: string) => ({ key: 'feed:essential', value });

/**
 * Cloudflare's free tier allows 1,000 KV writes a day. Push wrote all 105 keys
 * every run regardless of whether anything had changed — byte for byte
 * identical when nothing new had published — so eight ordinary pushes a day
 * came to 840 writes and triggered Cloudflare's daily-limit warning on data
 * that had not changed.
 */
describe('KV push selects only what changed', () => {
  it('uploads everything the first time', () => {
    const result = selectChangedEntries([feed('a'), { key: 'meta:index', value: 'b' }], {});
    expect(result.changed).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it('uploads nothing when every value is byte-identical', () => {
    const entries = [feed('same'), { key: 'meta:index', value: 'also same' }];
    const first = selectChangedEntries(entries, {});
    const second = selectChangedEntries(entries, first.hashes);
    expect(second.changed).toHaveLength(0);
    expect(second.skipped).toBe(2);
  });

  it('uploads only the feed whose content actually moved', () => {
    const before = selectChangedEntries([feed('v1'), { key: 'feed:games', value: 'unchanged' }], {});
    const after = selectChangedEntries([feed('v2'), { key: 'feed:games', value: 'unchanged' }], before.hashes);
    expect(after.changed.map((e) => e.key)).toEqual(['feed:essential']);
    expect(after.skipped).toBe(1);
  });

  it('uploads a key that is new even when the others are unchanged', () => {
    const before = selectChangedEntries([feed('a')], {});
    const after = selectChangedEntries([feed('a'), { key: 'item:xyz', value: 'https://example.com' }], before.hashes);
    expect(after.changed.map((e) => e.key)).toEqual(['item:xyz']);
  });

  // Losing the record must cost a redundant upload, never a missed one.
  it('re-uploads everything when the recorded hashes are lost', () => {
    const entries = [feed('a'), { key: 'meta:index', value: 'b' }];
    expect(selectChangedEntries(entries, {}).changed).toHaveLength(2);
  });
});
