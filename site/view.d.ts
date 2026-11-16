export function scoreTier(score: number): 'high' | 'mid' | 'low';
export function barPercent(value: number | null | undefined): number;
export function partPercent(
  part: number | null | undefined,
  weight: number | null | undefined,
): number;
export function formatScore(value: number | null | undefined): string;
export function checkSummary(
  checks: Record<string, { ok: boolean }> | null | undefined,
): { passed: number; total: number };
export function isHighlightedRank(index: number, total: number): boolean;
export function checkTier(passed: number, total: number): 'ok' | 'mid' | 'fail' | null;
