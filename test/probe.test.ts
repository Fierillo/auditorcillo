import { describe, expect, it, vi } from 'vitest';
import { score } from '../src/score.ts';
import { invoiceSats, mintIconUrl, mintWebsiteUrl, MINT_ERROR_MAX, MINT_TEXT_MAX, probeMint, type LightningWallet, type MintPort, type ProbeDeps } from '../src/probe.ts';

function fakeClock() {
  let t = 1_800_000_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
type Clock = ReturnType<typeof fakeClock>;

/** An honest mint that spends proofs once; `spent` is its ledger. */
function honestPort(clock: Clock, over: Partial<MintPort> = {}): MintPort {
  const spent = new Set<unknown>();
  let n = 0;
  const spend = (proofs: unknown[]) => {
    if (proofs.some((p) => spent.has(p))) throw new Error('Token already spent.');
    proofs.forEach((p) => spent.add(p));
  };
  return {
    info: async () => {
      clock.advance(100);
      return { name: 'Test', pubkey: `02${'ab'.repeat(32)}`, version: 'cdk/1', description: 'd', contact: [{ method: 'nostr', info: 'npub' }], nuts: [4, 5, 7, 12] };
    },
    keys: async () => {
      clock.advance(300);
      return [{ id: 'k1', valid: true }];
    },
    keysets: async () => {
      clock.advance(200);
      return [{ id: 'k1', active: true }];
    },
    createMintQuote: async (amount) => ({ quote: `q${amount}`, request: `lnbc${amount * 10}n` }),
    isMintQuotePaid: async () => true,
    createMeltQuote: async (invoice) => ({ amount: invoiceSats(invoice) ?? 0 }),
    unknownProofIsUnspent: async () => true,
    mint: async () => ({ proofs: [`p${n++}`], dleqValid: true }),
    swap: async (proofs) => {
      spend(proofs);
      return [`p${n++}`];
    },
    melt: async (_invoice, proofs) => {
      spend(proofs);
      return { paid: true, inputs: proofs };
    },
    allSpent: async (proofs) => proofs.every((p) => spent.has(p)),
    ...over,
  };
}

function deps(clock: Clock, port: MintPort | Error, wallet?: LightningWallet): ProbeDeps {
  return {
    port: () => {
      if (port instanceof Error) return { ...honestPort(clock), info: async () => Promise.reject(port) };
      return port;
    },
    now: clock.now,
    sleep: clock.sleep,
    amount: 8,
    payTimeoutMs: 5_000, mintTimeoutMs: 60_000,
    wallet,
  };
}

const okChecks = (r: { checks: Record<string, { ok: boolean }> }) =>
  Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.ok]));

describe('probeMint public reads', () => {
  it('reports an unreachable mint as offline with no checks run', async () => {
    const clock = fakeClock();
    const r = await probeMint({ url: 'https://down', cycle: true }, deps(clock, new Error('ECONNREFUSED')));
    expect(r).toMatchObject({ online: false, latencyMs: null, checks: {} });
    expect(r.error).toContain('ECONNREFUSED');
    expect(r.checkedAt).toBe(new Date(clock.now()).toISOString());
  });

  it('times the public reads, records info fields and runs only quote and keyset checks off-cycle', async () => {
    const clock = fakeClock();
    const port = honestPort(clock);
    const mint = vi.spyOn(port, 'mint');
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port));
    expect(r).toMatchObject({ online: true, latencyMs: 200, name: 'Test', version: 'cdk/1', nuts: [4, 5, 7, 12], error: null });
    expect(r.info).toEqual({ name: true, pubkey: true, version: true, description: true, contact: true });
    expect(okChecks(r)).toEqual({ keysetIds: true, keysetsListed: true, mintQuote: true, meltQuote: true, checkState: true });
    expect(r.checks.mintQuote.nut).toBe(4);
    expect(mint).not.toHaveBeenCalled();
  });

  it('flags keysets whose ids do not derive from their keys or that are listed without keys', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, {
      keys: async () => [{ id: 'k1', valid: false }],
      keysets: async () => [{ id: 'k1', active: true }, { id: 'k2', active: true }, { id: 'old', active: false }],
    });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port));
    expect(okChecks(r)).toMatchObject({ keysetIds: false, keysetsListed: false });
  });

  it('skips checks for NUTs the mint does not announce and marks empty info fields', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { info: async () => ({ name: 'x', contact: [], nuts: [4, 5] }) });
    const unknown = vi.spyOn(port, 'unknownProofIsUnspent');
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port));
    expect(r.checks.checkState).toBeUndefined();
    expect(unknown).not.toHaveBeenCalled();
    expect(r.info).toEqual({ name: true, pubkey: false, version: false, description: false, contact: false });
  });

  it('fails a single check with its error and keeps probing', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { createMeltQuote: async () => Promise.reject(new Error('melt disabled')) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port));
    expect(r.checks.meltQuote).toEqual({ nut: 5, ok: false, error: 'melt disabled' });
    expect(r.checks.checkState.ok).toBe(true);
  });
});

