// Shared URL checks for mint endpoints and mint-provided icon URLs (NUT-06).
import { lookup as dnsCallbackLookup, type LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

export type MintUrlOptions = { allowLocal?: boolean };

/** Non-public address ranges (loopback included). BlockList checks IPv4-mapped IPv6 (::ffff:a.b.c.d) against the
 * IPv4 rules; the other IPv6 ranges that embed an IPv4 address (compatible, translated, NAT64, 6to4, Teredo) are
 * refused whole, as are site-local and discard-only. */
const RESERVED = blockList(
  [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]],
  [['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['100::', 64]],
);
const LOOPBACK = blockList([['127.0.0.0', 8]], [['::1', 128]]);

function blockList(v4: Array<[string, number]>, v6: Array<[string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

/** True for an IP literal in `list`; host names never match. */
function listed(list: BlockList, host: string): boolean {
  const family = isIP(host);
  return family !== 0 && list.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || listed(LOOPBACK, h);
}

/** True for an IP literal in a non-public range; host names are left to the DNS check. */
const isPrivateOrReserved = (host: string) => listed(RESERVED, host);

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

/** True when a resolved address may be connected to: public, or loopback with `allowLocal`. */
const allowedAddress = (address: string, allowLocal: boolean) => (isLoopback(address) ? allowLocal : !isPrivateOrReserved(address));

export type Lookup = (host: string, options: { all: true }) => Promise<Array<{ address: string }>>;

/** Resolves the mint host and throws unless every address is public (or loopback with `{ allowLocal: true }`),
 * so a public name pointing at an internal address cannot be audited. */
export async function assertMintAddresses(url: string, { allowLocal = false }: MintUrlOptions = {}, lookup: Lookup = dnsLookup): Promise<void> {
  const { hostname, origin } = new URL(url);
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length) throw new Error(`mint URL does not resolve: ${origin}`);
  if (!addresses.every(({ address }) => allowedAddress(address, allowLocal))) {
    throw new Error(`mint URL resolves to a private or reserved address: ${origin}`);
  }
}

export type CallbackLookup = (host: string, options: { all: true }, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void;

/** HTTP agent that repeats the address check on the lookup of every connection, so a name that passed
 * assertMintAddresses cannot rebind to an internal address before the request goes out. */
export function mintAgent({ allowLocal = false }: MintUrlOptions = {}, lookup: CallbackLookup = dnsCallbackLookup): Agent {
  const guarded: LookupFunction = (host, options, callback) =>
    lookup(host, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      if (!addresses.length || !addresses.every(({ address }) => allowedAddress(address, allowLocal))) {
        return callback(new Error(`mint host resolves to a private or reserved address: ${host}`), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  return new Agent({ connect: { lookup: guarded } });
}
