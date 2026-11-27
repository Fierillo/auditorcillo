import { describe, expect, it } from 'vitest';
import { isFeePpk, isKeptPct } from '../site/fees.js';

describe('isFeePpk', () => {
  it('accepts a NUT-02 input fee: a whole number of thousandths of a sat, 0 or more', () => {
    for (const ok of [0, 1, 100, 2500]) expect(isFeePpk(ok), String(ok)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '100', null, undefined]) expect(isFeePpk(bad), String(bad)).toBe(false);
  });
});

describe('isKeptPct', () => {
  it('accepts a measured share kept, in %: any finite number, 0 or more', () => {
    for (const ok of [0, 1.25, 5, 12]) expect(isKeptPct(ok), String(ok)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) expect(isKeptPct(bad), String(bad)).toBe(false);
  });
});
