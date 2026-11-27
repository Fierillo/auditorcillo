import { CHECK_NUTS, CYCLE_CHECKS, PUBLIC_CHECKS } from '../site/checks.js';
import { isFeePpk } from '../site/fees.js';
import { assertMintUrl } from './url.ts';
import type { CheckResult, Observation } from './score.ts';

export { CHECK_NUTS, CYCLE_CHECKS, PUBLIC_CHECKS };

/** A GET /v1/keysets entry; `input_fee_ppk` (NUT-02) comes straight from the mint and is untrusted. */
export type MintKeysetEntry = { id: string; active: boolean; input_fee_ppk?: unknown };

/** The mint operations the auditor needs; src/cashu.ts implements them with cashu-ts. */
export type MintPort = {
  /** NUT-06 fields come straight from the mint and are untrusted; only `nuts` is already parsed. */
  info(): Promise<{ name?: unknown; pubkey?: unknown; version?: unknown; description?: unknown; icon_url?: unknown; website?: unknown; urls?: unknown; contact?: unknown; nuts: number[] }>;
  /** GET /v1/keys; `valid` = the id derives from the published keys (NUT-02). */
  keys(): Promise<Array<{ id: string; valid: boolean }>>;
  /** GET /v1/keysets */
  keysets(): Promise<MintKeysetEntry[]>;
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
  /** Both stop waiting, and never send a request, once `signal` aborts. payInvoice resolves once the wallet confirms the payment.
   * It rejects with NotPaid only when that proves nothing was paid; any other rejection may hide a payment.
   * Once `signal` aborts, payInvoice settles promptly: NotPaid if nothing was published, a plain error if it was. */
  payInvoice(invoice: string, signal?: AbortSignal): Promise<void>;
  makeInvoice(sats: number, signal?: AbortSignal): Promise<string>;
};

/** The wallet failed in a way that proves the invoice was not paid: the request never left, or the wallet refused it outright. */
export class NotPaid extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NotPaid';
  }
}

/** Nothing was paid because the run has no time left to pay and still finish the cycle: no fault of the mint. */
export class NoTime extends NotPaid {
  constructor() {
    super('not enough time left in this run to pay this mint, so nothing was paid');
    this.name = 'NoTime';
  }
}

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

/** `cycle: true` = FakeWallet mint: the full cycle is free and never touches the real wallet.
 * `scam: true` = it kept sats we paid it; `pending: true` = we may have paid and the cycle never ended in the melt.
 * Either flag is read-only checks only, until someone removes it by hand. */
export type MintTarget = { url: string; cycle: boolean; scam?: boolean; pending?: boolean };

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
  /** ISO timestamp of the last run that ran or attempted the real-wallet payment cycle on this mint. */
  paidCheckedAt?: string;
  /** NUT-02 input fee the mint declares, in thousandths of a sat per token spent: read, not measured, and not scored. */
  inputFeePpk?: number;
  /** Names of planned cycle checks this probe never ran, persisted so later unpaid runs can reuse them without guessing. */
  cycleUnrun?: string[];
  /** Set when the time limit or the mint cut the probe short. */
  incomplete?: true;
  /** The mint did not answer within its time limit. */
  timedOut?: true;
  /** The check our own wallet broke: left out, so it neither passes nor fails the mint. */
  notMeasured?: string;
  /** The run had no time left to pay this mint: `notMeasured` for a reason that is nobody's fault. */
  noTime?: true;
  /** The mint kept sats we paid it (now or in an earlier run). */
  scam?: true;
  /** We may have paid and the cycle did not end in the melt: whatever the mint holds is unaccounted for, so do not pay it again. */
  pending?: true;
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

/** The highest NUT-02 `input_fee_ppk` among active keysets (what spending a fresh token costs at most); omitted or null is 0, as NUT-02 says.
 * Undefined when there is no active keyset, or any active one declares an invalid fee: a bad value never reads as a lower fee. */
export function declaredInputFeePpk(keysets: readonly MintKeysetEntry[]): number | undefined {
  const fees = keysets.filter((k) => k.active).map((k) => k.input_fee_ppk ?? 0);
  return fees.length && fees.every(isFeePpk) ? Math.max(...fees) : undefined;
}

