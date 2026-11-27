import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { audit, concurrency, flaggedMintsJson, isPaidRun, MAX_PAYMENT_CONCURRENCY, MINT_TIMEOUT_MS, parsePrevious, PAY_TIMEOUT_MS, rankingJson, RANKING_MAX_BYTES, RUN_BUDGET_MS, writeAtomic } from '../src/audit.ts';
import { NotPaid, type MintPort, type ProbeDeps } from '../src/probe.ts';
import { SCORE } from '../src/score.ts';

const rankingWorkflow = await readFile(new URL('../.github/workflows/ranking.yml', import.meta.url), 'utf8');
const rankingSteps = rankingWorkflow.split('\n      - ');

const reachable = (latency: number, now: { t: number }): MintPort =>
  ({
    info: async () => ((now.t += latency), { name: 'm', contact: [], nuts: [4, 5] }),
    keys: async () => ((now.t += latency), [{ id: 'k', valid: true }]),
    keysets: async () => ((now.t += latency), [{ id: 'k', active: true }]),
    createMintQuote: async () => ({ quote: 'q', request: 'lnbc8' }),
    createMeltQuote: async () => ({ amount: 8 }),
  }) as unknown as MintPort;

describe('audit', () => {
  it('produces the JSON the ranking page reads: time, weights and every mint ranked best first', async () => {
    const now = { t: Date.UTC(2026, 10, 15) };
    const ports: Record<string, MintPort> = {
      'https://slow': reachable(9_000, now),
      'https://fast': reachable(10, now),
      'https://down': { info: async () => Promise.reject(new Error('down')) } as unknown as MintPort,
    };
    const deps: ProbeDeps = { port: (url) => ports[url], now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 };
    const out = await audit(Object.keys(ports).map((url) => ({ url, cycle: false })), deps);
    expect(out.generatedAt).toBe(new Date(Date.UTC(2026, 10, 15)).toISOString());
    expect(out.weights).toEqual(SCORE.weights);
    expect(out.mints.map((m) => m.url)).toEqual(['https://fast', 'https://slow', 'https://down']);
    expect(out.mints.map((m) => m.uptime)).toEqual([100, 100, 0]);
    expect(out.mints[0]).toMatchObject({ score: { total: expect.any(Number), parts: expect.any(Object), alerts: [] }, checks: expect.any(Object) });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(rankingJson(out).length).toBeLessThanOrEqual(RANKING_MAX_BYTES);
  });

  it('carries each mint uptime history from the previous ranking, newest last and capped', async () => {
    const now = { t: 0 };
    const deps: ProbeDeps = { port: () => reachable(10, now), now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 };
    const old = Array.from({ length: SCORE.historyRuns }, (_, i) => i % 2 === 0);
    const previous = { mints: [{ url: 'https://kept', history: old }] };
    const out = await audit([{ url: 'https://kept', cycle: false }, { url: 'https://new', cycle: false }], deps, previous);
    const history = Object.fromEntries(out.mints.map((m) => [m.url, m.history]));
    expect(history['https://kept']).toEqual([...old.slice(1), true]);
    expect(history['https://new']).toEqual([true]);
    expect(out.mints.find((m) => m.url === 'https://kept')?.uptime).toBe(50);
    expect(out.mints.find((m) => m.url === 'https://new')?.uptime).toBe(100);
  });

  it('keeps ranking the other mints when one mint answers garbage', async () => {
    const now = { t: 0 };
    const garbage = { ...reachable(10, now), info: async () => ({ name: 5, version: {}, contact: 'x', nuts: [4, 5] }) } as unknown as MintPort;
    const ports: Record<string, MintPort> = { 'https://good': reachable(10, now), 'https://garbage': garbage };
    const deps: ProbeDeps = {
      port: (url) => {
        if (!(url in ports)) throw new Error(`invalid mint URL: ${url}`);
        return ports[url];
      },
      now: () => now.t,
      sleep: async () => {},
      amount: 8,
      payTimeoutMs: 1, mintTimeoutMs: 60_000,
    };
    const out = await audit(['https://good', 'https://garbage', 'not-a-url'].map((url) => ({ url, cycle: false })), deps);
    expect(out.mints.map((m) => m.url).sort()).toEqual(['https://garbage', 'https://good', 'not-a-url']);
    expect(out.mints.find((m) => m.url === 'not-a-url')).toMatchObject({ online: false, error: expect.stringMatching(/invalid mint URL/) });
    expect(out.mints.find((m) => m.url === 'https://garbage')).toMatchObject({ online: true, name: null, version: null });
  });

  it('probes every later mint when one list entry is invalid, and ranks that entry as failed', async () => {
    const now = { t: 0 };
    const deps: ProbeDeps = { port: () => reachable(10, now), now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 };
    const out = await audit([{ url: 'https://first', cycle: false }, null, { url: 'https://second', cycle: false }] as never, deps);
    expect(out.mints).toHaveLength(3);
    expect(out.mints.map((m) => m.url).sort()).toEqual(['', 'https://first', 'https://second']);
    expect(out.mints.find((m) => m.url === '')).toMatchObject({ online: false, error: 'invalid mint entry', checks: {} });
    expect(out.mints.find((m) => m.url === 'https://second')).toMatchObject({ online: true });
  });

  it('refuses to serialize a ranking larger than the size cap', () => {
    const huge = { generatedAt: 't', weights: SCORE.weights, mints: [{ error: 'x'.repeat(RANKING_MAX_BYTES) }] };
    expect(() => rankingJson(huge as never)).toThrow(/ranking\.json is \d+ bytes, exceeds /);
  });
});

