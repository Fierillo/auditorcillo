import { describe, expect, it, vi } from 'vitest';
import { audit, parsePrevious, rankingJson, RANKING_MAX_BYTES, writeAtomic } from '../src/audit.ts';
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
      payTimeoutMs: 1,
    };
    const out = await audit(['https://good', 'https://garbage', 'not-a-url'].map((url) => ({ url, cycle: false })), deps);
    expect(out.mints.map((m) => m.url).sort()).toEqual(['https://garbage', 'https://good', 'not-a-url']);
    expect(out.mints.find((m) => m.url === 'not-a-url')).toMatchObject({ online: false, error: expect.stringMatching(/invalid mint URL/) });
    expect(out.mints.find((m) => m.url === 'https://garbage')).toMatchObject({ online: true, name: null, version: null });
  });

  it('refuses to serialize a ranking larger than the size cap', () => {
    const huge = { generatedAt: 't', weights: SCORE.weights, mints: [{ error: 'x'.repeat(RANKING_MAX_BYTES) }] };
    expect(() => rankingJson(huge as never)).toThrow(/ranking\.json is \d+ bytes, exceeds /);
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
});

describe('writeAtomic', () => {
  it('writes a temporary file next to the target and renames it over the target', async () => {
    const calls: string[] = [];
    const fs = {
      writeFile: vi.fn(async (path: string) => void calls.push(`write ${path}`)),
      rename: vi.fn(async (from: string, to: string) => void calls.push(`rename ${from} ${to}`)),
    };
    await writeAtomic('site/ranking.json', '{}\n', fs);
    expect(calls).toEqual(['write site/ranking.json.tmp', 'rename site/ranking.json.tmp site/ranking.json']);
    expect(fs.writeFile).toHaveBeenCalledWith('site/ranking.json.tmp', '{}\n');
  });
});