describe('probeMint full cycle', () => {
  it('mints, swaps, retries the spent token, melts and checks states on a FakeWallet mint', async () => {
    const clock = fakeClock();
    const port = honestPort(clock);
    const allSpent = vi.spyOn(port, 'allSpent');
    const r = await probeMint({ url: 'https://m', cycle: true }, deps(clock, port));
    expect(okChecks(r)).toMatchObject({ minted: true, dleq: true, swap: true, doubleSpendRejected: true, melted: true, spentState: true });
    expect(Object.values(r.checks).every((c) => c.ok)).toBe(true);
    expect(allSpent).toHaveBeenCalledWith(['p0', 'p1']);
  });

  it('catches a mint that accepts an already spent token', async () => {
    const clock = fakeClock();
    let n = 0;
    const port = honestPort(clock, { swap: async () => [`fresh${n++}`], allSpent: async () => false });
    const r = await probeMint({ url: 'https://m', cycle: true }, deps(clock, port));
    expect(okChecks(r)).toMatchObject({ swap: true, doubleSpendRejected: false, spentState: false });
  });

  it('fails minting and stops the cycle when the quote is never paid in time', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { isMintQuotePaid: async () => false });
    const swap = vi.spyOn(port, 'swap');
    const r = await probeMint({ url: 'https://m', cycle: true }, deps(clock, port));
    expect(r.checks.minted).toMatchObject({ ok: false, error: expect.stringMatching(/not paid/) });
    expect(swap).not.toHaveBeenCalled();
    expect(r.checks.melted).toBeUndefined();
  });

  it('runs the cycle on a real mint only with a wallet, paying the quote and melting to it', async () => {
    const clock = fakeClock();
    const wallet = { payInvoice: vi.fn(async () => {}), makeInvoice: vi.fn(async (sats: number) => `lnbc${sats * 10}n`) };
    const port = honestPort(clock);
    const melt = vi.spyOn(port, 'melt');

    const withoutWallet = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock)));
    expect(withoutWallet.checks.minted).toBeUndefined();

    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, wallet));
    expect(r.checks.melted.ok).toBe(true);
    expect(wallet.payInvoice).toHaveBeenCalledWith('lnbc80n', expect.any(AbortSignal));
    expect(wallet.makeInvoice).toHaveBeenCalledWith(4, expect.any(AbortSignal));
    expect(melt).toHaveBeenCalledWith('lnbc40n', expect.any(Array));
  });

  it('never pays FakeWallet invoices with a real wallet', async () => {
    const clock = fakeClock();
    const wallet = { payInvoice: vi.fn(async () => {}), makeInvoice: vi.fn(async () => 'lnbc') };
    await probeMint({ url: 'https://m', cycle: true }, deps(clock, honestPort(clock), wallet));
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(wallet.makeInvoice).not.toHaveBeenCalled();
  });

  it('does not pay a mint invoice whose amount is not the requested sats', async () => {
    const clock = fakeClock();
    const wallet = { payInvoice: vi.fn(async () => {}), makeInvoice: vi.fn(async () => 'lnbc40n') };
    const port = honestPort(clock, { createMintQuote: async () => ({ quote: 'q', request: 'lnbc100000n1xxxx' }) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, wallet));
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(r.checks.minted).toMatchObject({ ok: false, error: expect.stringMatching(/invoice/i) });
  });

  it('does not pay a mint invoice with no amount', async () => {
    const clock = fakeClock();
    const wallet = { payInvoice: vi.fn(async () => {}), makeInvoice: vi.fn(async () => 'lnbc40n') };
    const port = honestPort(clock, { createMintQuote: async () => ({ quote: 'q', request: 'lnbc1pvjluez' }) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, wallet));
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(r.checks.minted).toMatchObject({ ok: false, error: expect.stringMatching(/invoice/i) });
  });
});

