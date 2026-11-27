import { describe, expect, it } from 'vitest';
import {
  barPercent,
  checkSummary,
  checkTier,
  feeView,
  partCell,
  formatBuenosAiresTime,
  formatScore,
  headerMorph,
  isHighlightedRank,
  isScoredPart,
  isSafeIconUrl,
  matchesMint,
  mintInitials,
  normalizeQuery,
  openFaqTarget,
  parseLinkedText,
  partPercent,
  scoreTier,
  splitChecks,
  toTen,
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

describe('isScoredPart', () => {
  it('is true only for a part with a positive weight, so a 0 or missing weight reads as not measured', () => {
    expect(isScoredPart(15)).toBe(true);
    expect(isScoredPart(0)).toBe(false);
    expect(isScoredPart(undefined)).toBe(false);
    expect(isScoredPart(null)).toBe(false);
    expect(isScoredPart(Number.NaN)).toBe(false);
    expect(isScoredPart(-5)).toBe(false);
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

  it('counts checks a timed-out probe never ran as not passed', () => {
    expect(checkSummary({ mintQuote: { ok: true }, meltQuote: { ok: true }, checkState: { ok: true } }, [4, 12, 3, 3, 5, 7])).toEqual({
      passed: 3,
      total: 9,
    });
    expect(checkSummary({ mintQuote: { ok: true } }, [])).toEqual({ passed: 1, total: 1 });
    expect(checkSummary({ mintQuote: { ok: true } }, undefined)).toEqual({ passed: 1, total: 1 });
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

describe('toTen', () => {
  it('converts a 0–max score to a 0–10 scale with one decimal', () => {
    expect(toTen(100, 100)).toBe(10);
    expect(toTen(98, 100)).toBe(9.8);
    expect(toTen(50, 100)).toBe(5);
    expect(toTen(40, 40)).toBe(10);
    expect(toTen(20, 40)).toBe(5);
    expect(toTen(8, 10)).toBe(8);
  });

  it('keeps a true zero as 0 and clamps a positive value that would round below 1 up to 1', () => {
    expect(toTen(0, 100)).toBe(0);
    expect(toTen(0, 40)).toBe(0);
    expect(toTen(4, 100)).toBe(1);
    expect(toTen(9, 100)).toBe(1);
    expect(toTen(10, 100)).toBe(1);
  });

  it('caps values above the maximum at 10 and treats missing input as no score', () => {
    expect(toTen(150, 100)).toBe(10);
    expect(toTen(null, 100)).toBe(null);
    expect(toTen(50, 0)).toBe(null);
    expect(toTen(50, null)).toBe(null);
    expect(toTen(Number.NaN, 100)).toBe(null);
  });
});

describe('normalizeQuery', () => {
  it('trims, lowercases and strips accents so a search can match loosely', () => {
    expect(normalizeQuery('  CúBA  ')).toBe('cuba');
    expect(normalizeQuery('Minibits')).toBe('minibits');
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery(null)).toBe('');
  });
});

describe('matchesMint', () => {
  it('matches a mint when the query is empty or appears in the name or URL', () => {
    expect(matchesMint('Mint Cuba Bitcoin', 'https://mint.cubabitcoin.org', '')).toBe(true);
    expect(matchesMint('Mint Cuba Bitcoin', 'https://mint.cubabitcoin.org', '  ')).toBe(true);
    expect(matchesMint('Mint Cuba Bitcoin', 'https://mint.cubabitcoin.org', 'cúba')).toBe(true);
    expect(matchesMint('Minibits mint', 'https://mint.minibits.cash/Bitcoin', 'MINIBITS.CASH')).toBe(true);
    expect(matchesMint('21Mint', 'https://21mint.me', 'coinos')).toBe(false);
  });
});

describe('mintInitials', () => {
  it('takes two letters from the name, or from the URL host when the name is missing', () => {
    expect(mintInitials('Mint Cuba Bitcoin', 'https://mint.cubabitcoin.org')).toBe('MC');
    expect(mintInitials('21Mint', 'https://21mint.me')).toBe('21');
    expect(mintInitials('macadamia Mint', 'https://mint.macadamia.cash')).toBe('MM');
    expect(mintInitials(null, 'https://mint.minibits.cash/Bitcoin')).toBe('MI');
    expect(mintInitials('  ', 'https://www.21mint.me')).toBe('21');
    expect(mintInitials(null, 'not a url')).toBe('?');
  });
});

describe('isSafeIconUrl', () => {
  it('allows only https URLs without credentials, so the page can set img.src safely', () => {
    expect(isSafeIconUrl('https://cdn.example.com/icon.png')).toBe(true);
    expect(isSafeIconUrl('http://cdn.example.com/icon.png')).toBe(false);
    expect(isSafeIconUrl('https://user:pass@cdn.example.com/icon.png')).toBe(false);
    expect(isSafeIconUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeIconUrl('not a url')).toBe(false);
    expect(isSafeIconUrl(undefined)).toBe(false);
    expect(isSafeIconUrl('')).toBe(false);
  });
});

describe('parseLinkedText', () => {
  it('returns a single text part when there are no link tokens', () => {
    expect(parseLinkedText('Ranking of Cashu mints.')).toEqual([{ type: 'text', value: 'Ranking of Cashu mints.' }]);
    expect(parseLinkedText('')).toEqual([]);
    expect(parseLinkedText(undefined)).toEqual([]);
  });

  it('splits explicit [id]label[/id] tokens into text and link parts', () => {
    expect(parseLinkedText('Ranking of [faq-cashu]Cashu[/faq-cashu] [faq-cashu]mints[/faq-cashu].')).toEqual([
      { type: 'text', value: 'Ranking of ' },
      { type: 'link', id: 'faq-cashu', value: 'Cashu' },
      { type: 'text', value: ' ' },
      { type: 'link', id: 'faq-cashu', value: 'mints' },
      { type: 'text', value: '.' },
    ]);
  });

  it('keeps malformed markup and HTML as plain text', () => {
    expect(parseLinkedText('[faq-cashu]Cashu')).toEqual([{ type: 'text', value: '[faq-cashu]Cashu' }]);
    expect(parseLinkedText('[faq-cashu]Cashu[/faq-score]')).toEqual([{ type: 'text', value: '[faq-cashu]Cashu[/faq-score]' }]);
    expect(parseLinkedText('<a href="https://evil">x</a>')).toEqual([{ type: 'text', value: '<a href="https://evil">x</a>' }]);
  });
});

describe('openFaqTarget', () => {
  it('opens the details element whose id matches a #faq- hash', () => {
    const details = { tagName: 'DETAILS', open: false };
    const root = { getElementById: (id: string) => (id === 'faq-score' ? details : null) };
    expect(openFaqTarget('#faq-score', root)).toBe(true);
    expect(details.open).toBe(true);
  });

  it('opens the enclosing details when the hash points at a child', () => {
    const details = { tagName: 'DETAILS', open: false };
    const child = { tagName: 'P', closest: (sel: string) => (sel === 'details' ? details : null) };
    const root = { getElementById: (id: string) => (id === 'faq-score-a' ? child : null) };
    expect(openFaqTarget('#faq-score-a', root)).toBe(true);
    expect(details.open).toBe(true);
  });

  it('closes every other open details so only the target stays expanded', () => {
    const target = { tagName: 'DETAILS', open: false };
    const other = { tagName: 'DETAILS', open: true };
    const root = {
      getElementById: (id: string) => (id === 'faq-score' ? target : null),
      querySelectorAll: (sel: string) => (sel === 'details' ? [other, target] : []),
    };
    expect(openFaqTarget('#faq-score', root)).toBe(true);
    expect(target.open).toBe(true);
    expect(other.open).toBe(false);
  });

  it('ignores hashes that are not a faq target', () => {
    const details = { tagName: 'DETAILS', open: false };
    const root = { getElementById: (id: string) => (id === 'faq' ? { tagName: 'SECTION' } : id === 'faq-score' ? details : null) };
    expect(openFaqTarget('#faq', root)).toBe(false);
    expect(openFaqTarget('#top', root)).toBe(false);
    expect(openFaqTarget('', root)).toBe(false);
    expect(openFaqTarget('#faq-score', {})).toBe(false);
    expect(details.open).toBe(false);
  });
});

describe('headerMorph', () => {
  const big = { top: 100, left: 20, width: 600 };
  const small = { top: 10, left: 40, width: 150 };

  it('keeps the big title untouched at the top of the page', () => {
    expect(headerMorph(0, big, small)).toEqual({ x: 0, scale: 1, docked: false });
  });

  it('shrinks and slides in proportion to the scroll on the way to the header', () => {
    expect(headerMorph(45, big, small)).toEqual({ x: 10, scale: 0.625, docked: false });
  });

  it('lands exactly on the header mark and docks once the distance is covered', () => {
    expect(headerMorph(90, big, small)).toEqual({ x: 20, scale: 0.25, docked: true });
    expect(headerMorph(500, big, small)).toEqual({ x: 20, scale: 0.25, docked: true });
  });

  it('docks right away when the title starts at or above the header', () => {
    expect(headerMorph(0, { ...big, top: 5 }, small)).toEqual({ x: 20, scale: 0.25, docked: true });
  });

  it('leaves the title untouched when a size is zero or not a number', () => {
    const still = { x: 0, scale: 1, docked: false };
    expect(headerMorph(45, { ...big, width: 0 }, small)).toEqual(still);
    expect(headerMorph(45, { ...big, width: Number.NaN }, small)).toEqual(still);
    expect(headerMorph(45, big, { ...small, width: Number.POSITIVE_INFINITY })).toEqual(still);
    expect(headerMorph(Number.NaN, big, small)).toEqual(still);
  });

  it('treats negative scroll (overscroll bounce) as the top', () => {
    expect(headerMorph(-30, big, small)).toEqual({ x: 0, scale: 1, docked: false });
  });
});

describe('formatBuenosAiresTime', () => {
  it('formats a valid ISO timestamp in Buenos Aires time and returns null on missing or invalid input', () => {
    const iso = '2026-11-24T12:17:00.000Z';
    const en = formatBuenosAiresTime(iso, 'en');
    const es = formatBuenosAiresTime(iso, 'es');
    expect(en).toContain('09:17');
    expect(es).toContain('9:17');
    expect(formatBuenosAiresTime(null, 'en')).toBeNull();
    expect(formatBuenosAiresTime('', 'es')).toBeNull();
    expect(formatBuenosAiresTime('not-a-date', 'en')).toBeNull();
  });
});

describe('splitChecks', () => {
  it('separates checks by the cycle flag written in ranking.json, not by a hard-coded name list', () => {
    const { publicChecks, cycleChecks } = splitChecks({
      keysetIds: { ok: true, cycle: true },
      mintQuote: { ok: true },
      minted: { ok: true },
      doubleSpendRejected: { ok: true, cycle: true },
      melted: { ok: false, cycle: true },
    });
    expect(publicChecks.map(([k]) => k)).toEqual(['mintQuote', 'minted']);
    expect(cycleChecks.map(([k]) => k)).toEqual(['keysetIds', 'doubleSpendRejected', 'melted']);
    expect(splitChecks(null)).toEqual({ publicChecks: [], cycleChecks: [] });
  });
});

describe('feeView', () => {
  it('shows the fee the mint declares, per token in sats', () => {
    expect(feeView(undefined, 100, 'es')).toEqual({ key: 'feeDeclared', vars: { sats: '0,1' } });
    expect(feeView(undefined, 100, 'en')).toEqual({ key: 'feeDeclared', vars: { sats: '0.1' } });
    expect(feeView(undefined, 2500, 'en').vars).toEqual({ sats: '2.5' });
    expect(feeView(undefined, 0, 'es')).toEqual({ key: 'feeDeclaredFree', vars: {} });
  });

  it('prefers a fee measured with real sats over the declared one', () => {
    expect(feeView({ keptPct: 1.25 }, 100, 'es')).toEqual({ key: 'feeMeasured', vars: { pct: '1,25' } });
    expect(feeView({ keptPct: 0 }, undefined, 'en')).toEqual({ key: 'feeMeasured', vars: { pct: '0' } });
  });

  it('says not measured when there is nothing valid, as in an older ranking.json', () => {
    const none = { key: 'partNotMeasured', vars: {} };
    expect(feeView(undefined, undefined, 'es')).toEqual(none);
    expect(feeView(null, null, 'en')).toEqual(none);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(feeView({ keptPct: bad }, bad, 'en'), String(bad)).toEqual(none);
    }
    expect(feeView(undefined, 1.5, 'en')).toEqual(none);
  });
});

describe('partCell', () => {
  const fee = { key: 'feeMeasured', vars: { pct: '1' } };

  it('always shows the fee view for fees, and a bar only once fees weigh in the score', () => {
    expect(partCell('fees', 0, 0, fee)).toEqual({ text: fee, percent: null });
    expect(partCell('fees', 28, 35, fee)).toEqual({ text: fee, percent: 80 });
  });

  it('shows the score of a weighed part and says not measured for a part that weighs 0', () => {
    expect(partCell('nuts', 15, 30, fee)).toEqual({ text: null, percent: 50 });
    expect(partCell('info', 0, 0, fee)).toEqual({ text: { key: 'partNotMeasured', vars: {} }, percent: null });
  });
});
