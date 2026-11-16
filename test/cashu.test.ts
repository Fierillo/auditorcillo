import { describe, expect, it } from 'vitest';
import { announcedNuts, assertMintUrl, cappedFetch, NUTS_MAX } from '../src/cashu.ts';

describe('announcedNuts', () => {
  it('lists supported NUTs and the enabled mint/melt methods, ignoring disabled or unsupported ones', () => {
    expect(
      announcedNuts({
        '4': { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: false },
        '5': { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: true },
        '7': { supported: true },
        '8': { supported: false },
        '17': { supported: [{ method: 'bolt11', unit: 'sat', commands: [] }] },
        '15': {},
        junk: { supported: true },
      }),
    ).toEqual([4, 7, 17]);
  });
});

describe('announcedNuts bounds', () => {
  it('keeps only distinct NUT numbers 0..999, at most NUTS_MAX of them', () => {
    const flood = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [String(i), { supported: true }]));
    const nuts = announcedNuts(flood);
    expect(nuts.length).toBe(NUTS_MAX);
    expect(nuts.every((n) => Number.isInteger(n) && n >= 0 && n <= 999)).toBe(true);
    expect(announcedNuts({ '7': { supported: true }, '007': { supported: true }, '1000': { supported: true }, '99999999999999999999': { supported: true } })).toEqual([7]);
  });

  it('ignores a nuts value that is not an object and entries that are null', () => {
    for (const raw of [undefined, null, 'x', 5, [1, 2]]) expect(announcedNuts(raw), String(raw)).toEqual([]);
    expect(announcedNuts({ '4': null, '7': { supported: true } })).toEqual([7]);
  });
});

describe('assertMintUrl', () => {
  it('accepts https public DNS names and public IP literals', () => {
    expect(() => assertMintUrl('https://mint.example.com/Bitcoin')).not.toThrow();
    expect(() => assertMintUrl('https://21mint.me')).not.toThrow();
    expect(() => assertMintUrl('https://1.1.1.1')).not.toThrow();
  });

  it('rejects non-https schemes, credentials and private or reserved addresses', () => {
    for (const url of [
      'http://mint.example.com',
      'file:///etc/passwd',
      'ftp://mint.example.com',
      'https://user:pass@mint.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'http://127.0.0.1:3391',
      'https://10.0.0.1',
      'https://192.168.1.8',
      'https://172.16.0.1',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/',
      'https://[fd00::1]/',
      'https://[fe80::1]/',
      'https://[::ffff:169.254.169.254]/',
      'not-a-url',
    ]) {
      expect(() => assertMintUrl(url), url).toThrow(/mint URL/i);
    }
  });

  it('allows loopback only with explicit allowLocal', () => {
    expect(() => assertMintUrl('http://127.0.0.1:3391', { allowLocal: true })).not.toThrow();
    expect(() => assertMintUrl('http://localhost:3391', { allowLocal: true })).not.toThrow();
    expect(() => assertMintUrl('http://[::1]:3391', { allowLocal: true })).not.toThrow();
    expect(() => assertMintUrl('https://127.0.0.1', { allowLocal: true })).not.toThrow();
    expect(() => assertMintUrl('http://mint.example.com', { allowLocal: true })).toThrow(/mint URL/i);
    expect(() => assertMintUrl('http://10.0.0.1', { allowLocal: true })).toThrow(/mint URL/i);
  });
});

describe('cappedFetch', () => {
  const serve = (bytes: number) => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (pulled >= bytes) return ctl.close();
        const chunk = new Uint8Array(Math.min(64 * 1024, bytes - pulled)).fill(32);
        pulled += chunk.byteLength;
        ctl.enqueue(chunk);
      },
    });
    const inner = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    return { inner: inner as unknown as typeof fetch, pulled: () => pulled };
  };

  it('passes a response within the cap through unchanged', async () => {
    const res = await cappedFetch(serve(1000).inner, 1000)('https://mint.example.com/v1/info');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect((await res.text()).length).toBe(1000);
  });

  it('fails reading a body past the cap and stops downloading it', async () => {
    const big = serve(50_000_000);
    const res = await cappedFetch(big.inner, 1_000_000)('https://mint.example.com/v1/info');
    await expect(res.text()).rejects.toThrow(/exceeds 1000000 bytes/);
    expect(big.pulled()).toBeLessThan(2_000_000);
  });
});
