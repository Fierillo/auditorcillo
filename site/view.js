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

export function toTen(value, max) {
  if (typeof value !== 'number' || typeof max !== 'number' || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return null;
  }
  if (value <= 0) return 0;
  const scaled = Math.round((value / max) * 100) / 10;
  return Math.min(10, Math.max(1, scaled));
}

export function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function matchesMint(name, url, query) {
  const q = normalizeQuery(query);
  if (!q) return true;
  return normalizeQuery(name ?? '').includes(q) || normalizeQuery(url ?? '').includes(q);
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? '';
  } catch {
    return '';
  }
}

export function mintInitials(name, url) {
  const source = typeof name === 'string' && name.trim() ? name.trim() : hostLabel(url);
  const words = source
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words[0]?.length >= 2) return words[0].slice(0, 2).toUpperCase();
  if (words[0]) return words[0][0].toUpperCase();
  return '?';
}

export function isSafeIconUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

const LINK_TOKEN = /\[([a-z][a-z0-9-]*)\](.+?)\[\/\1\]/g;

/** Splits i18n strings with [id]label[/id] tokens into text and link parts. */
export function parseLinkedText(text) {
  if (typeof text !== 'string' || !text) return [];
  const parts = [];
  let last = 0;
  LINK_TOKEN.lastIndex = 0;
  let match;
  while ((match = LINK_TOKEN.exec(text))) {
    if (match.index > last) parts.push({ type: 'text', value: text.slice(last, match.index) });
    parts.push({ type: 'link', id: match[1], value: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

/** Opens the <details> that a #faq- hash points at and closes the rest. Returns whether one was opened. */
export function openFaqTarget(hash, root) {
  if (typeof hash !== 'string' || !hash.startsWith('#faq-')) return false;
  const id = hash.slice(1);
  if (!/^[A-Za-z][\w-]*$/.test(id)) return false;
  const node = root?.getElementById?.(id);
  if (!node) return false;
  const details = node.tagName === 'DETAILS' ? node : node.closest?.('details');
  if (!details) return false;
  for (const other of root.querySelectorAll?.('details') ?? []) {
    if (other !== details) other.open = false;
  }
  details.open = true;
  return true;
}