describe('audit flag persistence', () => {
  const now = { t: 0 };
  /** Charges us through the wallet and never issues the ecash: flagged scam and pending. */
  const thief = (): MintPort => ({ ...reachable(10, now), createMintQuote: async () => ({ quote: 'q', request: 'lnbc80n' }), isMintQuotePaid: async () => true, mint: async () => ({ proofs: [], dleqValid: true }) }) as unknown as MintPort;
  const wallet = { payInvoice: async () => {}, makeInvoice: async () => 'lnbc40n' };
  const depsFor = (ports: Record<string, MintPort>, mintTimeoutMs = 60_000, w: ProbeDeps['wallet'] = wallet): ProbeDeps => ({ port: (url) => ports[url], now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs, wallet: w });
  /** Honest mint with the whole cycle: it swaps once and refuses the second swap. */
  const honestPayer = (): MintPort => {
    let swapped = false;
    return {
      ...thief(),
      mint: async () => ({ proofs: ['p'], dleqValid: true }),
      swap: async () => {
        if (swapped) throw new Error('Token already spent.');
        swapped = true;
        return ['f'];
      },
      melt: async (_invoice: string, proofs: unknown[]) => ({ paid: true, inputs: proofs }),
      allSpent: async () => true,
    } as unknown as MintPort;
  };
  const record = (saved: unknown[]) => async (flags: unknown[]) => void saved.push(JSON.parse(JSON.stringify(flags)));

  it('saves a flag as soon as its probe sets it, before the next mint is probed', async () => {
    const list = [{ url: 'https://thief', cycle: false }, { url: 'https://fine', cycle: false }];
    const saved: string[] = [];
    const savedWhenFineStarts: number[] = [];
    const fine = { ...reachable(10, now), info: async () => (savedWhenFineStarts.push(saved.length), { name: 'm', contact: [], nuts: [4, 5] }) } as unknown as MintPort;
    await audit(list, depsFor({ 'https://thief': thief(), 'https://fine': fine }), undefined, async (mints) => void saved.push(flaggedMintsJson(list, mints)));
    // First the pending mark, saved before the wallet pays; then the flags the finished probe set.
    expect(savedWhenFineStarts).toEqual([2]);
    expect(saved).toHaveLength(2);
    expect(JSON.parse(saved[0])).toEqual([{ url: 'https://thief', cycle: false, pending: true }, { url: 'https://fine', cycle: false }]);
    expect(JSON.parse(saved[1])).toEqual([{ url: 'https://thief', cycle: false, scam: true, pending: true }, { url: 'https://fine', cycle: false }]);
  });

  it('saves the pending mark before the wallet is asked to pay, so a crash right after paying cannot lose it', async () => {
    const saved: unknown[] = [];
    const seen: unknown[] = [];
    const w = { payInvoice: async () => void seen.push(saved.at(-1)), makeInvoice: async () => 'lnbc40n' };
    const port = { ...thief(), isMintQuotePaid: async () => (seen.push(saved.at(-1)), true) } as unknown as MintPort;
    await audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': port }, 60_000, w), undefined, record(saved));
    expect(seen).toEqual([[{ url: 'https://a', pending: true }], [{ url: 'https://a', pending: true }]]);
  });

  it('pays nothing and fails the run when the pending mark cannot be saved', async () => {
    const paid: string[] = [];
    const w = { payInvoice: async (invoice: string) => void paid.push(invoice), makeInvoice: async () => 'lnbc40n' };
    await expect(audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': thief() }, 60_000, w), undefined, async () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');
    expect(paid).toEqual([]);
  });

  it('clears the saved mark once the cycle finishes clean, or the wallet proves it paid nothing', async () => {
    const clean: unknown[] = [];
    await audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': honestPayer() }), undefined, record(clean));
    expect(clean).toEqual([[{ url: 'https://a', pending: true }], []]);
    const refused: unknown[] = [];
    const w = { payInvoice: async () => Promise.reject(new NotPaid('NWC pay_invoice: INSUFFICIENT_BALANCE no funds')), makeInvoice: async () => 'lnbc40n' };
    await audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': thief() }, 60_000, w), undefined, record(refused));
    expect(refused).toEqual([[{ url: 'https://a', pending: true }], []]);
  });

  it('clears the saved mark when the wallet proves nothing was paid 20 ms after the time limit', async () => {
    const saved: unknown[] = [];
    const w = {
      payInvoice: (_invoice: string, signal?: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => setTimeout(() => reject(new NotPaid('NWC pay_invoice: RATE_LIMITED')), 20));
        }),
      makeInvoice: async () => 'lnbc40n',
    };
    const out = await audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': thief() }, 20, w), undefined, record(saved));
    expect(out.mints[0]).toMatchObject({ notMeasured: 'minted' });
    expect(out.mints[0].pending).toBeUndefined();
    expect(out.mints[0].unrun).toBeUndefined();
    expect(saved[0]).toEqual([{ url: 'https://a', pending: true }]);
    expect(saved.at(-1)).toEqual([]);
  });

  it('keeps the saved mark when a late wallet error after the time limit does not prove it paid nothing', async () => {
    const saved: unknown[] = [];
    const w = {
      payInvoice: (_invoice: string, signal?: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('NWC pay_invoice: no answer')), 20));
        }),
      makeInvoice: async () => 'lnbc40n',
    };
    const out = await audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': thief() }, 20, w), undefined, record(saved));
    expect(out.mints[0]).toMatchObject({ pending: true, notMeasured: 'minted', unrun: [4, 3, 3, 5] });
    expect(saved).toEqual([[{ url: 'https://a', pending: true }]]);
  });

  it('does not call the wallet, and clears the saved mark, when the time limit hits after the mark is saved', async () => {
    const saved: unknown[] = [];
    const paid: string[] = [];
    const w = { payInvoice: async (invoice: string) => void paid.push(invoice), makeInvoice: async () => 'lnbc40n' };
    const out = await audit([{ url: 'https://a', cycle: false }], depsFor({ 'https://a': thief() }, 40, w), undefined, async (flags) => {
      saved.push(JSON.parse(JSON.stringify(flags)));
      if (flags.some((f) => f.pending)) await new Promise((done) => setTimeout(done, 60));
    });
    await new Promise((done) => setTimeout(done, 80)); // longer than the save delay, so a background pay would already have run
    expect(paid).toEqual([]);
    expect(out.mints[0].pending).toBeUndefined();
    expect(out.mints[0].notMeasured).toBe('minted');
    expect(saved).toEqual([[{ url: 'https://a', pending: true }], []]);
  });

  it('tries once more at the end to save what a failed save left behind, even if the probe still running is honest', async () => {
    const list = [{ url: 'https://thief', cycle: false }, { url: 'https://fine', cycle: false }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fine = { ...reachable(10, now), info: async () => (await gate, { name: 'm', contact: [], nuts: [4, 5] }) } as unknown as MintPort;
    const saved: unknown[] = [];
    let calls = 0;
    const run = audit(list, depsFor({ 'https://thief': thief(), 'https://fine': fine }, 600_000), undefined, async (flags) => {
      if (++calls === 2) {
        release();
        throw new Error('disk full');
      }
      saved.push(JSON.parse(JSON.stringify(flags)));
    });
    await expect(run).rejects.toThrow('disk full');
    expect(saved.at(-1)).toEqual([{ url: 'https://thief', scam: true, pending: true }]);
  });

  it('saves nothing for an honest mint or one already flagged in the list', async () => {
    const list = [{ url: 'https://thief', cycle: false, scam: true, pending: true }, { url: 'https://fine', cycle: false }];
    let saves = 0;
    await audit(list, depsFor({ 'https://thief': thief(), 'https://fine': reachable(10, now) }), undefined, async () => void saves++);
    expect(saves).toBe(0);
  });

  it('saves one at a time, each time with every flag found so far', async () => {
    const list = [{ url: 'https://a', cycle: false }, { url: 'https://b', cycle: false }];
    let inFlight = 0;
    let peak = 0;
    let lastFlagged: string[] = [];
    const deps = depsFor({ 'https://a': thief(), 'https://b': thief() }, 600_000);
    expect(concurrency(list.length, deps.mintTimeoutMs)).toBe(2);
    await audit(list, deps, undefined, async (mints) => {
      peak = Math.max(peak, ++inFlight);
      lastFlagged = mints.filter((m) => m.pending).map((m) => m.url);
      await new Promise((done) => setTimeout(done, 10));
      inFlight--;
    });
    expect(peak).toBe(1);
    expect(lastFlagged.sort()).toEqual(['https://a', 'https://b']);
  });

  it('stops taking mints after a failed save, still persists a later flag, then fails the run', async () => {
    const list = [{ url: 'https://thief-a', cycle: false }, { url: 'https://thief-b', cycle: false }, { url: 'https://thief-c', cycle: false }];
    const paid: string[] = [];
    const invoices = { 'https://thief-a': 'lnbc80n1a', 'https://thief-b': 'lnbc80n1b', 'https://thief-c': 'lnbc80n1c' };
    let releaseB!: () => void;
    const holdB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const thiefAt = (url: keyof typeof invoices, wait?: Promise<void>): MintPort =>
      ({
        ...reachable(10, now),
        info: async () => {
          if (wait) await wait;
          now.t += 10;
          return { name: 'm', contact: [], nuts: [4, 5] };
        },
        createMintQuote: async () => ({ quote: 'q', request: invoices[url] }),
        isMintQuotePaid: async () => true,
        mint: async () => ({ proofs: [], dleqValid: true }),
      }) as unknown as MintPort;
    const deps = {
      ...depsFor(
        { 'https://thief-a': thiefAt('https://thief-a'), 'https://thief-b': thiefAt('https://thief-b', holdB), 'https://thief-c': thiefAt('https://thief-c') },
        600_000,
      ),
      wallet: { payInvoice: async (invoice: string) => void paid.push(invoice), makeInvoice: async () => 'lnbc40n' },
    };
    expect(concurrency(list.length, deps.mintTimeoutMs)).toBe(2);
    let saves = 0;
    let secondCalled = false;
    let firstTried!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      firstTried = resolve;
    });
    const run = audit(list, deps, undefined, async () => {
      if (++saves === 1) {
        firstTried();
        throw new Error('disk full');
      }
      secondCalled = true;
    });
    await firstSave;
    releaseB();
    await expect(run).rejects.toThrow('disk full');
    expect(secondCalled).toBe(true);
    // The failed save was thief-a's mark before paying, so thief-a is not paid; thief-b was already in flight and saved its own.
    expect(paid).toEqual([invoices['https://thief-b']]);
  });
});

