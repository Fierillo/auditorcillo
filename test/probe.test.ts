import { describe, expect, it, vi } from 'vitest';
import { score } from '../src/score.ts';
import { declaredInputFeePpk, invoiceSats, mintIconUrl, mintWebsiteUrl, MINT_ERROR_MAX, MINT_TEXT_MAX, probeMint, NotPaid, type LightningWallet, type MintPort, type ProbeDeps } from '../src/probe.ts';

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

const hang = () => new Promise<never>(() => {});
const paying = (over: Partial<LightningWallet> = {}) => ({
  payInvoice: vi.fn(over.payInvoice ?? (async () => {})),
  makeInvoice: vi.fn(over.makeInvoice ?? (async (sats: number) => `lnbc${sats * 10}n`)),
});

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
      ['minted', wallet({ payInvoice: (_invoice, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('NWC')))) }), 20],
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

describe('probeMint scam detection', () => {
  it('flags a mint that charged us and never issued the ecash', async () => {
    const clock = fakeClock();
    for (const over of [
      { mint: async () => Promise.reject(new Error('quote already issued')) },
      { mint: async () => ({ proofs: [], dleqValid: true }) },
    ] satisfies Array<Partial<MintPort>>) {
      const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock, over), paying()));
      expect(r.scam, JSON.stringify(Object.keys(over))).toBe(true);
      expect(r.pending, JSON.stringify(Object.keys(over))).toBe(true);
    }
  });

  it('flags a mint that spent our ecash without paying us', async () => {
    const clock = fakeClock();
    const taken = new Set<unknown>();
    const steal = (proofs: unknown[]) => proofs.forEach((p) => taken.add(p));
    const spent = { allSpent: async (proofs: unknown[]) => proofs.every((p) => taken.has(p)) };
    for (const [label, melt] of [
      ['melt unpaid after taking inputs', async (_i: string, proofs: unknown[]) => (steal(proofs), { paid: false, inputs: proofs })],
      ['melt throws after taking inputs', async (_i: string, proofs: unknown[]) => { steal(proofs); throw new Error('melt failed'); }],
    ] as const) {
      taken.clear();
      const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock, { melt, ...spent }), paying()));
      expect(r.scam, label).toBe(true);
    }
  });

  it('does not flag a swap or melt failure when our proofs were not spent', async () => {
    const clock = fakeClock();
    for (const over of [
      { swap: async () => Promise.reject(new Error('swap down')) },
      { melt: async () => ({ paid: false, inputs: [] }) },
      { melt: async () => Promise.reject(new Error('melt failed')) },
    ] satisfies Array<Partial<MintPort>>) {
      const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock, over), paying()));
      expect(r.scam, JSON.stringify(Object.keys(over))).toBeUndefined();
    }
  });

  it('never flags without proof the mint holds our sats', async () => {
    const clock = fakeClock();
    const cases: Array<[string, ProbeDeps, boolean]> = [
      ['honest', deps(clock, honestPort(clock), paying()), false],
      ['our wallet failed to pay', deps(clock, honestPort(clock), { ...paying(), payInvoice: async () => Promise.reject(new Error('NWC')) }), false],
      ['insufficient balance', deps(clock, honestPort(clock), { ...paying(), payInvoice: async () => Promise.reject(new Error('NWC pay_invoice: INSUFFICIENT_BALANCE no funds')) }), false],
      ['rate limited', deps(clock, honestPort(clock), { ...paying(), payInvoice: async () => Promise.reject(new Error('NWC pay_invoice: RATE_LIMITED slow down')) }), false],
      ['payment failed', deps(clock, honestPort(clock), { ...paying(), payInvoice: async () => Promise.reject(new Error('NWC pay_invoice: PAYMENT_FAILED dest')) }), false],
      ['our wallet failed to invoice', deps(clock, honestPort(clock, { melt: async () => ({ paid: false, inputs: [] }) }), { ...paying(), makeInvoice: async () => Promise.reject(new Error('NWC')) }), false],
      ['quote never reported paid', deps(clock, honestPort(clock, { isMintQuotePaid: async () => false }), paying()), false],
      ['time limit', { ...deps(clock, honestPort(clock, { swap: hang }), paying()), mintTimeoutMs: 20 }, false],
      ['FakeWallet mint', deps(clock, honestPort(clock, { mint: async () => Promise.reject(new Error('x')) })), true],
    ];
    for (const [label, d, fake] of cases) {
      const r = await probeMint({ url: 'https://m', cycle: fake }, d);
      expect(r.scam, label).toBeUndefined();
    }
  });

  it('probes a flagged mint with read-only checks and never with money', async () => {
    const clock = fakeClock();
    const port = honestPort(clock);
    const mint = vi.spyOn(port, 'mint');
    const wallet = paying();
    for (const cycle of [true, false]) {
      const r = await probeMint({ url: 'https://m', cycle, scam: true }, deps(clock, port, wallet));
      expect(r).toMatchObject({ online: true, scam: true });
      expect(Object.keys(r.checks).sort()).toEqual(['checkState', 'keysetIds', 'keysetsListed', 'meltQuote', 'mintQuote']);
      expect(r.incomplete).toBeUndefined();
    }
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('probeMint pending payment', () => {
  it('holds a mint we paid when it never issues the ecash, so we do not pay it again', async () => {
    const clock = fakeClock();
    for (const [label, over, limit] of [
      ['never confirms the quote', { isMintQuotePaid: async () => false } as Partial<MintPort>, 60_000],
      ['times out waiting for the quote', { isMintQuotePaid: hang } as Partial<MintPort>, 20],
      ['times out before issuing', { mint: hang } as Partial<MintPort>, 20],
    ] as const) {
      const r = await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock, over), paying()), mintTimeoutMs: limit });
      expect(r.pending, label).toBe(true);
      expect(r.scam, label).toBeUndefined();
    }
  });

  it('keeps the mint pending whenever payInvoice fails without proving nothing was paid, however late it fails', async () => {
    const clock = fakeClock();
    const fail = (message: string) => async () => Promise.reject(new Error(message));
    const lateReject = (ms: number): LightningWallet['payInvoice'] => (_invoice, signal) =>
      new Promise<void>((_, reject) => signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('NWC pay_invoice: no answer')), ms)));
    const honest = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock), paying()));
    const ceiling = score({ ...honest, online: true }).total;
    for (const [label, payInvoice, limit] of [
      ['rejects 20 ms after the time limit', lateReject(20), 20],
      ['never answers until aborted', lateReject(0), 20],
      ['fails with PAYMENT_FAILED', fail('NWC pay_invoice: PAYMENT_FAILED no route'), 60_000],
      ['gives up silently before the time limit', fail('NWC pay_invoice: no answer in 20 ms'), 60_000],
    ] as const) {
      const w = paying({ payInvoice });
      const d = { ...deps(clock, honestPort(clock), w), mintTimeoutMs: limit };
      const r = await probeMint({ url: 'https://m', cycle: false }, d);
      expect(r, label).toMatchObject({ pending: true, notMeasured: 'minted', unrun: [4, 12, 3, 3, 5, 7] });
      expect(r.scam, label).toBeUndefined();
      expect(r.incomplete, label).toBeUndefined();
      expect(score({ ...r, online: true }).alerts, label).toEqual([]);
      expect(score({ ...r, online: true }).total, label).toBeLessThan(ceiling);
      await new Promise((done) => setTimeout(done, 40));
      await probeMint({ url: 'https://m', cycle: false, pending: r.pending }, d);
      expect(w.payInvoice, label).toHaveBeenCalledTimes(1);
    }
  });

  it('clears the mark when the wallet proves nothing was paid, even 20 ms after the time limit, and lists no unrun', async () => {
    const clock = fakeClock();
    const w = paying({
      payInvoice: (_invoice, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => setTimeout(() => reject(new NotPaid('NWC pay_invoice: RATE_LIMITED')), 20));
        }),
    });
    const r = await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock), w), mintTimeoutMs: 20 });
    expect(r.pending).toBeUndefined();
    expect(r.unrun).toBeUndefined();
    expect(r.notMeasured).toBe('minted');
    expect(r.scam).toBeUndefined();
    expect(score({ ...r, online: true }).alerts).toEqual([]);
  });

  it('clears the mark only when the wallet proves nothing was paid, and then does not blame the mint', async () => {
    const clock = fakeClock();
    const w = paying({ payInvoice: async () => Promise.reject(new NotPaid('NWC pay_invoice: INSUFFICIENT_BALANCE no funds')) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock), w));
    expect(r.notMeasured).toBe('minted');
    expect(r.pending).toBeUndefined();
    expect(r.scam).toBeUndefined();
    expect(r.unrun).toBeUndefined();
    expect(score({ ...r, online: true }).alerts).toEqual([]);
  });

  it('does not hold a mint we never paid or that issued the ecash', async () => {
    const clock = fakeClock();
    const cases: Array<[string, ProbeDeps, boolean]> = [
      ['honest', deps(clock, honestPort(clock), paying()), false],
      ['our wallet refused to pay', deps(clock, honestPort(clock), { ...paying(), payInvoice: async () => Promise.reject(new NotPaid('NWC')) }), false],
      ['quote never reported paid without a wallet', deps(clock, honestPort(clock, { isMintQuotePaid: async () => false })), true],
    ];
    for (const [label, d, fake] of cases) {
      const r = await probeMint({ url: 'https://m', cycle: fake }, d);
      expect(r.pending, label).toBeUndefined();
    }
  });

  it('probes a pending mint with read-only checks and never with money', async () => {
    const clock = fakeClock();
    const port = honestPort(clock);
    const mint = vi.spyOn(port, 'mint');
    const wallet = paying();
    const r = await probeMint({ url: 'https://m', cycle: false, pending: true }, deps(clock, port, wallet));
    expect(r).toMatchObject({ online: true, pending: true });
    expect(r.scam).toBeUndefined();
    expect(Object.keys(r.checks).sort()).toEqual(['checkState', 'keysetIds', 'keysetsListed', 'meltQuote', 'mintQuote']);
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('probeMint paid cycle that does not finish', () => {
  const fail = (message: string) => () => Promise.reject(new Error(message));
  const unfinished: Array<[string, Partial<MintPort>, Partial<LightningWallet>, number]> = [
    ['swap fails', { swap: fail('swap down') }, {}, 60_000],
    ['swap issues nothing', { swap: async () => [] }, {}, 60_000],
    ['swap hangs', { swap: hang }, {}, 20],
    ['melt fails', { melt: fail('melt down') }, {}, 60_000],
    ['melt unpaid', { melt: async () => ({ paid: false, inputs: [] }) }, {}, 60_000],
    ['melt hangs', { melt: hang }, {}, 20],
    ['our wallet cannot invoice the melt', {}, { makeInvoice: fail('NWC') }, 60_000],
    ['mint issues nothing', { mint: async () => ({ proofs: [], dleqValid: true }) }, {}, 60_000],
    ['mint never confirms the quote', { isMintQuotePaid: async () => false }, {}, 60_000],
    ['payment confirmed without a preimage', { mint: fail('quote already issued') }, { payInvoice: async () => {} }, 60_000],
  ];

  it('holds the mint after every paid cycle that does not end in the melt, so no later run pays it again, and never scores it above an honest mint', async () => {
    const clock = fakeClock();
    const honest = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock), paying()));
    expect(honest.pending).toBeUndefined();
    const ceiling = score({ ...honest, online: true }).total;
    for (const [label, over, walletOver, limit] of unfinished) {
      const w = paying(walletOver);
      const d = { ...deps(clock, honestPort(clock, over), w), mintTimeoutMs: limit };
      const first = await probeMint({ url: 'https://m', cycle: false }, d);
      expect(first.pending, label).toBe(true);
      expect(score({ ...first, online: true }).total, label).toBeLessThan(ceiling);
      await probeMint({ url: 'https://m', cycle: false, scam: first.scam, pending: first.pending }, d);
      expect(w.payInvoice, label).toHaveBeenCalledTimes(1);
    }
  });

  it('flags a mint that failed the swap after spending the ecash we paid for, not one that left it unspent', async () => {
    const clock = fakeClock();
    for (const [label, issued] of [['swap throws', async () => Promise.reject(new Error('swap down'))], ['swap issues nothing', async () => []]] as const) {
      const taken = new Set<unknown>();
      const port = honestPort(clock, { swap: async (proofs) => (proofs.forEach((p) => taken.add(p)), issued()), allSpent: async (proofs) => proofs.every((p) => taken.has(p)) });
      const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, paying()));
      expect(r, label).toMatchObject({ scam: true, pending: true });
    }
  });

  it('counts a payment our wallet confirmed without a preimage as paid', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { mint: async () => ({ proofs: [], dleqValid: true }) });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port, paying({ payInvoice: async () => {} })));
    expect(r).toMatchObject({ scam: true, pending: true });
  });
});

