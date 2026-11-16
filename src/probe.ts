import type { CheckResult, Observation } from './score.ts';

/** The mint operations the auditor needs; src/cashu.ts implements them with cashu-ts. */
export type MintPort = {
  info(): Promise<{ name?: string; pubkey?: string; version?: string; description?: string; contact: Array<{ method: string; info: string }>; nuts: number[] }>;
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
  payInvoice(invoice: string): Promise<void>;
  makeInvoice(sats: number): Promise<string>;
};

export type ProbeDeps = {
  port(url: string): MintPort;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Sats minted per cycle; the melt pays an invoice for half of it so fees fit. */
  amount: number;
  payTimeoutMs: number;
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
};


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
const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max));

const POLL_MS = 500;
const MANDATORY_NUTS = [1, 2, 3, 4, 5, 6];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function probeMint(target: MintTarget, deps: ProbeDeps): Promise<ProbeResult> {
  const port = deps.port(target.url);
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
  const timed = async <T>(read: () => Promise<T>, ms: number[]) => {
    const start = deps.now();
    const value = await read();
    ms.push(deps.now() - start);
    return value;
  };

  let reads;
  try {
    const ms: number[] = [];
    reads = { info: await timed(port.info, ms), keys: await timed(port.keys, ms), keysets: await timed(port.keysets, ms) };
    r.latencyMs = ms.sort((a, b) => a - b)[1];
    r.online = true;
  } catch (e) {
    r.error = clip(message(e), MINT_ERROR_MAX);
    return r;
  }
  const { info, keys, keysets } = reads;
  r.name = info.name == null ? null : clip(info.name, MINT_TEXT_MAX);
  r.version = info.version == null ? null : clip(info.version, MINT_TEXT_MAX);
  r.nuts = info.nuts;
  r.info = {
    name: !!info.name,
    pubkey: !!info.pubkey,
    version: !!info.version,
    description: !!info.description,
    contact: info.contact.some((c) => !!c.info),
  };

  const announced = (nut: number) => MANDATORY_NUTS.includes(nut) || info.nuts.includes(nut);
  /** Runs a check only if its NUT is announced; a throw fails it. Returns whether it passed. */
  const check = async (name: string, nut: number, run: () => Promise<boolean>) => {
    if (!announced(nut)) return true;
    try {
      r.checks[name] = { nut, ok: await run() };
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
  if (target.cycle || wallet) await cycle(port, deps, wallet, check);
  return r;
}

async function cycle(
  port: MintPort,
  deps: ProbeDeps,
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
      await wallet.payInvoice(request);
    }
    await waitUntilPaid(port, quote, deps);
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
    const invoice = wallet ? await wallet.makeInvoice(half) : (await port.createMintQuote(half)).request;
    const { paid, inputs } = await port.melt(invoice, fresh);
    meltInputs = inputs;
    return paid;
  });
  await check('spentState', 7, () => port.allSpent([...proofs, ...meltInputs]));
}

async function waitUntilPaid(port: MintPort, quote: string, deps: ProbeDeps): Promise<void> {
  const deadline = deps.now() + deps.payTimeoutMs;
  while (!(await port.isMintQuotePaid(quote))) {
    if (deps.now() >= deadline) throw new Error(`mint quote not paid within ${deps.payTimeoutMs} ms`);
    await deps.sleep(POLL_MS);
  }
}