describe('payment deadline', () => {
  const now = { t: 0 };
  /** An honest mint whose first read moves the clock to `reachesMs`, then 20 ms more for the other two reads. */
  const honestAt = (reachesMs: number): MintPort => {
    let swapped = false;
    return {
      ...reachable(10, now),
      info: async () => ((now.t += reachesMs), { name: 'm', contact: [], nuts: [4, 5] }),
      createMintQuote: async () => ({ quote: 'q', request: 'lnbc80n' }),
      isMintQuotePaid: async () => true,
      mint: async () => ({ proofs: ['p'], dleqValid: true }),
      swap: async () => {
        if (swapped) throw new Error('Token already spent.');
        swapped = true;
        return ['f'];
      },
      melt: async (_invoice: string, proofs: unknown[]) => ({ paid: true, inputs: proofs }),
      allSpent: async () => true,
    } as unknown as MintPort;
  };
  const run = async (reachesMs: number, onPay: () => void = () => {}) => {
    now.t = 0;
    const paid: string[] = [];
    const saved: unknown[] = [];
    const wallet = { payInvoice: async (invoice: string) => (paid.push(invoice), onPay()), makeInvoice: async () => 'lnbc40n' };
    const deps: ProbeDeps = { port: () => honestAt(reachesMs), now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: MINT_TIMEOUT_MS, wallet };
    const out = await audit([{ url: 'https://a', cycle: false }], deps, undefined, async (flags) => void saved.push(JSON.parse(JSON.stringify(flags))));
    return { out, paid, saved, mint: out.mints[0] };
  };
  /** The last clock reading at which a whole mint limit still fits before the cutoff, once the three reads are done. */
  const lastFitting = RUN_BUDGET_MS - MINT_TIMEOUT_MS - 20;

  it('never marks pending nor calls the wallet when a whole mint limit no longer fits before the cutoff', async () => {
    const { paid, saved, mint } = await run(lastFitting + 1);
    expect(paid).toEqual([]);
    expect(saved).toEqual([]);
    expect(mint).toMatchObject({ noTime: true, notMeasured: 'minted' });
    expect(mint.pending).toBeUndefined();
    expect(mint.scam).toBeUndefined();
    expect(mint.unrun).toBeUndefined();
    expect(mint.score.alerts).toEqual([]);
  });

  it('pays when the mint limit fits exactly up to the cutoff, and a payment already started finishes even if the cutoff passes meanwhile', async () => {
    const { paid, saved, mint } = await run(lastFitting, () => void (now.t += RUN_BUDGET_MS));
    expect(paid).toHaveLength(1);
    expect(saved).toEqual([[{ url: 'https://a', pending: true }], []]);
    expect(mint.noTime).toBeUndefined();
    expect(mint.pending).toBeUndefined();
    expect(mint.checks.melted?.ok).toBe(true);
    expect(mint.unrun).toBeUndefined();
  });

  it('does not penalize the cycle checks a mint had no time for, and never ranks it above a mint that finished the cycle', async () => {
    const late = (await run(lastFitting + 1)).mint;
    const honest = (await run(lastFitting)).mint;
    expect(late.score.parts.nuts).toBe(SCORE.weights.nuts);
    expect(late.score.total).toBeGreaterThan(0);
    expect(late.score.total).toBeLessThanOrEqual(honest.score.total);
  });
});

