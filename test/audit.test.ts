import { describe, expect, it } from 'vitest';
import { audit, rankingJson, RANKING_MAX_BYTES } from '../src/audit.ts';
import type { MintPort, ProbeDeps } from '../src/probe.ts';
import { SCORE } from '../src/score.ts';

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
    const deps: ProbeDeps = { port: (url) => ports[url], now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1 };
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
    const deps: ProbeDeps = { port: () => reachable(10, now), now: () => now.t, sleep: async () => {}, amount: 8, payTimeoutMs: 1 };
    const old = Array.from({ length: SCORE.historyRuns }, (_, i) => i % 2 === 0);
    const previous = { mints: [{ url: 'https://kept', history: old }] };
    const out = await audit([{ url: 'https://kept', cycle: false }, { url: 'https://new', cycle: false }], deps, previous);
    const history = Object.fromEntries(out.mints.map((m) => [m.url, m.history]));
    expect(history['https://kept']).toEqual([...old.slice(1), true]);
    expect(history['https://new']).toEqual([true]);
    expect(out.mints.find((m) => m.url === 'https://kept')?.uptime).toBe(50);
    expect(out.mints.find((m) => m.url === 'https://new')?.uptime).toBe(100);
  });

  it('refuses to serialize a ranking larger than the size cap', () => {
    const huge = { generatedAt: 't', weights: SCORE.weights, mints: [{ error: 'x'.repeat(RANKING_MAX_BYTES) }] };
    expect(() => rankingJson(huge as never)).toThrow(/ranking\.json is \d+ bytes, exceeds /);
  });
});