const POLL_MS = 500;
export const MANDATORY_NUTS = [1, 2, 3, 4, 5, 6];
type Check = (name: keyof typeof CHECK_NUTS, run: () => Promise<boolean>) => Promise<boolean>;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const recordedCheck = (name: keyof typeof CHECK_NUTS, ok: boolean, error?: string) => {
  const nut = CHECK_NUTS[name];
  const cycle = Object.hasOwn(CYCLE_CHECKS, name) ? true as const : undefined;
  return { nut, ok, ...(cycle ? { cycle } : {}), ...(error ? { error } : {}) };
};


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
  if (target.scam) r.scam = true;
  if (target.pending) r.pending = true;
  const blocked = !!(target.scam || target.pending);
  const websiteUrl = mintWebsiteUrl(undefined, target.url);
  if (websiteUrl) r.websiteUrl = websiteUrl;
  const timed = async <T>(read: () => Promise<T>, ms: number[]) => {
    const start = deps.now();
    const value = await abortable(read(), signal);
    ms.push(deps.now() - start);
    return value;
  };

  /** The checks this probe means to run, known once /v1/info is read. */
  let planned: Array<[string, number]> = [];
  /** A time-limit abort is timedOut, never when our own wallet is what stopped it. The planned checks it never ran are
   * listed as unrun, unless our wallet failed with nothing paid: that is not the mint's doing. */
  const done = () => {
    if (signal.aborted && !r.notMeasured) r.timedOut = true;
    const missed = planned.filter(([name]) => !r.checks[name]);
    if (!r.notMeasured || r.pending) {
      const unrun = missed.map(([, nut]) => nut);
      if (unrun.length) r.unrun = unrun;
      const cycleUnrun = missed.map(([name]) => name).filter((name) => Object.hasOwn(CYCLE_CHECKS, name));
      if (cycleUnrun.length) r.cycleUnrun = cycleUnrun;
    }
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
  const inputFeePpk = declaredInputFeePpk(keysets);
  if (inputFeePpk !== undefined) r.inputFeePpk = inputFeePpk;
  const fromInfo = mintWebsiteUrl(info, target.url);
  if (fromInfo) r.websiteUrl = fromInfo;
  r.info = {
    name: filled(info.name),
    pubkey: isPubkey(info.pubkey),
    version: filled(info.version),
    description: filled(info.description),
    contact: hasContact(info.contact),
  };

  const real = target.cycle ? undefined : deps.wallet;
  // walletBusy stays set when our wallet fails or is still pending at the time limit: that check isn't the mint's fault.
  let walletBusy = false;
  const ours = async <T>(work: () => Promise<T>) => {
    walletBusy = true;
    const value = await work();
    walletBusy = false;
    return value;
  };
  /** payInvoice was called, and the wallet did not prove nothing was paid: from then on a payment may exist. */
  let maybePaid = false;
  let paying: Promise<void> | undefined;
  const wallet: LightningWallet | undefined = real && {
    payInvoice: (invoice, s) => {
      maybePaid = true;
      paying = ours(() => real.payInvoice(invoice, s)).catch((e) => {
        if (e instanceof NotPaid) maybePaid = false;
        throw e;
      });
      return paying;
    },
    makeInvoice: (sats, s) => ours(() => real.makeInvoice(sats, s)),
  };

  const announced = (nut: number) => MANDATORY_NUTS.includes(nut) || info.nuts.includes(nut);
  const cycleRuns = !blocked && (target.cycle || !!wallet);
  planned = Object.entries(CHECK_NUTS).filter(([name, nut]) => announced(nut) && (cycleRuns || Object.hasOwn(PUBLIC_CHECKS, name)));
  /** Runs a check only if its NUT is announced; a throw fails it. Returns whether it passed. */
  const check: Check = async (name, run) => {
    const nut = CHECK_NUTS[name];
    if (!announced(nut)) return true;
    if (signal.aborted) return false;
    try {
      r.checks[name] = recordedCheck(name, await abortable(run(), signal));
    } catch (e) {
      if (walletBusy) {
        // payInvoice must settle once the signal aborts; awaiting it is how maybePaid becomes final, with no timer.
        if (paying) await paying.catch(() => {});
        walletBusy = false;
        r.notMeasured = name;
        if (e instanceof NoTime) r.noTime = true;
        r.error ??= clip(`${name}: our wallet: ${message(e)}`, MINT_ERROR_MAX);
        return false;
      }
      r.checks[name] = recordedCheck(name, false, clip(message(e), MINT_ERROR_MAX));
      r.error ??= clip(`${name}: ${message(e)}`, MINT_ERROR_MAX);
    }
    return r.checks[name].ok;
  };

  const keyIds = new Set(keys.map((k) => k.id));
  await check('keysetIds', async () => keys.length > 0 && keys.every((k) => k.valid));
  await check('keysetsListed', async () => {
    const active = keysets.filter((k) => k.active);
    return active.length > 0 && active.every((k) => keyIds.has(k.id));
  });
  let invoice = '';
  await check('mintQuote', async () => {
    const { quote, request } = await port.createMintQuote(deps.amount);
    invoice = request;
    return !!quote && request.toLowerCase().startsWith('ln');
  });
  await check('meltQuote', async () => (await port.createMeltQuote(invoice)).amount >= deps.amount);
  await check('checkState', port.unknownProofIsUnspent);

  if (cycleRuns && !signal.aborted) {
    const { started, paid, kept } = await cycle(port, deps, signal, wallet, check);
    // A payment may exist and the cycle did not end in the melt: whatever the mint holds is unaccounted for, so do not pay it again.
    if (maybePaid && !r.checks.melted?.ok) r.pending = true;
    // Scam only with proof the mint kept our sats: it charged us and issued nothing, or it spent our ecash without paying us.
    if (paid && !r.notMeasured && ((!signal.aborted && !r.checks.minted?.ok) || kept)) r.scam = true;
    // A cycle past the payment that stopped before the double-spend check leaves it unproven, so it counts as failed.
    if (started && !r.checks.doubleSpendRejected && !r.notMeasured) r.incomplete = true;
  }
  return done();
}