describe('run time budget', () => {
  it('gives every mint the same fixed limit, caps payments at 2, and keeps the workflow timeout in line with the run', async () => {
    expect(MINT_TIMEOUT_MS).toBe(60_000);
    expect(PAY_TIMEOUT_MS).toBeLessThan(MINT_TIMEOUT_MS);
    expect(MAX_PAYMENT_CONCURRENCY).toBe(2);
    const timeoutMinutes = Number(/timeout-minutes:\s*(\d+)/.exec(rankingWorkflow)?.[1]);
    const list = JSON.parse(await readFile(new URL('../mints.json', import.meta.url), 'utf8')) as unknown[];
    const needed = (n: number) => Math.ceil(n / concurrency(n, MINT_TIMEOUT_MS)) * MINT_TIMEOUT_MS;
    expect(RUN_BUDGET_MS + 5 * 60_000).toBeLessThanOrEqual(timeoutMinutes * 60_000);
    expect(needed(list.length) + 5 * 60_000).toBeLessThanOrEqual(timeoutMinutes * 60_000);
    for (const n of [0, 1, 9, 15, 16, 60, 120, 1000]) {
      const k = concurrency(n, MINT_TIMEOUT_MS);
      expect(k, String(n)).toBeGreaterThanOrEqual(1);
      expect(k, String(n)).toBeLessThanOrEqual(MAX_PAYMENT_CONCURRENCY);
      if (n === 0 || Math.ceil(n / MAX_PAYMENT_CONCURRENCY) * MINT_TIMEOUT_MS <= RUN_BUDGET_MS) {
        expect(needed(n), String(n)).toBeLessThanOrEqual(RUN_BUDGET_MS);
      } else {
        expect(needed(n), String(n)).toBe(Math.ceil(n / MAX_PAYMENT_CONCURRENCY) * MINT_TIMEOUT_MS);
      }
    }
    expect(concurrency(9, MINT_TIMEOUT_MS)).toBe(1);
    expect(concurrency(1000, MINT_TIMEOUT_MS)).toBe(MAX_PAYMENT_CONCURRENCY);
  });

  it('stops starting payments early enough that install, the probe, and the commit fit in the job timeout', () => {
    const jobMs = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(rankingWorkflow)?.[1]) * 60_000;
    const timeoutOf = (chunk: string) => {
      const m = /timeout-minutes:\s*(\d+)/.exec(chunk);
      return m ? Number(m[1]) * 60_000 : undefined;
    };
    const probeAt = rankingSteps.findIndex((s) => s.startsWith('name: Probe mints'));
    const stepMs = timeoutOf(rankingSteps[probeAt] ?? '');
    const processSlackMs = 60_000; // starting the process and writing the files
    const installMs = 8 * 60_000; // generous budget for a slow or cache-miss install, spent before the probe
    const commitMs = 3 * 60_000;
    // The worst case: a payment starts right at the edge of the cutoff and takes its whole mint limit.
    expect(stepMs).toBeTypeOf('number');
    expect(RUN_BUDGET_MS + MINT_TIMEOUT_MS + processSlackMs).toBeLessThanOrEqual(stepMs!);
    // The job clock starts at checkout, so a slow install is spent before the probe, not after it.
    expect(installMs + stepMs! + commitMs).toBeLessThanOrEqual(jobMs);
    // Setup and install have their own caps so a hang cannot eat the probe's time, and those caps fit the install budget.
    const setup = rankingSteps.slice(1, probeAt);
    expect(setup.length).toBeGreaterThan(0);
    expect(setup.every((s) => timeoutOf(s) !== undefined)).toBe(true);
    expect(setup.reduce((sum, s) => sum + timeoutOf(s)!, 0)).toBeLessThanOrEqual(installMs);
    expect(timeoutOf(rankingSteps.find((s) => s.startsWith('name: Commit ranking')) ?? '')).toBe(commitMs);
  });

  it('probes as many mints at once as the budget needs, never more', async () => {
    for (const n of [3, 16, 40]) {
      let inFlight = 0;
      let peak = 0;
      const port = {
        info: async () => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((done) => setTimeout(done, 5));
          inFlight--;
          throw new Error('down');
        },
      } as unknown as MintPort;
      const deps: ProbeDeps = { port: () => port, now: Date.now, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: MINT_TIMEOUT_MS };
      const out = await audit(Array.from({ length: n }, (_, i) => ({ url: `https://m${i}`, cycle: false })), deps);
      expect(out.mints, String(n)).toHaveLength(n);
      expect(peak, String(n)).toBe(concurrency(n, MINT_TIMEOUT_MS));
    }
  });
});

