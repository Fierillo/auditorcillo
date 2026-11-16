// Adapter: the MintPort operations implemented with cashu-ts. No protocol code lives here.
import { randomBytes } from 'node:crypto';
import { Amount, Keyset, Mint, Wallet, hasValidDleq, hashToCurve, type Proof } from '@cashu/cashu-ts';
import type { MintPort } from './probe.ts';
import { assertMintUrl, type MintUrlOptions } from './url.ts';

type RawNut = { supported?: unknown; methods?: unknown[]; disabled?: boolean };

export { assertMintUrl, type MintUrlOptions };


/** More than any real mint announces; keeps a hostile list from bloating ranking.json. */
export const NUTS_MAX = 64;

/** NUT numbers a mint announces in /v1/info: `supported` ones plus NUT-04/05 when enabled with a method.
 * Only distinct plain numbers 0..999, at most NUTS_MAX; anything malformed is ignored. */
export function announcedNuts(nuts: unknown): number[] {
  if (typeof nuts !== 'object' || nuts === null || Array.isArray(nuts)) return [];
  return Object.entries(nuts as Record<string, RawNut | null>)
    .filter(([n, v]) => /^(0|[1-9]\d{0,2})$/.test(n) && typeof v === 'object' && v !== null && (Array.isArray(v.supported) ? v.supported.length > 0 : v.supported === true || (!!v.methods?.length && !v.disabled)))
    .slice(0, NUTS_MAX)
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
      return { ...i, nuts: announcedNuts(i.nuts) };
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