async function cycle(
  port: MintPort,
  deps: ProbeDeps,
  signal: AbortSignal,
  wallet: LightningWallet | undefined,
  check: Check,
): Promise<{ started: boolean; paid: boolean; kept: boolean }> {
  /** The mint invoice is paid by our wallet, or settles itself on a FakeWallet mint: from here a failure is the mint's to answer for. */
  let started = false;
  /** Our wallet paid the mint invoice and the mint reported the quote paid. */
  let paid = false;
  let minted: { proofs: unknown[]; dleqValid: boolean } | undefined;
  let fresh: unknown[] = [];
  let meltInputs: unknown[] = [];
  const ok = await check('minted', async () => {
    const { quote, request } = await port.createMintQuote(deps.amount);
    if (wallet) {
      const sats = invoiceSats(request);
      if (sats !== deps.amount) throw new Error(`mint invoice is ${sats ?? 'unspecified'} sats, expected ${deps.amount}`);
      await wallet.payInvoice(request, signal);
    }
    started = true;
    await waitUntilPaid(port, quote, deps, signal);
    paid = !!wallet;
    minted = await port.mint(deps.amount, quote);
    return minted.proofs.length > 0;
  });
  if (!ok || !minted) return { started, paid, kept: false };
  const { proofs, dleqValid } = minted;
  await check('dleq', async () => dleqValid);
  /** What we still hold if the cycle stops here. */
  let held = proofs;
  if (await check('swap', async () => (fresh = await port.swap(proofs)).length > 0)) {
    await check('doubleSpendRejected', () => port.swap(proofs).then(() => false, () => true));
    const half = Math.floor(deps.amount / 2);
    const meltedOk = await check('melted', async () => {
      const invoice = wallet ? await wallet.makeInvoice(half, signal) : (await port.createMintQuote(half)).request;
      const { paid, inputs } = await port.melt(invoice, fresh);
      meltInputs = inputs;
      return paid;
    });
    await check('spentState', () => port.allSpent([...proofs, ...meltInputs]));
    if (meltedOk) return { started, paid, kept: false };
    held = meltInputs.length ? meltInputs : fresh;
  }
  // The cycle stopped before the melt paid us: did the mint spend what we hold without paying for it?
  let kept = false;
  if (paid) {
    try {
      kept = await abortable(port.allSpent(held), signal);
    } catch {
      // A check-state failure is not proof the mint kept the tokens.
    }
  }
  return { started, paid, kept };
}

async function waitUntilPaid(port: MintPort, quote: string, deps: ProbeDeps, signal: AbortSignal): Promise<void> {
  const deadline = deps.now() + deps.payTimeoutMs;
  while (!(await abortable(port.isMintQuotePaid(quote), signal))) {
    if (deps.now() >= deadline) throw new Error(`mint quote not paid within ${deps.payTimeoutMs} ms`);
    await abortable(deps.sleep(POLL_MS), signal);
  }
}
