import { describe, expect, it } from 'vitest';
import { SCORE, rank, score, type Observation } from '../src/score.ts';

const fullInfo = { name: true, pubkey: true, version: true, description: true, contact: true };

function perfect(over: Partial<Observation> = {}): Observation {
  return {
    online: true,
    latencyMs: SCORE.latencyMs.full,
    info: fullInfo,
    checks: {
      keysetIds: { nut: 2, ok: true },
      keysetsListed: { nut: 2, ok: true },
      mintQuote: { nut: 4, ok: true },
      meltQuote: { nut: 5, ok: true },
    },
    ...over,
  };
}

describe('score', () => {
  it('weights add up to 100 so the score reads as a percentage', () => {
    expect(Object.values(SCORE.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('pins the availability latency thresholds at 300 ms full and 3000 ms slow', () => {
    expect(SCORE.latencyMs).toEqual({ full: 300, slow: 3000 });
  });

  it('gives 100 to a fast, compliant, consistent mint with complete info', () => {
    expect(score(perfect())).toMatchObject({ total: 100, alerts: [] });
  });

  it('gives nothing to an offline mint', () => {
    expect(score(perfect({ online: false, latencyMs: null })).total).toBe(0);
  });

  it('keeps full availability up to the fast threshold and halves it from the slow one', () => {
    const at = (latencyMs: number) => score(perfect({ latencyMs })).parts.availability;
    expect(at(SCORE.latencyMs.full)).toBe(SCORE.weights.availability);
    expect(at(SCORE.latencyMs.slow)).toBe(SCORE.weights.availability / 2);
    expect(at(SCORE.latencyMs.slow * 10)).toBe(SCORE.weights.availability / 2);
    const mid = at((SCORE.latencyMs.full + SCORE.latencyMs.slow) / 2);
    expect(mid).toBeLessThan(SCORE.weights.availability);
    expect(mid).toBeGreaterThan(SCORE.weights.availability / 2);
  });

  it('scales availability by the uptime seen over the recent runs', () => {
    expect(score(perfect({ history: [true, false, true, true] })).parts.availability).toBe((SCORE.weights.availability * 3) / 4);
  });

  it('splits NUT compliance and keyset consistency by the share of their checks that passed', () => {
    const { parts } = score(
      perfect({
        checks: {
          keysetIds: { nut: 2, ok: true },
          keysetsListed: { nut: 2, ok: false },
          mintQuote: { nut: 4, ok: true },
          meltQuote: { nut: 5, ok: false },
          checkState: { nut: 7, ok: true },
          swap: { nut: 3, ok: true },
        },
      }),
    );
    expect(parts.keysets).toBe(SCORE.weights.keysets / 2);
    expect(parts.nuts).toBe((SCORE.weights.nuts * 3) / 4);
  });

  it('gives info points per filled field', () => {
    const { parts } = score(perfect({ info: { ...fullInfo, contact: false, description: false } }));
    expect(parts.info).toBe((SCORE.weights.info * 3) / 5);
  });

  it('zeroes a mint that fails a critical check and says which one', () => {
    for (const name of SCORE.critical) {
      const o = perfect();
      o.checks[name] = { nut: 3, ok: false };
      expect(score(o)).toMatchObject({ total: 0, alerts: [name] });
    }
  });
});

describe('rank', () => {
  it('orders by score, then by lower latency, and keeps every mint', () => {
    const slow = { url: 'a', ...perfect({ latencyMs: 400 }) };
    const fast = { url: 'b', ...perfect({ latencyMs: 100 }) };
    const down = { url: 'c', ...perfect({ online: false, latencyMs: null }) };
    const lying = { url: 'd', ...perfect({ info: { ...fullInfo, contact: false } }) };
    expect(rank([down, lying, slow, fast]).map((r) => r.url)).toEqual(['b', 'a', 'd', 'c']);
    expect(rank([fast])[0]).toMatchObject({ url: 'b', score: { total: 100 } });
  });
});
