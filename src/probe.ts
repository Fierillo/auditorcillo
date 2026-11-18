import { assertMintUrl } from './url.ts';
import type { CheckResult, Observation } from './score.ts';

/** The mint operations the auditor needs; src/cashu.ts implements them with cashu-ts. */
export type MintPort = {
  /** NUT-06 fields come straight from the mint and are untrusted; only `nuts` is already parsed. */
  info(): Promise<{ name?: unknown; pubkey?: unknown; version?: unknown; description?: unknown; icon_url?: unknown; website?: unknown; urls?: unknown; contact?: unknown; nuts: number[] }>;
  /** GET /v1/keys; `valid` = the id derives from the published keys (NUT-02). */
  keys(): Promise<Array<{ id: string; valid: boolean }>>;
  /** GET /v1/keysets */
  keysets(): Promise<Array<{ id: string; active: boolean }>>;
  createMintQuote(amount: number): Promise<{ quote: string; request: string }>;
  isMintQuotePaid(quote: string): Promise<boolean>;
  createMeltQuote(invoice: string): Promise<{ amount: number }>;
  /** NUT-07 on a proof the mint never signed must answer UNSPENT. */
  unknownProofIsUnspent(): Promise<boolean>;
  mint(amount: number, quote: string): Promise<{ proofs: unknown[]; dleqValid: boolean }>;
  /** Spends `proofs` for fresh ones (NUT-03); an honest mint throws if they were already spent. */
  swap(proofs: unknown[]): Promise<unknown[]>;
  /** `inputs` are the proofs actually handed to the mint for the melt. */
  melt(invoice: string, proofs: unknown[]): Promise<{ paid: boolean; inputs: unknown[] }>;
  allSpent(proofs: unknown[]): Promise<boolean>;
};

/** A real Lightning wallet (NWC) to pay mint quotes and receive melts on mints without FakeWallet. */
export type LightningWallet = {
  /** Both stop waiting, and never send a request, once `signal` aborts. */
  payInvoice(invoice: string, signal?: AbortSignal): Promise<void>;
  makeInvoice(sats: number, signal?: AbortSignal): Promise<string>;
};

export type ProbeDeps = {
  port(url: string): MintPort;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Sats minted per cycle; the melt pays an invoice for half of it so fees fit. */
  amount: number;
  /** How long to wait for the mint to report its quote paid; fits inside mintTimeoutMs. */
  payTimeoutMs: number;
  /** Total time each mint gets for the whole probe, the same for every mint. */
  mintTimeoutMs: number;
  wallet?: LightningWallet;
};

/** `cycle: true` = FakeWallet mint: the full cycle is free and never touches the real wallet. */
export type MintTarget = { url: string; cycle: boolean };

export type ProbeResult = Observation & {
  url: string;
  name: string | null;
  version: string | null;
  nuts: number[];
  checkedAt: string;
  checks: Record<string, CheckResult & { error?: string }>;
  error: string | null;
  /** NUT-06 icon, only set when it is a public https URL within the text cap. */
  iconUrl?: string;
  /** Mint website: NUT-06 `website` or first safe `urls` entry, else the mint URL origin. */
  websiteUrl?: string;
  /** Set when the time limit cut the probe short. */
  incomplete?: true;
};

/** Settles like `work`, or rejects with the abort reason as soon as `signal` aborts. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}


/** BOLT11 amount in sats, or null if the invoice is any-amount, unparseable or not a whole number of sats. */
export function invoiceSats(invoice: string): number | null {
  const prefix = /^ln[a-z]*/i.exec(invoice);
  if (!prefix) return null;
  const amount = /^(\d+)([munp])?(?:1|$)/i.exec(invoice.slice(prefix[0].length));
  if (!amount) return null;
  const n = BigInt(amount[1]);
  const mul = amount[2]?.toLowerCase();
  const picos = mul === 'p' ? n
    : mul === 'n' ? n * 1000n
    : mul === 'u' ? n * 1_000_000n
    : mul === 'm' ? n * 1_000_000_000n
    : n * 1_000_000_000_000n;
  if (picos % 10_000n !== 0n) return null;
  const sats = picos / 10_000n;
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(sats);
}

