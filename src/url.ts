// Shared URL checks for mint endpoints and mint-provided icon URLs (NUT-06).
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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

/** Non-public address ranges (loopback included). BlockList checks IPv4-mapped IPv6 (::ffff:a.b.c.d) against the
 * IPv4 rules; the other IPv6 ranges that embed an IPv4 address (compatible, translated, NAT64) are refused whole. */
const RESERVED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) RESERVED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) RESERVED.addSubnet(net, prefix, 'ipv6');

/** True for an IP literal in a non-public range; host names are left to the DNS check. */
function isPrivateOrReserved(host: string): boolean {
  const family = isIP(host);
  return family !== 0 && RESERVED.check(host, family === 4 ? 'ipv4' : 'ipv6');
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

export type Lookup = (host: string, options: { all: true }) => Promise<Array<{ address: string }>>;

/** Resolves the mint host and throws unless every address is public (or loopback with `{ allowLocal: true }`),
 * so a public name pointing at an internal address cannot be audited. */
export async function assertMintAddresses(url: string, { allowLocal = false }: MintUrlOptions = {}, lookup: Lookup = dnsLookup): Promise<void> {
  const { hostname, origin } = new URL(url);
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length) throw new Error(`mint URL does not resolve: ${origin}`);
  for (const { address } of addresses) {
    if (isLoopback(address) ? !allowLocal : isPrivateOrReserved(address)) {
      throw new Error(`mint URL resolves to a private or reserved address: ${origin}`);
    }
  }
}
