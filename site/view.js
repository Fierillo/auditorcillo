export function scoreTier(score) {
  if (score >= 80) return 'high';
  if (score >= 50) return 'mid';
  return 'low';
}

export function barPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function partPercent(part, weight) {
  if (typeof part !== 'number' || typeof weight !== 'number' || !Number.isFinite(part) || !Number.isFinite(weight) || weight <= 0) {
    return 0;
  }
  return barPercent((part / weight) * 100);
}

export function formatScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return (Math.round(value * 10) / 10).toString();
}

export function checkSummary(checks) {
  const list = Object.values(checks ?? {});
  return { passed: list.filter((c) => c.ok).length, total: list.length };
}

export function isHighlightedRank(index, total) {
  return index < 3 && total > 0;
}

export function checkTier(passed, total) {
  if (!total) return null;
  if (passed === total) return 'ok';
  if (passed === 0) return 'fail';
  return 'mid';
}