describe('probeMint cycle that never reached the payment', () => {
  const twice = (second: () => Promise<{ quote: string; request: string }>) => {
    let calls = 0;
    return async (amount: number) => (calls++ === 0 ? { quote: 'q', request: `lnbc${amount * 10}n` } : second());
  };
  const cases: Array<[string, () => Promise<{ quote: string; request: string }>, number, boolean]> = [
    ['wrong invoice amount', async () => ({ quote: 'q', request: 'lnbc100000n1xxxx' }), 60_000, true],
    ['invoice without amount', async () => ({ quote: 'q', request: 'lnbc1pvjluez' }), 60_000, true],
    ['mint refuses the second quote', () => Promise.reject(new Error('quote refused')), 60_000, false],
    ['mint hangs on the second quote', hang, 20, false],
  ];

  it('never raises a fraud alert, pays nothing and holds nothing', async () => {
    const clock = fakeClock();
    for (const [label, second, limit, anyMint] of cases) {
      for (const [mintKind, cycle, w] of [['wallet mint', false, paying()], ['FakeWallet mint', true, undefined]] as const) {
        if (!w && anyMint) continue;
        const port = honestPort(clock, { createMintQuote: twice(second) });
        const r = await probeMint({ url: 'https://m', cycle }, { ...deps(clock, port, w), mintTimeoutMs: limit });
        const name = `${label}, ${mintKind}`;
        expect(r.incomplete, name).toBeUndefined();
        expect(r.pending, name).toBeUndefined();
        expect(r.scam, name).toBeUndefined();
        expect(score({ ...r, online: true }).alerts, name).toEqual([]);
        if (w) expect(w.payInvoice, name).not.toHaveBeenCalled();
        expect(r.timedOut, name).toBe(limit === 20 ? true : undefined);
      }
    }
  });
});