export const MINT_TEXT_MAX = 200;
export const MINT_ERROR_MAX = 500;
/** A non-null object: the shape check every untrusted JSON value goes through first. */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max));
const mintText = (value: unknown) => (typeof value === 'string' ? clip(value, MINT_TEXT_MAX) : null);
const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';
/** NUT-06 pubkey: a compressed secp256k1 point in hex. */
const isPubkey = (value: unknown) => typeof value === 'string' && /^0[23][0-9a-f]{64}$/i.test(value);
/** NUT-06 contact: a list of `{ method, info }`; anything else counts as no contact. */
const hasContact = (contact: unknown) =>
  Array.isArray(contact) && contact.some((c) => isObject(c) && filled(c.info));

/** A public https URL no longer than other mint text, or undefined. */
export function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (!url || url.length > MINT_TEXT_MAX) return undefined;
  try {
    assertMintUrl(url);
    return url;
  } catch {
    return undefined;
  }
}

/** Keeps a NUT-06 icon_url only if it is a public https URL no longer than other mint text. */
export function mintIconUrl(value: unknown): string | undefined {
  return publicHttpsUrl(value);
}

/** NUT-06 website, then the first safe entry in `urls`, then the mint URL's https origin. */
export function mintWebsiteUrl(info: { website?: unknown; urls?: unknown } | null | undefined, mintUrl: string): string | undefined {
  const direct = publicHttpsUrl(info?.website);
  if (direct) return direct;
  if (Array.isArray(info?.urls)) {
    for (const value of info.urls) {
      const url = publicHttpsUrl(value);
      if (url) return url;
    }
  }
  try {
    return publicHttpsUrl(new URL(mintUrl).origin);
  } catch {
    return undefined;
  }
}

const POLL_MS = 500;
const MANDATORY_NUTS = [1, 2, 3, 4, 5, 6];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function probeMint(target: MintTarget, deps: ProbeDeps): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(deps.mintTimeoutMs);
  const r: ProbeResult = {
    url: target.url,
    name: null,
    version: null,
    nuts: [],
    checkedAt: new Date(deps.now()).toISOString(),
    online: false,
    latencyMs: null,
    info: {},
    checks: {},
    error: null,
  };
  const websiteUrl = mintWebsiteUrl(undefined, target.url);
  if (websiteUrl) r.websiteUrl = websiteUrl;
  const timed = async <T>(read: () => Promise<T>, ms: number[]) => {
    const start = deps.now();
    const value = await abortable(read(), signal);
    ms.push(deps.now() - start);
    return value;
  };

  /** A probe cut off by the time limit is incomplete: score() counts its missing critical checks as failed. */
  const done = () => {
    if (signal.aborted) r.incomplete = true;
    return r;
  };

  let port: MintPort;
  let reads;
  try {
    port = deps.port(target.url);
    const ms: number[] = [];
    reads = { info: await timed(port.info, ms), keys: await timed(port.keys, ms), keysets: await timed(port.keysets, ms) };
    r.latencyMs = ms.sort((a, b) => a - b)[1];
    r.online = true;
  } catch (e) {
    r.error = clip(message(e), MINT_ERROR_MAX);
    return done();
  }
  const { info, keys, keysets } = reads;
  r.name = mintText(info.name);
  r.version = mintText(info.version);
  r.nuts = info.nuts;
  const iconUrl = mintIconUrl(info.icon_url);
  if (iconUrl) r.iconUrl = iconUrl;
  const fromInfo = mintWebsiteUrl(info, target.url);
  if (fromInfo) r.websiteUrl = fromInfo;
  r.info = {
    name: filled(info.name),
    pubkey: isPubkey(info.pubkey),
    version: filled(info.version),
    description: filled(info.description),
    contact: hasContact(info.contact),
  };

  const announced = (nut: number) => MANDATORY_NUTS.includes(nut) || info.nuts.includes(nut);
  /** Runs a check only if its NUT is announced; a throw fails it. Returns whether it passed. */
  const check = async (name: string, nut: number, run: () => Promise<boolean>) => {
    if (!announced(nut)) return true;
    if (signal.aborted) return false;
    try {
      r.checks[name] = { nut, ok: await abortable(run(), signal) };
    } catch (e) {
      r.checks[name] = { nut, ok: false, error: clip(message(e), MINT_ERROR_MAX) };
      r.error ??= clip(`${name}: ${message(e)}`, MINT_ERROR_MAX);
    }
    return r.checks[name].ok;
  };

  const keyIds = new Set(keys.map((k) => k.id));
  await check('keysetIds', 2, async () => keys.length > 0 && keys.every((k) => k.valid));
  await check('keysetsListed', 2, async () => {
    const active = keysets.filter((k) => k.active);
    return active.length > 0 && active.every((k) => keyIds.has(k.id));
  });
  let invoice = '';
  await check('mintQuote', 4, async () => {
    const { quote, request } = await port.createMintQuote(deps.amount);
    invoice = request;
    return !!quote && request.toLowerCase().startsWith('ln');
  });
  await check('meltQuote', 5, async () => (await port.createMeltQuote(invoice)).amount >= deps.amount);
  await check('checkState', 7, port.unknownProofIsUnspent);

  const wallet = target.cycle ? undefined : deps.wallet;
  if (target.cycle || wallet) {
    await cycle(port, deps, signal, wallet, check);
    // A cycle the mint broke before the double-spend check leaves it unproven, so it counts as failed.
    if (!r.checks.doubleSpendRejected) r.incomplete = true;
  }
  return done();
}

