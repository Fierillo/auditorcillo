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
export function toTen(value: number | null | undefined, max: number | null | undefined): number | null;
export function normalizeQuery(value: string | null | undefined): string;
export function matchesMint(
  name: string | null | undefined,
  url: string | null | undefined,
  query: string | null | undefined,
): boolean;
export function mintInitials(name: string | null | undefined, url: string | null | undefined): string;
export function isSafeIconUrl(value: string | null | undefined): boolean;
export type LinkedTextPart =
  | { type: 'text'; value: string }
  | { type: 'link'; id: string; value: string };
export function parseLinkedText(text: string | null | undefined): LinkedTextPart[];
export function openFaqTarget(hash: string, root: { getElementById?: (id: string) => { tagName: string; closest?: (selector: string) => { open: boolean } | null } | null; querySelectorAll?: (selector: string) => Iterable<{ open: boolean }> }): boolean;
export function headerMorph(
  scrollY: number,
  big: { top: number; left: number; width: number },
  small: { top: number; left: number; width: number },
): { x: number; scale: number; docked: boolean };