describe('flaggedMintsJson', () => {
  const targets = [{ url: 'https://a', cycle: true }, { url: 'https://b', cycle: false }, { url: 'https://c', cycle: false, scam: true }];

  it('flags every mint this run caught as scam, keeping order, fields and earlier flags', () => {
    const out = JSON.parse(flaggedMintsJson(targets, [{ url: 'https://c', scam: true }, { url: 'https://b', scam: true }, { url: 'https://a' }]));
    expect(out).toEqual([{ url: 'https://a', cycle: true }, { url: 'https://b', cycle: false, scam: true }, { url: 'https://c', cycle: false, scam: true }]);
  });

  it('flags a mint left pending the same way as scam, and never drops an earlier pending flag', () => {
    const listed = [...targets, { url: 'https://d', cycle: false, pending: true }];
    const out = JSON.parse(flaggedMintsJson(listed, [{ url: 'https://a', pending: true }, { url: 'https://d' }]));
    expect(out).toEqual([
      { url: 'https://a', cycle: true, pending: true },
      { url: 'https://b', cycle: false },
      { url: 'https://c', cycle: false, scam: true },
      { url: 'https://d', cycle: false, pending: true },
    ]);
  });

  it('rewrites mints.json byte for byte when nothing new was caught, so the workflow commits only real flags', async () => {
    const text = await readFile(new URL('../mints.json', import.meta.url), 'utf8');
    expect(flaggedMintsJson(JSON.parse(text), [])).toBe(text);
  });

  it('commits mints.json even when the probe step crashes or times out, so a flag saved mid-run is not lost', () => {
    expect(rankingWorkflow).toMatch(/- name: Commit ranking\n\s+if: always\(\)/);
  });

  it('is committed by the ranking workflow next to ranking.json', () => {
    expect(rankingWorkflow).toMatch(/git add site\/ranking\.json mints\.json/);
  });

  it('runs only from master, the production branch, so the plain checkout already is master', () => {
    expect(rankingWorkflow).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/master'$/m);
    const checkout = rankingSteps.find((s) => s.startsWith('uses: actions/checkout@')) ?? '';
    expect(checkout).not.toMatch(/^\s+ref:/m);
  });

  describe('commit step against a master that moved during the run', () => {
    const commitScript = (rankingSteps.find((s) => s.startsWith('name: Commit ranking')) ?? '')
      .split('run: |\n')[1]!
      .replace(/^ {10}/gm, '');
    const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITHUB_TOKEN: 'test-token' };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    // Runs the step as Actions does (bash -eo pipefail) in a runner clone with a new ranking, and someone else's commit already on master that touches `file`.
    const setup = async (file: string) => {
      const dir = await mkdtemp(join(tmpdir(), 'auditorcillo-push-'));
      onTestFinished(() => rm(dir, { recursive: true, force: true }));
      git(dir, 'init', '-q', '--bare', '-b', 'master', 'origin.git');
      git(dir, 'clone', '-q', 'origin.git', 'seed');
      await mkdir(join(dir, 'seed', 'site'));
      await writeFile(join(dir, 'seed', 'mints.json'), '[]\n');
      await writeFile(join(dir, 'seed', 'README.md'), 'r\n');
      await writeFile(join(dir, 'seed', 'site', 'ranking.json'), '{}\n');
      git(join(dir, 'seed'), 'add', 'mints.json', 'README.md', 'site/ranking.json');
      git(join(dir, 'seed'), 'commit', '-qm', 'seed');
      git(join(dir, 'seed'), 'push', '-q', 'origin', 'HEAD:master');
      git(dir, 'clone', '-q', '-b', 'master', 'origin.git', 'other');
      git(dir, 'clone', '-q', '-b', 'master', 'origin.git', 'runner');
      await writeFile(join(dir, 'other', file), 'other\n');
      git(join(dir, 'other'), 'commit', '-qam', 'other');
      git(join(dir, 'other'), 'push', '-q', 'origin', 'master');
      await writeFile(join(dir, 'runner', 'site', 'ranking.json'), '{"new":true}\n');
      const run = () => {
        try {
          execFileSync('bash', ['-eo', 'pipefail', '-c', commitScript], { cwd: join(dir, 'runner'), env, stdio: 'pipe' });
          return 0;
        } catch (e) {
          return (e as { status: number }).status;
        }
      };
      return { runner: join(dir, 'runner'), run, master: () => git(join(dir, 'origin.git'), 'log', '--format=%s', 'master') };
    };

    it('rebases on the new master and pushes the ranking on top of it', async () => {
      const { run, master } = await setup('README.md');
      expect(run()).toBe(0);
      expect(master()).toBe('chore: update mint ranking\nother\nseed');
    });

    it('fails without pushing when master changed the same file', async () => {
      const { runner, run, master } = await setup('site/ranking.json');
      expect(run()).toBe(1);
      expect(await readdir(join(runner, '.git'))).not.toContain('rebase-merge');
      expect(master()).toBe('other\nseed');
    });
  });
});

describe('parsePrevious', () => {
  it('turns an unreadable or unexpected previous ranking into an empty one', () => {
    for (const text of ['', '{', 'null', '5', '[]', '{}', '{"mints":5}', '{"mints":"x"}']) expect(parsePrevious(text), text).toEqual({ mints: [] });
  });

  it('keeps only mints with a string url and only boolean history entries', () => {
    const text = JSON.stringify({ mints: [null, 5, { url: 3 }, { url: 'https://a', history: [true, 'x', false, null, 1] }, { url: 'https://b', history: 'x' }] });
    expect(parsePrevious(text)).toEqual({ mints: [{ url: 'https://a', history: [true, false] }, { url: 'https://b', history: [] }] });
  });

  it('extracts validated paidCheckedAt, cycle checks and explicit cycleUnrun names, ignoring garbage and prototype keys', () => {
    const text = JSON.stringify({
      mints: [
        {
          url: 'https://a',
          history: [true],
          paidCheckedAt: '2026-11-24T12:17:00.000Z',
          incomplete: 'yes',
          notMeasured: 'toString',
          noTime: 'true',
          cycleUnrun: ['spentState', 'melted', 'toString', 'constructor', 7, null],
          checks: {
            keysetIds: { nut: 2, ok: true },
            minted: { nut: 4, ok: true },
            melted: { nut: 5, ok: 'nope' },
            swap: { nut: 99, ok: true },
            bogus: { nut: 9, ok: true },
            toString: { nut: 4, ok: true },
          },
        },
        {
          url: 'https://b',
          history: [],
          paidCheckedAt: 'not-a-date',
          cycleUnrun: ['melted'],
          checks: { melted: { nut: 5, ok: true } },
        },
      ],
    });
    const parsed = parsePrevious(text);
    expect(parsed.mints[0]).toEqual({
      url: 'https://a',
      history: [true],
      paidCheckedAt: '2026-11-24T12:17:00.000Z',
      checks: { minted: { nut: 4, ok: true, cycle: true } },
      cycleUnrun: ['spentState', 'melted'],
    });
    expect(parsed.mints[0].incomplete).toBeUndefined();
    expect(parsed.mints[1]).toEqual({ url: 'https://b', history: [] });
  });
});

describe('writeAtomic', () => {
  it('replaces the target with the full text and leaves no temporary file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auditorcillo-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'ranking.json');
    await writeFile(path, 'old');
    await writeAtomic(path, '{}\n');
    expect(await readFile(path, 'utf8')).toBe('{}\n');
    expect(await readdir(dir)).toEqual(['ranking.json']);
  });
});