describe('probeMint checks a cycle never reached', () => {
  it('lists them for a cycle the mint broke, timed out or not, but not for one our own wallet refused', async () => {
    const clock = fakeClock();
    const swapDown = { swap: async () => Promise.reject(new Error('swap down')) };
    const fake = await probeMint({ url: 'https://m', cycle: true }, deps(clock, honestPort(clock, swapDown)));
    expect(fake).toMatchObject({ unrun: [3, 5, 7] });
    expect(fake.timedOut).toBeUndefined();
    const real = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock, swapDown), paying()));
    expect(real).toMatchObject({ unrun: [3, 5, 7] });
    expect(real.timedOut).toBeUndefined();
  });
});

describe('probeMint checks a timed-out probe never reached', () => {
  it('lists the NUTs of the checks it planned but never ran, cycle included', async () => {
    const clock = fakeClock();
    const cycle = await probeMint({ url: 'https://m', cycle: true }, { ...deps(clock, honestPort(clock, { unknownProofIsUnspent: hang })), mintTimeoutMs: 20 });
    expect(cycle.unrun).toEqual([4, 12, 3, 3, 5, 7]);
    const reads = await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock, { createMintQuote: hang })), mintTimeoutMs: 20 });
    expect(reads.unrun).toEqual([5, 7]);
  });

  it('lists nothing for a probe that finished, one that was never online, or a cycle it was not going to run', async () => {
    const clock = fakeClock();
    expect((await probeMint({ url: 'https://m', cycle: true }, deps(clock, honestPort(clock)))).unrun).toBeUndefined();
    expect((await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock, { keys: hang })), mintTimeoutMs: 20 })).unrun).toBeUndefined();
    expect((await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock, { unknownProofIsUnspent: hang })), mintTimeoutMs: 20 })).unrun).toBeUndefined();
    expect((await probeMint({ url: 'https://m', cycle: true, pending: true }, { ...deps(clock, honestPort(clock, { unknownProofIsUnspent: hang })), mintTimeoutMs: 20 })).unrun).toBeUndefined();
  });
});