describe('probeMint cycle broken by the mint', () => {
  it('marks the probe incomplete, so the double-spend check it never reached scores 0', async () => {
    const clock = fakeClock();
    for (const over of [
      { isMintQuotePaid: async () => false },
      { mint: async () => Promise.reject(new Error('quote not paid')) },
      { swap: async () => Promise.reject(new Error('swap down')) },
    ] satisfies Array<Partial<MintPort>>) {
      const r = await probeMint({ url: 'https://m', cycle: true }, deps(clock, honestPort(clock, over)));
      expect(r.checks.doubleSpendRejected, Object.keys(over)[0]).toBeUndefined();
      expect(r.incomplete, Object.keys(over)[0]).toBe(true);
      expect(score({ ...r, online: true }).alerts).toEqual(['doubleSpendRejected']);
    }
  });

  it('leaves a probe without a cycle complete', async () => {
    const clock = fakeClock();
    expect((await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock)))).incomplete).toBeUndefined();
  });
});

describe('probeMint when our own wallet fails', () => {
  const hang = () => new Promise<never>(() => {});
  const wallet = (over: Partial<LightningWallet> = {}): LightningWallet => ({
    payInvoice: async () => {},
    makeInvoice: async (sats) => `lnbc${sats * 10}n`,
    ...over,
  });

  it('leaves the check it broke unmeasured instead of failing the mint', async () => {
    const clock = fakeClock();
    for (const [name, w, limit] of [
      ['minted', wallet({ payInvoice: async () => Promise.reject(new Error('NWC pay_invoice: INSUFFICIENT_BALANCE')) }), 60_000],
      ['melted', wallet({ makeInvoice: async () => Promise.reject(new Error('NWC make_invoice: RATE_LIMITED')) }), 60_000],
      ['minted', wallet({ payInvoice: hang }), 20],
    ] as const) {
      const r = await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock), w), mintTimeoutMs: limit });
      expect(r.notMeasured, name).toBe(name);
      expect(r.checks[name], name).toBeUndefined();
      expect(r.incomplete, name).toBeUndefined();
      expect(r.error, name).toMatch(/our wallet/);
      expect(score({ ...r, online: true }).alerts, name).toEqual([]);
    }
  });

  it('blames the mint again for a later check after our wallet broke one', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { allSpent: async () => Promise.reject(new Error('checkstate down')) });
    const w = wallet({ makeInvoice: async () => Promise.reject(new Error('NWC make_invoice: RATE_LIMITED')) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, w));
    expect(r.notMeasured).toBe('melted');
    expect(r.checks.spentState).toMatchObject({ ok: false, error: 'checkstate down' });
  });

  it('still blames the mint for its own errors in the same check', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { mint: async () => Promise.reject(new Error('outputs already signed')) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, wallet()));
    expect(r.notMeasured).toBeUndefined();
    expect(r.checks.minted.ok).toBe(false);
    expect(r.incomplete).toBe(true);
  });
});

