// The whole auditor (cashu-ts adapter included) against local Nutshell mints on FakeWallet: one honest, two cheating.
// Needs the venv from the README; run with `pnpm test:live`.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashuPort } from '../../src/cashu.ts';
import { startLocalMint, type LocalMint } from '../../src/local-mint.ts';
import { probeMint } from '../../src/probe.ts';
import { score } from '../../src/score.ts';

const mints: Record<string, LocalMint> = {};
beforeAll(async () => {
  [mints.honest, mints.doubleSpend, mints.keyset] = await Promise.all([
    startLocalMint(3391, 'honest'),
    startLocalMint(3392, 'double-spend'),
    startLocalMint(3393, 'keyset'),
  ]);
}, 60_000);
afterAll(() => Object.values(mints).forEach((m) => m.stop()));

const probe = (m: LocalMint) =>
  probeMint({ url: m.url, cycle: true }, { port: (url) => cashuPort(url, { allowLocal: true }), now: Date.now, sleep: (ms) => sleep(ms), amount: 8, payTimeoutMs: 10_000, mintTimeoutMs: 60_000 });

describe('auditor on local FakeWallet mints', () => {
  it('passes every public and cycle check on the honest mint and scores it 100', async () => {
    const r = await probe(mints.honest);
    expect(r.error).toBeNull();
    expect(Object.keys(r.checks).sort()).toEqual(
      ['checkState', 'dleq', 'doubleSpendRejected', 'keysetIds', 'keysetsListed', 'meltQuote', 'melted', 'mintQuote', 'minted', 'spentState', 'swap'],
    );
    expect(Object.values(r.checks).every((c) => c.ok)).toBe(true);
    expect(score(r)).toMatchObject({ total: 100, alerts: [] });
  }, 60_000);

  it('catches the mint that accepts an already spent token', async () => {
    const r = await probe(mints.doubleSpend);
    expect(r.checks).toMatchObject({ swap: { ok: true }, doubleSpendRejected: { ok: false }, spentState: { ok: false } });
    expect(score(r)).toMatchObject({ total: 0, alerts: ['doubleSpendRejected'] });
  }, 60_000);

  it('catches the mint that publishes keys its keyset ids do not derive from', async () => {
    const r = await probe(mints.keyset);
    expect(r.checks.keysetIds.ok).toBe(false);
    expect(score(r)).toMatchObject({ total: 0, alerts: ['keysetIds'] });
  }, 60_000);
});