async function cycle(
  port: MintPort,
  deps: ProbeDeps,
  signal: AbortSignal,
  wallet: LightningWallet | undefined,
  check: (name: string, nut: number, run: () => Promise<boolean>) => Promise<boolean>,
) {
  let minted: { proofs: unknown[]; dleqValid: boolean } | undefined;
  let fresh: unknown[] = [];
  let meltInputs: unknown[] = [];
  const ok = await check('minted', 4, async () => {
    const { quote, request } = await port.createMintQuote(deps.amount);
    if (wallet) {
      const sats = invoiceSats(request);
      if (sats !== deps.amount) throw new Error(`mint invoice is ${sats ?? 'unspecified'} sats, expected ${deps.amount}`);
      await wallet.payInvoice(request, signal);
    }
    await waitUntilPaid(port, quote, deps, signal);
    minted = await port.mint(deps.amount, quote);
    return minted.proofs.length > 0;
  });
  if (!ok || !minted) return;
  const { proofs, dleqValid } = minted;
  await check('dleq', 12, async () => dleqValid);
  if (!(await check('swap', 3, async () => (fresh = await port.swap(proofs)).length > 0))) return;
  await check('doubleSpendRejected', 3, () => port.swap(proofs).then(() => false, () => true));
  const half = Math.floor(deps.amount / 2);
  await check('melted', 5, async () => {
    const invoice = wallet ? await wallet.makeInvoice(half, signal) : (await port.createMintQuote(half)).request;
    const { paid, inputs } = await port.melt(invoice, fresh);
    meltInputs = inputs;
    return paid;
  });
  await check('spentState', 7, () => port.allSpent([...proofs, ...meltInputs]));
}

async function waitUntilPaid(port: MintPort, quote: string, deps: ProbeDeps, signal: AbortSignal): Promise<void> {
  const deadline = deps.now() + deps.payTimeoutMs;
  while (!(await abortable(port.isMintQuotePaid(quote), signal))) {
    if (deps.now() >= deadline) throw new Error(`mint quote not paid within ${deps.payTimeoutMs} ms`);
    await abortable(deps.sleep(POLL_MS), signal);
  }
}