describe('probeMint time limit', () => {
  const hang = () => new Promise<never>(() => {});

  it('gives up on a mint that hangs in a check, fails that check and runs nothing after it', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { unknownProofIsUnspent: hang });
    const mint = vi.spyOn(port, 'mint');
    const r = await probeMint({ url: 'https://m', cycle: true }, { ...deps(clock, port), mintTimeoutMs: 20 });
    expect(r.incomplete).toBe(true);
    expect(r.checks.checkState).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/i) });
    expect(r.checks.minted).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
  });

  it('reports a mint that hangs in the public reads as offline and incomplete', async () => {
    const clock = fakeClock();
    const r = await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock, { keys: hang })), mintTimeoutMs: 20 });
    expect(r).toMatchObject({ online: false, incomplete: true, error: expect.stringMatching(/timeout/i) });
  });

  it('stops polling an unpaid quote once the mint time is up', async () => {
    const clock = fakeClock();
    let polls = 0;
    const port = honestPort(clock, { isMintQuotePaid: async () => (polls++, false) });
    const slow: ProbeDeps = { ...deps(clock, port), sleep: (ms) => new Promise((done) => setTimeout(done, ms / 100)), payTimeoutMs: 1e9, mintTimeoutMs: 50 };
    const r = await probeMint({ url: 'https://m', cycle: true }, slow);
    const seen = polls;
    await new Promise((done) => setTimeout(done, 50));
    expect(r.incomplete).toBe(true);
    expect(polls).toBe(seen);
  });

  it('leaves a probe that finished in time complete', async () => {
    const clock = fakeClock();
    expect((await probeMint({ url: 'https://m', cycle: true }, deps(clock, honestPort(clock)))).incomplete).toBeUndefined();
  });
});

describe('probeMint truncates mint-provided text', () => {
  it('clips a long name, version, top-level error and check error', async () => {
    const clock = fakeClock();
    expect(MINT_TEXT_MAX).toBe(200);
    expect(MINT_ERROR_MAX).toBe(500);
    const long = 'x'.repeat(250);
    const longErr = 'e'.repeat(550);
    const named = await probeMint(
      { url: 'https://m', cycle: false },
      deps(clock, honestPort(clock, { info: async () => ({ name: long, version: long, contact: [], nuts: [4, 5] }) })),
    );
    expect(named.name).toBe('x'.repeat(200));
    expect(named.version).toBe('x'.repeat(200));

    const down = await probeMint({ url: 'https://m', cycle: false }, deps(clock, new Error(longErr)));
    expect(down.error).toBe('e'.repeat(500));

    const failed = await probeMint(
      { url: 'https://m', cycle: false },
      deps(clock, honestPort(clock, { createMeltQuote: async () => Promise.reject(new Error(longErr)) })),
    );
    expect(failed.checks.meltQuote.error).toBe('e'.repeat(500));
    expect(failed.error?.length).toBeLessThanOrEqual(MINT_ERROR_MAX);
  });
});

describe('invoiceSats', () => {
  it('reads a BOLT11 amount as a whole number of sats', () => {
    expect(invoiceSats('lnbc80n')).toBe(8);
    expect(invoiceSats('lnbc80n1pvjluez')).toBe(8);
    expect(invoiceSats('LNBC80N1xxx')).toBe(8);
    expect(invoiceSats('lnbc100u')).toBe(10_000);
    expect(invoiceSats('lnbc1m')).toBe(100_000);
    expect(invoiceSats('lnbc80000p')).toBe(8);
    expect(invoiceSats('lnbc11qpz')).toBe(100_000_000);
  });

  it('returns null when the amount is missing, unparseable or not a whole number of sats', () => {
    expect(invoiceSats('lnbc1pvjluez')).toBeNull();
    expect(invoiceSats('lnbc')).toBeNull();
    expect(invoiceSats('not-an-invoice')).toBeNull();
    expect(invoiceSats('lnbc80x1')).toBeNull();
    expect(invoiceSats('lnbc1p')).toBeNull();
  });
});

