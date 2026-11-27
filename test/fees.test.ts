import { describe, expect, it } from 'vitest';
import { isFeePpk } from '../site/fees.js';

describe('isFeePpk', () => {
  it('accepts a NUT-02 input fee: a whole number of thousandths of a sat, 0 or more', () => {
    for (const ok of [0, 1, 100, 2500]) expect(isFeePpk(ok), String(ok)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '100', null, undefined]) expect(isFeePpk(bad), String(bad)).toBe(false);
  });
});