describe('probeMint time limit', () => {
  it('gives up on a mint that hangs in a check, fails that check and runs nothing after it', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { unknownProofIsUnspent: hang });
    const mint = vi.spyOn(port, 'mint');
    const r = await probeMint({ url: 'https://m', cycle: true }, { ...deps(clock, port), mintTimeoutMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(r.incomplete).toBeUndefined();
    expect(r.checks.checkState).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/i) });
    expect(r.checks.minted).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
    expect(score({ ...r, online: true }).alerts).toEqual([]);
  });

  it('reports a mint that hangs in the public reads as offline and timed out, not as fraud', async () => {
    const clock = fakeClock();
    const r = await probeMint({ url: 'https://m', cycle: false }, { ...deps(clock, honestPort(clock, { keys: hang })), mintTimeoutMs: 20 });
    expect(r).toMatchObject({ online: false, timedOut: true, error: expect.stringMatching(/timeout/i) });
    expect(r.incomplete).toBeUndefined();
    expect(score(r).alerts).toEqual([]);
  });

  it('still treats a timeout after the payment cycle started as incomplete', async () => {
    const clock = fakeClock();
    const r = await probeMint({ url: 'https://m', cycle: true }, { ...deps(clock, honestPort(clock, { swap: hang })), mintTimeoutMs: 20 });
    expect(r).toMatchObject({ timedOut: true, incomplete: true });
    expect(score({ ...r, online: true }).alerts).toEqual(['doubleSpendRejected']);
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

describe('declaredInputFeePpk', () => {
  it('reads the highest NUT-02 input fee among active keysets, ignoring inactive ones', () => {
    expect(declaredInputFeePpk([{ id: 'a', active: true, input_fee_ppk: 100 }, { id: 'b', active: true, input_fee_ppk: 0 }, { id: 'old', active: false, input_fee_ppk: 900 }])).toBe(100);
    expect(declaredInputFeePpk([{ id: 'a', active: true, input_fee_ppk: 0 }])).toBe(0);
  });

  it('reads an active keyset that omits the fee, or sends null, as declaring 0, as NUT-02 does', () => {
    expect(declaredInputFeePpk([{ id: 'a', active: true }])).toBe(0);
    expect(declaredInputFeePpk([{ id: 'a', active: true, input_fee_ppk: null }])).toBe(0);
    expect(declaredInputFeePpk([{ id: 'a', active: true }, { id: 'b', active: true, input_fee_ppk: 100 }])).toBe(100);
  });

  it('is undefined when there is no active keyset with a valid fee to read, so nothing is made up', () => {
    expect(declaredInputFeePpk([])).toBeUndefined();
    expect(declaredInputFeePpk([{ id: 'old', active: false, input_fee_ppk: 100 }])).toBeUndefined();
    for (const input_fee_ppk of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(declaredInputFeePpk([{ id: 'a', active: true, input_fee_ppk }]), String(input_fee_ppk)).toBeUndefined();
    }
  });

  it('is undefined when any active keyset declares an invalid fee, even next to valid ones, so a bad value never reads as a lower fee', () => {
    for (const input_fee_ppk of [-5, 1.5, '900']) {
      expect(declaredInputFeePpk([{ id: 'a', active: true, input_fee_ppk: 0 }, { id: 'b', active: true, input_fee_ppk }]), String(input_fee_ppk)).toBeUndefined();
    }
    expect(declaredInputFeePpk([{ id: 'a', active: true, input_fee_ppk: 0 }, { id: 'old', active: false, input_fee_ppk: -5 }])).toBe(0);
  });
});

describe('probeMint declared fees', () => {
  it('stores the input fee the mint declares, without paying anything and without touching the score', async () => {
    const clock = fakeClock();
    const port = honestPort(clock, { keysets: async () => [{ id: 'k1', active: true, input_fee_ppk: 100 }] });
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, port));
    expect(r.inputFeePpk).toBe(100);
    expect(r.fees).toBeUndefined();
    const plain = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock)));
    expect(score(r)).toEqual(score(plain));
  });

  it('stores an explicit 0 when the active keysets omit the fee, so it is never confused with an older ranking.json', async () => {
    const clock = fakeClock();
    const r = await probeMint({ url: 'https://m', cycle: false }, deps(clock, honestPort(clock)));
    expect(r).toHaveProperty('inputFeePpk', 0);
    expect(JSON.parse(JSON.stringify(r)).inputFeePpk).toBe(0);
  });

  it('leaves it out when there is no active keyset to read or the mint does not answer', async () => {
    const clock = fakeClock();
    const inactive = honestPort(clock, { keysets: async () => [{ id: 'old', active: false, input_fee_ppk: 100 }] });
    expect(await probeMint({ url: 'https://m', cycle: false }, deps(clock, inactive))).not.toHaveProperty('inputFeePpk');
    expect(await probeMint({ url: 'https://down', cycle: false }, deps(clock, new Error('ECONNREFUSED')))).not.toHaveProperty('inputFeePpk');
  });
});