describe('mintIconUrl', () => {
  it('accepts a public https URL within the mint text cap', () => {
    expect(mintIconUrl('https://cdn.example.com/icon.png')).toBe('https://cdn.example.com/icon.png');
    expect(mintIconUrl('https://mint.example.com/Bitcoin/icon.svg')).toBe('https://mint.example.com/Bitcoin/icon.svg');
    expect(mintIconUrl(`https://cdn.example.com/${'a'.repeat(200 - 'https://cdn.example.com/'.length)}`)).toMatch(/^https:\/\/cdn\.example\.com\/a+$/);
  });

  it('omits anything that is not a public https URL, or that exceeds the text cap', () => {
    const long = `https://cdn.example.com/${'a'.repeat(200)}`;
    expect(long.length).toBeGreaterThan(MINT_TEXT_MAX);
    expect(mintIconUrl(long)).toBeUndefined();
    expect(mintIconUrl('http://cdn.example.com/icon.png')).toBeUndefined();
    expect(mintIconUrl('https://127.0.0.1/icon.png')).toBeUndefined();
    expect(mintIconUrl('http://localhost/icon.png')).toBeUndefined();
    expect(mintIconUrl('https://10.0.0.1/icon.png')).toBeUndefined();
    expect(mintIconUrl('https://user:pass@cdn.example.com/icon.png')).toBeUndefined();
    expect(mintIconUrl('javascript:alert(1)')).toBeUndefined();
    expect(mintIconUrl('not a url')).toBeUndefined();
    expect(mintIconUrl(undefined)).toBeUndefined();
    expect(mintIconUrl(null)).toBeUndefined();
  });
});

describe('probeMint icon_url', () => {
  it('stores a safe NUT-06 icon_url and omits an unsafe one', async () => {
    const clock = fakeClock();
    const safe = 'https://cdn.example.com/mint.png';
    const ok = await probeMint(
      { url: 'https://m', cycle: false },
      deps(clock, honestPort(clock, { info: async () => ({ name: 'Test', contact: [], nuts: [4, 5], icon_url: safe }) })),
    );
    expect(ok.iconUrl).toBe(safe);

    const bad = await probeMint(
      { url: 'https://m', cycle: false },
      deps(clock, honestPort(clock, { info: async () => ({ name: 'Test', contact: [], nuts: [4, 5], icon_url: 'http://cdn.example.com/mint.png' }) })),
    );
    expect(bad.iconUrl).toBeUndefined();

    const missing = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock)));
    expect(missing.iconUrl).toBeUndefined();
  });
});

describe('mintWebsiteUrl', () => {
  it('prefers a safe NUT-06 website, then the first safe urls entry, then the mint origin', () => {
    expect(mintWebsiteUrl({ website: 'https://wallet.example.com' }, 'https://mint.example.com/Bitcoin')).toBe(
      'https://wallet.example.com',
    );
    expect(mintWebsiteUrl({ urls: ['http://abc.onion', 'https://front.example.com'] }, 'https://mint.example.com/Bitcoin')).toBe(
      'https://front.example.com',
    );
    expect(mintWebsiteUrl({}, 'https://mint.example.com/Bitcoin')).toBe('https://mint.example.com');
  });

  it('omits unsafe website or url values and falls through, and omits when nothing is a public https URL', () => {
    expect(
      mintWebsiteUrl({ website: 'http://wallet.example.com', urls: ['https://app.example.com'] }, 'https://mint.example.com'),
    ).toBe('https://app.example.com');
    expect(mintWebsiteUrl({ website: 'javascript:alert(1)', urls: ['https://user:pass@x.example'] }, 'https://mint.example.com')).toBe(
      'https://mint.example.com',
    );
    expect(mintWebsiteUrl({ website: 'https://127.0.0.1', urls: ['http://front.example.com'] }, 'not-a-url')).toBeUndefined();
    expect(mintWebsiteUrl({}, '')).toBeUndefined();
  });
});

