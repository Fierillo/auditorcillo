// Adapter: the MintPort operations implemented with cashu-ts. No protocol code lives here.
import { randomBytes } from 'node:crypto';
import { Amount, Keyset, Mint, Wallet, hasValidDleq, hashToCurve, type Proof } from '@cashu/cashu-ts';
import type { MintPort } from './probe.ts';

type RawNut = { supported?: unknown; methods?: unknown[]; disabled?: boolean };

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


/** NUT numbers a mint announces in /v1/info: `supported` ones plus NUT-04/05 when enabled with a method. */
export function announcedNuts(nuts: Record<string, RawNut>): number[] {
  return Object.entries(nuts)
    .filter(([n, v]) => /^\d+$/.test(n) && (Array.isArray(v.supported) ? v.supported.length > 0 : v.supported === true || (!!v.methods?.length && !v.disabled)))
    .map(([n]) => Number(n));
}

export function cashuPort(url: string, opts: MintUrlOptions = {}): MintPort {
  assertMintUrl(url, opts);
  // Public reads go through Mint, which doesn't validate keysets, so a cheating mint is reported, not refused.
  const mint = new Mint(url);
  let loaded: Promise<Wallet> | undefined;
  const wallet = () =>
    (loaded ??= (async () => {
      const w = new Wallet(mint); // unit 'sat'
      await w.loadMint();
      return w;
    })());

  return {
    async info() {
      const i = await mint.getInfo();
      return { ...i, contact: i.contact ?? [], nuts: announcedNuts(i.nuts as Record<string, RawNut>) };
    },
    async keys() {
      const { keysets } = await mint.getKeys();
      return keysets.map((k) => ({ id: k.id, valid: Keyset.verifyKeysetId(k) }));
    },
    async keysets() {
      return (await mint.getKeySets()).keysets.filter((k) => k.unit === 'sat');
    },
    async createMintQuote(amount) {
      const { quote, request } = await mint.createMintQuoteBolt11({ amount: Amount.from(amount), unit: 'sat' });
      return { quote, request };
    },
    async isMintQuotePaid(quote) {
      return (await mint.checkMintQuoteBolt11(quote)).state !== 'UNPAID';
    },
    async createMeltQuote(invoice) {
      const { amount } = await mint.createMeltQuoteBolt11({ request: invoice, unit: 'sat' });
      return { amount: Amount.from(amount).toNumber() };
    },
    async unknownProofIsUnspent() {
      const Y = hashToCurve(randomBytes(32)).toHex(true);
      const { states } = await mint.check({ Ys: [Y] });
      return states.length === 1 && states[0].state === 'UNSPENT';
    },
    async mint(amount, quote) {
      const w = await wallet();
      const proofs = await w.mintProofsBolt11(amount, quote);
      const dleqValid = proofs.every((p) => hasValidDleq(p, w.keyChain.getKeyset(p.id), { require: true }));
      return { proofs, dleqValid };
    },
    async swap(proofs) {
      return (await wallet()).receive(proofs as Proof[]);
    },
    async melt(invoice, proofs) {
      const w = await wallet();
      const quote = await w.createMeltQuoteBolt11(invoice);
      const { send } = await w.send(quote.amount.add(quote.fee_reserve), proofs as Proof[], { includeFees: true });
      const { quote: done } = await w.meltProofsBolt11(quote, send);
      return { paid: done.state === 'PAID', inputs: send };
    },
    async allSpent(proofs) {
      const states = await (await wallet()).checkProofsStates(proofs as Proof[]);
      return states.length === proofs.length && states.every((s) => s.state === 'SPENT');
    },
  };
}
