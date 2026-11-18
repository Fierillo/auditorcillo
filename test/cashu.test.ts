import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertMintAddresses, assertMintUrl, mintAgent, type CallbackLookup } from '../src/url.ts';
import { announcedNuts, cappedFetch, NUTS_MAX } from '../src/cashu.ts';

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
    expect(() => assertMintUrl('https://100.128.0.1')).not.toThrow();
    expect(() => assertMintUrl('https://198.20.0.1')).not.toThrow();
    expect(() => assertMintUrl('https://[2606:4700:4700::1111]')).not.toThrow();
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
      'https://[::7f00:1]',
      'https://[64:ff9b::a9fe:a9fe]',
      'https://100.64.0.1',
      'https://100.127.255.254',
      'https://198.18.0.1',
      'https://198.19.255.1',
      'https://192.0.0.8',
      'https://[ff02::1]',
      'https://[::ffff:0:a9fe:a9fe]',
      'https://[::ffff:a9fe:a9fe]',
      'https://[2002:a9fe:a9fe::1]',
      'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
      'https://[64:ff9b:1::a9fe:a9fe]',
      'https://[fec0::1]',
      'https://[100::1]',
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

describe('assertMintAddresses', () => {
  const resolves = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('accepts a mint host whose every address is public', async () => {
    await expect(assertMintAddresses('https://mint.example.com/Bitcoin', {}, resolves('1.1.1.1', '2606:4700:4700::1111'))).resolves.toBeUndefined();
  });

  it('refuses a mint host that resolves to any private, reserved or loopback address', async () => {
    for (const [url, addresses] of [
      ['https://169.254.169.254.nip.io', ['169.254.169.254']],
      ['https://localtest.me', ['127.0.0.1']],
      ['https://mixed.example.com', ['1.1.1.1', '10.0.0.1']],
      ['https://mapped.example.com', ['::ffff:127.0.0.1']],
      ['https://cgnat.example.com', ['100.64.0.1']],
      ['https://empty.example.com', []],
    ] as const) {
      await expect(assertMintAddresses(url, {}, resolves(...addresses)), url).rejects.toThrow(/mint URL/);
    }
  });

  it('allows loopback addresses only with allowLocal and asks the resolver for every address', async () => {
    const lookup = vi.fn(resolves('127.0.0.1'));
    await expect(assertMintAddresses('http://localhost:3391', { allowLocal: true }, lookup)).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith('localhost', { all: true });
    await expect(assertMintAddresses('http://localhost:3391', { allowLocal: true }, resolves('10.0.0.1'))).rejects.toThrow(/mint URL/);
  });
});

describe('mintAgent (connect-time DNS check)', () => {
  /** A local HTTP server reached through a made-up name that `lookup` resolves to `address`. */
  async function serveVia(address: string) {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const lookup: CallbackLookup = (_host, _options, callback) => callback(null, [{ address, family: 4 }]);
    return { url: `http://rebind.test:${port}/v1/info`, lookup, close: () => server.close() };
  }

  it('refuses to connect when the name resolves to a private address at connect time', async () => {
    const s = await serveVia('127.0.0.1');
    try {
      const err = await fetch(s.url, { dispatcher: mintAgent({}, s.lookup) } as RequestInit).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.cause)).toMatch(/private or reserved address/);
    } finally {
      s.close();
    }
  });

  it('connects to loopback only with allowLocal', async () => {
    const s = await serveVia('127.0.0.1');
    try {
      const res = await fetch(s.url, { dispatcher: mintAgent({ allowLocal: true }, s.lookup) } as RequestInit);
      expect(await res.text()).toBe('ok');
    } finally {
      s.close();
    }
  });
});