describe('probeMint website', () => {
  it('stores a safe website from NUT-06 and falls back to the mint origin', async () => {
    const clock = fakeClock();
    const site = 'https://wallet.example.com';
    const fromSite = await probeMint(
      { url: 'https://mint.example.com/Bitcoin', cycle: false },
      deps(clock, honestPort(clock, { info: async () => ({ name: 'Test', contact: [], nuts: [4, 5], website: site }) })),
    );
    expect(fromSite.websiteUrl).toBe(site);

    const fromUrls = await probeMint(
      { url: 'https://mint.example.com/Bitcoin', cycle: false },
      deps(
        clock,
        honestPort(clock, {
          info: async () => ({ name: 'Test', contact: [], nuts: [4, 5], urls: ['http://abc.onion', 'https://front.example.com'] }),
        }),
      ),
    );
    expect(fromUrls.websiteUrl).toBe('https://front.example.com');

    const fallback = await probeMint({ url: 'https://mint.example.com/Bitcoin', cycle: false }, deps(clock, honestPort(clock)));
    expect(fallback.websiteUrl).toBe('https://mint.example.com');

    const down = await probeMint({ url: 'https://mint.example.com/Bitcoin', cycle: false }, deps(clock, new Error('ECONNREFUSED')));
    expect(down.online).toBe(false);
    expect(down.websiteUrl).toBe('https://mint.example.com');
  });
});

describe('probeMint with malformed /v1/info', () => {
  it('keeps name and version only when they are strings and contacts only when they are well-formed', async () => {
    const clock = fakeClock();
    for (const info of [
      { name: 5, version: {}, contact: 'x', nuts: [4, 5] },
      { name: ['n'], version: 1, contact: [null, 3, 'npub', { info: 7 }], nuts: [4, 5] },
      { nuts: [4, 5] },
    ]) {
      const port = honestPort(clock, { info: async () => info as never });
      const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port));
      expect(r, JSON.stringify(info)).toMatchObject({ online: true, name: null, version: null, error: null });
      expect(r.info.contact).toBe(false);
    }
    const mixed = honestPort(clock, { info: async () => ({ name: 'ok', contact: [null, { method: 'nostr', info: 'npub' }], nuts: [4, 5] }) as never });
    expect((await probeMint({ url: 'https://m', cycle: false }, deps(clock, mixed))).info.contact).toBe(true);
  });

  it('gives info points only for non-empty text and a compressed secp256k1 pubkey', async () => {
    const clock = fakeClock();
    const none = { name: false, pubkey: false, version: false, description: false, contact: false };
    for (const info of [
      { name: '', pubkey: '', version: '', description: '', nuts: [] },
      { name: '   ', pubkey: '02ab', version: ' ', description: '\n', nuts: [] },
      { name: 1, pubkey: true, version: [], description: {}, nuts: [] },
      { name: 'x', pubkey: `04${'ab'.repeat(32)}`, version: 'v', description: 'd', nuts: [] },
      { name: 'x', pubkey: `02${'zz'.repeat(32)}`, version: 'v', description: 'd', nuts: [] },
    ]) {
      const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock, { info: async () => info as never })));
      const expected = typeof info.name === 'string' && info.name.trim() ? { ...none, name: true, version: true, description: true } : none;
      expect(r.info, JSON.stringify(info)).toEqual(expected);
    }
  });

  it('reports a mint whose port cannot even be built as failed instead of throwing', async () => {
    const clock = fakeClock();
    const broken: ProbeDeps = { ...deps(clock, honestPort(clock)), port: () => { throw new Error('invalid mint URL: x'); } };
    const r = await probeMint({ url: 'x', cycle: false }, broken);
    expect(r).toMatchObject({ url: 'x', online: false, error: 'invalid mint URL: x' });
  });
});
