import { describe, expect, it } from 'vitest';
import {
  barPercent,
  checkSummary,
  checkTier,
  formatScore,
  isHighlightedRank,
  partPercent,
  scoreTier,
} from '../site/view.js';

describe('scoreTier', () => {
  it('marks 80 and above as high, 50 up to 80 as mid, and the rest as low', () => {
    expect(scoreTier(100)).toBe('high');
    expect(scoreTier(80)).toBe('high');
    expect(scoreTier(79.9)).toBe('mid');
    expect(scoreTier(50)).toBe('mid');
    expect(scoreTier(49.9)).toBe('low');
    expect(scoreTier(0)).toBe('low');
  });
});

describe('barPercent', () => {
  it('clamps a finite number to the 0–100 range used as a CSS width', () => {
    expect(barPercent(0)).toBe(0);
    expect(barPercent(50)).toBe(50);
    expect(barPercent(100)).toBe(100);
    expect(barPercent(120)).toBe(100);
    expect(barPercent(-10)).toBe(0);
  });

  it('treats missing or non-finite values as an empty bar', () => {
    expect(barPercent(null)).toBe(0);
    expect(barPercent(undefined)).toBe(0);
    expect(barPercent(Number.NaN)).toBe(0);
    expect(barPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('partPercent', () => {
  it('expresses a score part as a percentage of its weight', () => {
    expect(partPercent(20, 40)).toBe(50);
    expect(partPercent(40, 40)).toBe(100);
    expect(partPercent(0, 40)).toBe(0);
  });

  it('returns 0 when the weight is missing or not positive', () => {
    expect(partPercent(10, 0)).toBe(0);
    expect(partPercent(10, -40)).toBe(0);
    expect(partPercent(null, 40)).toBe(0);
    expect(partPercent(10, null)).toBe(0);
  });
});

describe('formatScore', () => {
  it('renders a score with at most one decimal', () => {
    expect(formatScore(100)).toBe('100');
    expect(formatScore(98.46)).toBe('98.5');
    expect(formatScore(98.44)).toBe('98.4');
    expect(formatScore(0)).toBe('0');
  });

  it('renders an em dash when the value is missing', () => {
    expect(formatScore(null)).toBe('—');
    expect(formatScore(undefined)).toBe('—');
    expect(formatScore(Number.NaN)).toBe('—');
  });
});

describe('checkSummary', () => {
  it('counts how many checks passed out of those that ran', () => {
    expect(
      checkSummary({
        mintQuote: { ok: true },
        meltQuote: { ok: true },
        swap: { ok: false },
      }),
    ).toEqual({ passed: 2, total: 3 });
  });

  it('treats a missing or empty checks object as zero of zero', () => {
    expect(checkSummary({})).toEqual({ passed: 0, total: 0 });
    expect(checkSummary(undefined)).toEqual({ passed: 0, total: 0 });
  });
});

describe('isHighlightedRank', () => {
  it('highlights only the first three places with a positive score', () => {
    expect(isHighlightedRank(0, 100)).toBe(true);
    expect(isHighlightedRank(2, 50)).toBe(true);
    expect(isHighlightedRank(3, 100)).toBe(false);
    expect(isHighlightedRank(0, 0)).toBe(false);
    expect(isHighlightedRank(1, 0)).toBe(false);
  });
});

describe('checkTier', () => {
  it('is ok when every check passed, mid when some did, fail when none did, and null when none ran', () => {
    expect(checkTier(5, 5)).toBe('ok');
    expect(checkTier(3, 5)).toBe('mid');
    expect(checkTier(0, 5)).toBe('fail');
    expect(checkTier(0, 0)).toBe(null);
  });
});