describe('isPaidRun', () => {
  it('allows real-wallet payments only in the [12:00, 15:00) UTC window (09:17 ART slot + cron delay)', () => {
    expect(isPaidRun(Date.UTC(2026, 10, 24, 11, 59, 59, 999))).toBe(false);
    expect(isPaidRun(Date.UTC(2026, 10, 24, 12, 0, 0))).toBe(true);
    expect(isPaidRun(Date.UTC(2026, 10, 24, 12, 17, 0))).toBe(true);
    expect(isPaidRun(Date.UTC(2026, 10, 24, 14, 59, 59, 999))).toBe(true);
    expect(isPaidRun(Date.UTC(2026, 10, 24, 15, 0, 0))).toBe(false);
    for (const h of [0, 3, 6, 9, 15, 18, 21]) {
      expect(isPaidRun(Date.UTC(2026, 10, 24, h, 17, 0)), `hour ${h}`).toBe(false);
    }
    expect(isPaidRun(Number.NaN)).toBe(false);
    expect(isPaidRun(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('daily paid cycle reuse', () => {
  const paidTime = Date.UTC(2026, 10, 24, 12, 17, 0);
  const laterTime = Date.UTC(2026, 10, 24, 15, 17, 0);
  const thirdTime = Date.UTC(2026, 10, 24, 18, 17, 0);
  const fullInfo = { name: 'Honest', pubkey: '02' + 'a'.repeat(64), version: '1', description: 'd', contact: [{ method: 'nostr', info: 'npub1' }], nuts: [4, 5, 7, 12] };
  const honestPort = (over: Partial<MintPort> = {}): MintPort => {
    let swapped = false;
    return {
      info: async () => fullInfo,
      keys: async () => [{ id: 'k', valid: true }],
      keysets: async () => [{ id: 'k', active: true }],
      createMintQuote: async () => ({ quote: 'q', request: 'lnbc80n' }),
      createMeltQuote: async () => ({ amount: 8 }),
      unknownProofIsUnspent: async () => true,
      isMintQuotePaid: async () => true,
      mint: async () => ({ proofs: ['p'], dleqValid: true }),
      swap: async () => {
        if (swapped) throw new Error('Token already spent.');
        swapped = true;
        return ['f'];
      },
      melt: async (_invoice: string, proofs: unknown[]) => ({ paid: true, inputs: proofs }),
      allSpent: async () => true,
      ...over,
    } as unknown as MintPort;
  };
  const wallet = { payInvoice: async () => {}, makeInvoice: async () => 'lnbc40n' };

  it('records paidCheckedAt only on real mints that ran the paid cycle, not FakeWallet or offline or noTime', async () => {
    let clock = paidTime;
    const ports: Record<string, MintPort> = {
      'https://real': honestPort(),
      'https://fake': honestPort(),
      'https://down': { info: async () => Promise.reject(new Error('down')) } as unknown as MintPort,
      'https://late': honestPort({ info: async () => ((clock += RUN_BUDGET_MS), fullInfo) }),
    };
    const out = await audit(
      [
        { url: 'https://real', cycle: false },
        { url: 'https://fake', cycle: true },
        { url: 'https://down', cycle: false },
        { url: 'https://late', cycle: false },
      ],
      { port: (u) => ports[u], now: () => clock, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: MINT_TIMEOUT_MS, wallet },
    );
    const byUrl = Object.fromEntries(out.mints.map((m) => [m.url, m]));
    expect(byUrl['https://real'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(byUrl['https://fake'].paidCheckedAt).toBeUndefined();
    expect(byUrl['https://down'].paidCheckedAt).toBeUndefined();
    expect(byUrl['https://late'].noTime).toBe(true);
    expect(byUrl['https://late'].paidCheckedAt).toBeUndefined();
  });

  it('reuses paid cycle checks and paidCheckedAt on non-paid runs across multiple runs, keeping scores stable while updating public checks', async () => {
    const portsPaid: Record<string, MintPort> = {
      'https://honest': honestPort(),
      'https://cheater': honestPort({ swap: async () => ['f'], allSpent: async () => false }),
      'https://fake': honestPort(),
    };
    const targets = [
      { url: 'https://honest', cycle: false },
      { url: 'https://cheater', cycle: false },
      { url: 'https://fake', cycle: true },
    ];
    const run1 = await audit(targets, { port: (u) => portsPaid[u], now: () => paidTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet });
    const prev1 = parsePrevious(rankingJson(run1));

    // Non-paid run (no wallet): cheater and honest would otherwise never run swap/doubleSpendRejected,
    // while fake still runs its FakeWallet cycle.
    const spyMint = async () => { throw new Error('must not run cycle on real mint without wallet'); };
    const portsUnpaid: Record<string, MintPort> = {
      'https://honest': honestPort({ mint: spyMint }),
      'https://cheater': honestPort({ mint: spyMint }),
      'https://fake': honestPort(),
    };
    const run2 = await audit(targets, { port: (u) => portsUnpaid[u], now: () => laterTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 }, prev1);
    const byUrl2 = Object.fromEntries(run2.mints.map((m) => [m.url, m]));

    expect(byUrl2['https://honest'].checkedAt).toBe(new Date(laterTime).toISOString());
    expect(byUrl2['https://honest'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(byUrl2['https://honest'].checks.melted).toMatchObject({ nut: 5, ok: true, cycle: true });
    expect(byUrl2['https://honest'].checks.keysetIds.cycle).toBeUndefined();
    expect(byUrl2['https://honest'].score.total).toBe(100);
    expect(byUrl2['https://honest'].history).toEqual([true, true]);

    expect(byUrl2['https://cheater'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(byUrl2['https://cheater'].checks.doubleSpendRejected).toMatchObject({ nut: 3, ok: false, cycle: true });
    expect(byUrl2['https://cheater'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });

    expect(byUrl2['https://fake'].paidCheckedAt).toBeUndefined();
    expect(byUrl2['https://fake'].checks.melted).toMatchObject({ nut: 5, ok: true, cycle: true });

    // Third run (still non-paid) carries run1's paid cycle forward from run2's ranking.json!
    const run3 = await audit(targets, { port: (u) => portsUnpaid[u], now: () => thirdTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 }, parsePrevious(rankingJson(run2)));
    const byUrl3 = Object.fromEntries(run3.mints.map((m) => [m.url, m]));
    expect(byUrl3['https://honest'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(byUrl3['https://honest'].checks.doubleSpendRejected).toMatchObject({ nut: 3, ok: true, cycle: true });
    expect(byUrl3['https://cheater'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });
  });

  it('reuses incomplete and explicit cycleUnrun from the previous paid run, without inventing results or showing stale noTime chips', async () => {
    let clock = paidTime;
    const ports: Record<string, MintPort> = {
      'https://incomplete': honestPort({ swap: async () => { throw new Error('swap boom'); } }),
      'https://no-time': honestPort({ info: async () => ((clock += RUN_BUDGET_MS), fullInfo) }),
      'https://never-paid': honestPort(),
    };
    const paidOnlyTargets = [{ url: 'https://incomplete', cycle: false }, { url: 'https://no-time', cycle: false }];
    const run1 = await audit(paidOnlyTargets, { port: (u) => ports[u], now: () => clock, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: MINT_TIMEOUT_MS, wallet });
    expect(run1.mints.find((m) => m.url === 'https://no-time')).toMatchObject({ noTime: true, notMeasured: 'minted' });
    const incomplete = run1.mints.find((m) => m.url === 'https://incomplete')!;
    expect(incomplete.cycleUnrun).toEqual(['doubleSpendRejected', 'melted', 'spentState']);
    const prev = parsePrevious(rankingJson(run1));

    const run2 = await audit(
      [...paidOnlyTargets, { url: 'https://never-paid', cycle: false }],
      { port: () => honestPort(), now: () => laterTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: MINT_TIMEOUT_MS },
      prev,
    );
    const byUrl = Object.fromEntries(run2.mints.map((m) => [m.url, m]));
    expect(byUrl['https://incomplete'].incomplete).toBe(true);
    expect(byUrl['https://incomplete'].cycleUnrun).toEqual(['doubleSpendRejected', 'melted', 'spentState']);
    expect(byUrl['https://incomplete'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });
    expect(byUrl['https://no-time'].noTime).toBeUndefined();
    expect(byUrl['https://no-time'].notMeasured).toBeUndefined();
    expect(byUrl['https://no-time'].paidCheckedAt).toBeUndefined();
    expect(byUrl['https://no-time'].score.alerts).toEqual([]);
    expect(byUrl['https://never-paid'].paidCheckedAt).toBeUndefined();
    expect(Object.keys(byUrl['https://never-paid'].checks).sort()).toEqual(['checkState', 'keysetIds', 'keysetsListed', 'meltQuote', 'mintQuote']);
  });

  it('does not let garbage or prototype keys in a previous ranking inflate an unpaid score', async () => {
    const previous = parsePrevious(JSON.stringify({
      mints: [{
        url: 'https://a',
        history: [true],
        paidCheckedAt: '2026-11-24T12:17:00.000Z',
        incomplete: 'yes',
        notMeasured: 'toString',
        cycleUnrun: ['toString', 'constructor'],
        checks: {
          minted: { nut: 4, ok: 'true' },
          dleq: { nut: 12, ok: 1 },
          swap: { nut: 99, ok: true },
          melted: { nut: 5, ok: 'true' },
          doubleSpendRejected: { ok: true },
          toString: { nut: 4, ok: true },
        },
      }],
    }));
    const withGarbage = await audit(
      [{ url: 'https://a', cycle: false }],
      { port: () => honestPort(), now: () => laterTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
      previous,
    );
    const fresh = await audit(
      [{ url: 'https://a', cycle: false }],
      { port: () => honestPort(), now: () => laterTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
    );
    expect(withGarbage.mints[0].notMeasured).toBeUndefined();
    expect(withGarbage.mints[0].incomplete).toBeUndefined();
    expect(withGarbage.mints[0].checks.melted).toBeUndefined();
    expect(withGarbage.mints[0].checks.minted).toBeUndefined();
    expect(withGarbage.mints[0].score).toEqual(fresh.mints[0].score);
  });

  it('keeps paid cycle results on an offline unpaid run so a cheater stays at 0 with an alert when it returns', async () => {
    const targets = [{ url: 'https://honest', cycle: false }, { url: 'https://cheater', cycle: false }];
    const paid = await audit(
      targets,
      {
        port: (u) => u.endsWith('cheater') ? honestPort({ swap: async () => ['f'], allSpent: async () => false }) : honestPort(),
        now: () => paidTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet,
      },
    );
    expect(paid.mints.find((m) => m.url === 'https://cheater')?.score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });

    const down = { info: async () => { throw new Error('down'); } } as unknown as MintPort;
    const offline = await audit(
      targets,
      { port: () => down, now: () => laterTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
      parsePrevious(rankingJson(paid)),
    );
    const off = Object.fromEntries(offline.mints.map((m) => [m.url, m]));
    expect(off['https://honest'].online).toBe(false);
    expect(off['https://honest'].score.total).toBe(0);
    expect(off['https://honest'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(off['https://honest'].checks.melted).toMatchObject({ nut: 5, ok: true, cycle: true });
    expect(off['https://cheater'].checks.doubleSpendRejected).toMatchObject({ nut: 3, ok: false, cycle: true });
    expect(off['https://cheater'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });

    const spyMint = async () => { throw new Error('must not run cycle on real mint without wallet'); };
    const back = await audit(
      targets,
      { port: () => honestPort({ mint: spyMint }), now: () => thirdTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
      parsePrevious(rankingJson(offline)),
    );
    const on = Object.fromEntries(back.mints.map((m) => [m.url, m]));
    expect(on['https://cheater'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });
    expect(on['https://honest'].online).toBe(true);
    expect(on['https://honest'].score.alerts).toEqual([]);
    expect(on['https://honest'].score.parts.nuts).toBe(30);
    expect(on['https://honest'].score.total).toBe(86.7); // uptime 2/3 after the offline run
    expect(on['https://honest'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
  });

  it('reuses the previous paid cycle when a later paid-window run hits noTime, so a cheater stays at 0 after the next public run', async () => {
    const targets = [{ url: 'https://honest', cycle: false }, { url: 'https://cheater', cycle: false }];
    const paid = await audit(
      targets,
      {
        port: (u) => u.endsWith('cheater') ? honestPort({ swap: async () => ['f'], allSpent: async () => false }) : honestPort(),
        now: () => paidTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet,
      },
    );
    expect(paid.mints.find((m) => m.url === 'https://cheater')?.score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });

    let clock = paidTime + 86_400_000;
    const late = await audit(
      targets,
      {
        port: () => honestPort({ info: async () => ((clock += RUN_BUDGET_MS), fullInfo) }),
        now: () => clock, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: MINT_TIMEOUT_MS, wallet,
      },
      parsePrevious(rankingJson(paid)),
    );
    const mid = Object.fromEntries(late.mints.map((m) => [m.url, m]));
    expect(mid['https://cheater'].noTime).toBe(true);
    expect(mid['https://cheater'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(mid['https://cheater'].checks.doubleSpendRejected).toMatchObject({ nut: 3, ok: false, cycle: true });
    expect(mid['https://cheater'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });

    const pub = await audit(
      targets,
      { port: () => honestPort({ mint: async () => { throw new Error('must not run cycle'); } }), now: () => clock + 3 * 60 * 60_000, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
      parsePrevious(rankingJson(late)),
    );
    expect(pub.mints.find((m) => m.url === 'https://cheater')?.noTime).toBeUndefined();
    expect(pub.mints.find((m) => m.url === 'https://cheater')?.score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });
    expect(pub.mints.find((m) => m.url === 'https://honest')?.score.alerts).toEqual([]);
    expect(pub.mints.find((m) => m.url === 'https://honest')?.checks.melted).toMatchObject({ nut: 5, ok: true, cycle: true });
  });

  it('reuses the previous paid cycle when our wallet fails with notMeasured, so a cheater stays at 0 after the next public run', async () => {
    const targets = [{ url: 'https://honest', cycle: false }, { url: 'https://cheater', cycle: false }];
    const paid = await audit(
      targets,
      {
        port: (u) => u.endsWith('cheater') ? honestPort({ swap: async () => ['f'], allSpent: async () => false }) : honestPort(),
        now: () => paidTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet,
      },
    );
    const refused = { payInvoice: async () => Promise.reject(new NotPaid('NWC pay_invoice: INSUFFICIENT_BALANCE')), makeInvoice: async () => 'lnbc40n' };
    const failed = await audit(
      targets,
      {
        port: (u) => u.endsWith('cheater') ? honestPort({ swap: async () => ['f'], allSpent: async () => false }) : honestPort(),
        now: () => paidTime + 86_400_000, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet: refused,
      },
      parsePrevious(rankingJson(paid)),
    );
    const mid = Object.fromEntries(failed.mints.map((m) => [m.url, m]));
    expect(mid['https://cheater'].notMeasured).toBe('minted');
    expect(mid['https://cheater'].pending).toBeUndefined();
    expect(mid['https://cheater'].paidCheckedAt).toBe(new Date(paidTime).toISOString());
    expect(mid['https://cheater'].checks.doubleSpendRejected).toMatchObject({ nut: 3, ok: false, cycle: true });
    expect(mid['https://cheater'].score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });

    const pub = await audit(
      targets,
      { port: () => honestPort({ mint: async () => { throw new Error('must not run cycle'); } }), now: () => paidTime + 86_400_000 + 3 * 60 * 60_000, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
      parsePrevious(rankingJson(failed)),
    );
    expect(pub.mints.find((m) => m.url === 'https://cheater')?.notMeasured).toBeUndefined();
    expect(pub.mints.find((m) => m.url === 'https://cheater')?.score).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });
    expect(pub.mints.find((m) => m.url === 'https://honest')?.score.alerts).toEqual([]);
    expect(pub.mints.find((m) => m.url === 'https://honest')?.checks.melted).toMatchObject({ nut: 5, ok: true, cycle: true });
  });

  it('does not carry a previous passing cycle when payInvoice fails without proving NotPaid, and a later flagged run does not go up', async () => {
    const paid = await audit(
      [{ url: 'https://a', cycle: false }, { url: 'https://h', cycle: false }],
      { port: () => honestPort(), now: () => paidTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet },
    );
    expect(paid.mints.find((m) => m.url === 'https://a')?.checks.melted).toMatchObject({ ok: true });

    // A new paidCheckedAt: this run is the last time a payment may have gone out, and must not keep yesterday's date or passing checks.
    const unclearAt = paidTime + 86_400_000;
    const unclear = await audit(
      [{ url: 'https://a', cycle: false }],
      {
        port: () => honestPort(),
        now: () => unclearAt, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000,
        wallet: { payInvoice: async () => Promise.reject(new Error('NWC pay_invoice: no answer')), makeInvoice: async () => 'lnbc40n' },
      },
      parsePrevious(rankingJson(paid)),
    );
    const pendingMint = unclear.mints[0];
    expect(pendingMint).toMatchObject({ pending: true, notMeasured: 'minted' });
    expect(pendingMint.checks.melted).toBeUndefined();
    expect(pendingMint.checks.minted).toBeUndefined();
    expect(pendingMint.paidCheckedAt).toBe(new Date(unclearAt).toISOString());
    expect(pendingMint.score.total).toBeLessThan(paid.mints.find((m) => m.url === 'https://h')!.score.total);

    const pub = await audit(
      [{ url: 'https://a', cycle: false, pending: true }, { url: 'https://h', cycle: false }],
      { port: () => honestPort({ mint: async () => { throw new Error('must not run cycle'); } }), now: () => unclearAt + 3 * 60 * 60_000, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000 },
      parsePrevious(rankingJson(unclear)),
    );
    const later = pub.mints.find((m) => m.url === 'https://a')!;
    const honest = pub.mints.find((m) => m.url === 'https://h')!;
    expect(later.pending).toBe(true);
    expect(later.checks.melted).toBeUndefined();
    expect(later.checks.minted).toBeUndefined();
    expect(later.score.total).toBeLessThanOrEqual(pendingMint.score.total);
    expect(later.score.total).toBeLessThan(honest.score.total);
  });

  it('preserves a pending mint cycle penalty across a later paid run so it never scores above an honest mint', async () => {
    const failingWallet = { payInvoice: async () => {}, makeInvoice: async () => { throw new Error('NWC'); } };
    const run1 = await audit(
      [{ url: 'https://p', cycle: false }, { url: 'https://h', cycle: false }],
      { port: () => honestPort(), now: () => paidTime, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet: failingWallet },
    );
    const prev = parsePrevious(rankingJson(run1));
    expect(run1.mints.find((m) => m.url === 'https://p')?.pending).toBe(true);
    expect(run1.mints.find((m) => m.url === 'https://p')?.notMeasured).toBe('melted');

    const paidRun2 = await audit(
      [{ url: 'https://p', cycle: false, pending: true }, { url: 'https://h', cycle: false }],
      { port: () => honestPort(), now: () => paidTime + 86_400_000, sleep: async () => {}, amount: 8, payTimeoutMs: 1, mintTimeoutMs: 60_000, wallet },
      prev,
    );
    const pMint = paidRun2.mints.find((m) => m.url === 'https://p')!;
    const hMint = paidRun2.mints.find((m) => m.url === 'https://h')!;
    expect(pMint.pending).toBe(true);
    expect(pMint.notMeasured).toBeUndefined();
    expect(pMint.score.total).toBeLessThan(hMint.score.total);
  });
});
