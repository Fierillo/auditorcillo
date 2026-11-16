// Shared URL checks for mint endpoints and mint-provided icon URLs (NUT-06).
export type MintUrlOptions = { allowLocal?: boolean };

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const p = ipv4(h);
  return !!p && p[0] === 127;
}

function isPrivateOrReserved(host: string): boolean {
  const h = host.toLowerCase();
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mappedDotted) return isLoopback(mappedDotted[1]) || isPrivateOrReserved(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    return isLoopback(ip) || isPrivateOrReserved(ip);
  }
  const p = ipv4(h);
  if (p) {
    const [a, b] = p;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
  }
  return false;
}

/** Throws unless `url` is https to a public host, or loopback with `{ allowLocal: true }`. */
export function assertMintUrl(url: string, { allowLocal = false }: MintUrlOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid mint URL: ${url}`);
  }
  if (parsed.username || parsed.password) throw new Error(`mint URL must not include credentials: ${parsed.origin}`);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLoopback(host)) {
    if (!allowLocal) throw new Error(`local mint URL is not allowed: ${parsed.origin}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`mint URL must be http or https: ${parsed.origin}`);
    return;
  }
  if (parsed.protocol !== 'https:') throw new Error(`mint URL must be https: ${parsed.origin}`);
  if (isPrivateOrReserved(host)) throw new Error(`mint URL must not be a private or reserved address: ${parsed.origin}`);
}

