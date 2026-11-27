import { rename, writeFile } from 'node:fs/promises';
import { CYCLE_CHECKS } from '../site/checks.js';
import { isObject, MINT_ERROR_MAX, NoTime, NotPaid, probeMint, type MintTarget, type ProbeDeps, type ProbeResult } from './probe.ts';
import { SCORE, rank } from './score.ts';

type PreviousMint = {
  url: string;
  history: boolean[];
  paidCheckedAt?: string;
  checks?: ProbeResult['checks'];
  incomplete?: true;
  cycleUnrun?: string[];
};
type Previous = { mints: PreviousMint[] };

export const PAID_UTC_FROM = 12;
export const PAID_UTC_TO = 15;

/** Only the 12:17 UTC slot pays real mints; [12:00, 15:00) UTC absorbs GitHub cron delays without touching the 15:17 slot. */
export function isPaidRun(now: number): boolean {
  if (!Number.isFinite(now)) return false;
  const hour = new Date(now).getUTCHours();
  return hour >= PAID_UTC_FROM && hour < PAID_UTC_TO;
}

function parseCycleChecks(raw: unknown): ProbeResult['checks'] | undefined {
  if (!isObject(raw)) return undefined;
  const checks: ProbeResult['checks'] = {};
  for (const [name, expectedNut] of Object.entries(CYCLE_CHECKS)) {
    const c = raw[name];
    if (!isObject(c) || typeof c.ok !== 'boolean' || c.nut !== expectedNut) continue;
    const rec: ProbeResult['checks'][string] = { nut: expectedNut, ok: c.ok, cycle: true };
    if (typeof c.error === 'string') rec.error = c.error.slice(0, MINT_ERROR_MAX);
    checks[name] = rec;
  }
  return Object.keys(checks).length ? checks : undefined;
}

function parseCycleUnrun(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((n): n is string => typeof n === 'string' && Object.hasOwn(CYCLE_CHECKS, n));
  return names.length ? names : undefined;
}

/** The previous ranking.json, written and committed only by this job: anyone who can edit it can edit the repo, so a well-formed forgery is out of scope. Garbage, invalid types and prototype keys are ignored and never inflate a mint's history, paid cycle or score. */
export function parsePrevious(text: string): Previous {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { mints: [] };
  }
  if (!isObject(data) || !Array.isArray(data.mints)) return { mints: [] };
  return {
    mints: data.mints
      .filter((m): m is Record<string, unknown> & { url: string } => isObject(m) && typeof m.url === 'string')
      .map((m) => {
        const entry: PreviousMint = {
          url: m.url,
          history: Array.isArray(m.history) ? m.history.filter((h): h is boolean => typeof h === 'boolean') : [],
        };
        const paidCheckedAt = typeof m.paidCheckedAt === 'string' && m.paidCheckedAt.length <= 64 && Number.isFinite(Date.parse(m.paidCheckedAt)) ? m.paidCheckedAt : undefined;
        if (paidCheckedAt) {
          entry.paidCheckedAt = paidCheckedAt;
          const checks = parseCycleChecks(m.checks);
          if (checks) entry.checks = checks;
          if (m.incomplete === true) entry.incomplete = true;
          const cycleUnrun = parseCycleUnrun(m.cycleUnrun);
          if (cycleUnrun) entry.cycleUnrun = cycleUnrun;
        }
        return entry;
      }),
  };
}

/** Writes `path` through a temporary file and a rename, so a crash never leaves it half written. */
export async function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** Every mint gets the same fixed time for its whole probe, whatever the list size or order. */
export const MINT_TIMEOUT_MS = 60_000;
/** The wait for a paid mint quote runs inside the mint time. */
export const PAY_TIMEOUT_MS = 40_000;
/** All probing must end within this. The GitHub job budget is install, then this, then the commit.
 * If the list is so long that two at a time would overshoot, the job itself has to be stretched. */
export const RUN_BUDGET_MS = 15 * 60_000;
/** Hard cap on probes that can run a payment cycle at once, so one wallet is never hit with a stampede. */
export const MAX_PAYMENT_CONCURRENCY = 2;

/** Mints probed at once so that even if every one uses its full limit the run ends within the budget, at most two. */
export function concurrency(mints: number, mintTimeoutMs: number): number {
  return Math.min(MAX_PAYMENT_CONCURRENCY, Math.max(1, Math.ceil((mints * mintTimeoutMs) / RUN_BUDGET_MS)));
}

/** A list entry the auditor can probe; anything else is recorded as a failed mint. */
function mintTarget(entry: unknown): MintTarget | undefined {
  if (!isObject(entry) || typeof entry.url !== 'string') return undefined;
  const target: MintTarget = { url: entry.url, cycle: entry.cycle === true };
  if (entry.scam === true) target.scam = true;
  if (entry.pending === true) target.pending = true;
  return target;
}

function invalidMint(now: number): ProbeResult {
  return {
    url: '',
    name: null,
    version: null,
    nuts: [],
    checkedAt: new Date(now).toISOString(),
    online: false,
    latencyMs: null,
    info: {},
    checks: {},
    error: 'invalid mint entry',
  };
}

const hasCycleCheck = (checks: ProbeResult['checks']) => Object.keys(checks).some((k) => Object.hasOwn(CYCLE_CHECKS, k));

/** This probe itself measured a paid cycle: cycle checks, an incomplete cycle, or a pending/scam flag this run just raised (not one already in the list). */
const measuredFreshPaidCycle = (r: ProbeResult, target: MintTarget) =>
  hasCycleCheck(r.checks) || !!r.incomplete || (!!r.pending && !target.pending) || (!!r.scam && !target.scam);

function carryPaidCycle(r: ProbeResult, prev: PreviousMint | undefined) {
  if (!prev?.paidCheckedAt && !prev?.checks && !prev?.incomplete && !prev?.cycleUnrun?.length) return;
  if (prev.paidCheckedAt) r.paidCheckedAt = prev.paidCheckedAt;
  if (prev.checks) {
    for (const [name, c] of Object.entries(prev.checks)) {
      if (Object.hasOwn(CYCLE_CHECKS, name)) r.checks[name] = c;
    }
  }
  if (prev.incomplete) r.incomplete = true;
  if (prev.cycleUnrun?.length) {
    r.cycleUnrun = prev.cycleUnrun;
    r.unrun = [...(r.unrun ?? []), ...prev.cycleUnrun.map((name) => CYCLE_CHECKS[name as keyof typeof CYCLE_CHECKS])];
  }
}

/** The flags this run holds on a mint, on top of the ones already in the list. */
type Flags = { url: string; scam?: true; pending?: true };

/** Probes the mints, `concurrency()` at a time, and ranks them: this object is the ranking.json the page reads.
 * `previous` is the last ranking.json, whose uptime history each mint carries forward.
 * `onFlagged` saves the flags held so far (all of them, one save at a time). It runs before our wallet pays a mint, with
 * that mint marked pending, so a crash right after paying cannot lose the mark; and again when a probe sets, changes or
 * clears a flag. If a save fails nothing new is paid or taken, the run ends with one last try to save, and then it throws. */
export async function audit(
  targets: readonly unknown[],
  deps: ProbeDeps,
  previous: Previous = { mints: [] },
  onFlagged: (flags: Flags[]) => Promise<void> = async () => {},
) {
  const startedAt = deps.now();
  const generatedAt = new Date(startedAt).toISOString();
  /** No payment starts unless its whole mint limit fits before this, so the job is never killed with one in flight. */
  const cutoff = startedAt + RUN_BUDGET_MS;
  const results: Array<ProbeResult & { history: boolean[]; uptime: number }> = [];
  const queue = [...targets];
  const flags = new Map<string, Omit<Flags, 'url'>>();
  const errors: unknown[] = [];
  const held = () => [...flags].map(([url, f]) => ({ url, ...f }));
  let saving = Promise.resolve();
  const save = () => {
    const run = saving.then(() => onFlagged(held()));
    saving = run.catch(() => {});
    return run.catch((e) => {
      errors.push(e);
      throw e;
    });
  };
  const worker = async () => {
    while (queue.length && !errors.length) {
      const entry = queue.shift();
      const target = mintTarget(entry);
      const r = target ? await probeMint(target, { ...deps, wallet: markBeforePaying(target.url) }) : invalidMint(deps.now());
      const prev = previous.mints.find((m) => m.url === r.url);
      // Real mints: a fresh paid-cycle measurement wins, even with mint failures; otherwise reuse the previous cycle.
      if (target && !target.cycle) {
        if (measuredFreshPaidCycle(r, target)) r.paidCheckedAt = r.checkedAt;
        else carryPaidCycle(r, prev);
      }
      const before = prev?.history ?? [];
      const history = [...before, r.online].slice(-SCORE.historyRuns);
      const uptime = Math.round((100 * history.filter(Boolean).length) / history.length);
      results.push({ ...r, history, uptime });
      if (!target || target.scam || target.pending) continue; // a flagged mint keeps the flags the list already has
      const was = flags.get(target.url);
      if (r.scam || r.pending) flags.set(target.url, { scam: r.scam, pending: r.pending });
      else flags.delete(target.url);
      if (!!was?.scam !== !!r.scam || !!was?.pending !== !!r.pending) await save().catch(() => {});
    }
  };
  /** Our wallet, except that it pays only if there is time to finish, and first saves the mint as pending, paying only if that save worked. */
  const markBeforePaying = (url: string): ProbeDeps['wallet'] =>
    deps.wallet && {
      ...deps.wallet,
      payInvoice: async (invoice, signal) => {
        if (deps.now() + deps.mintTimeoutMs > cutoff) throw new NoTime();
        flags.set(url, { pending: true });
        try {
          await save();
        } catch (e) {
          flags.delete(url);
          throw new NotPaid('could not save the pending mark, so nothing was paid', { cause: e });
        }
        if (signal?.aborted) throw new NotPaid('time is up, so nothing was paid');
        return deps.wallet!.payInvoice(invoice, signal);
      },
    };
  const settled = await Promise.allSettled(Array.from({ length: concurrency(targets.length, deps.mintTimeoutMs) }, worker));
  errors.push(...settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : [])));
  if (errors.length) {
    await saving;
    await onFlagged(held()).catch(() => {}); // one last try with everything held
    throw errors[0];
  }
  return { generatedAt, weights: SCORE.weights, mints: rank(results) };
}

/** mints.json, one mint per line, with every mint this run caught as scam or pending flagged so we stop paying it.
 * Flags are only ever added here; removing one is a manual edit. */
export function flaggedMintsJson(targets: readonly unknown[], mints: Array<{ url: string; scam?: true; pending?: true }>): string {
  const flagged = (flag: 'scam' | 'pending') => new Set(mints.filter((m) => m[flag]).map((m) => m.url));
  const scam = flagged('scam');
  const pending = flagged('pending');
  const line = (entry: unknown) => {
    const t = mintTarget(entry);
    if (!t) return `  ${JSON.stringify(entry)}`;
    const row = { ...(entry as object), ...(scam.has(t.url) ? { scam: true } : {}), ...(pending.has(t.url) ? { pending: true } : {}) };
    return `  { ${Object.entries(row).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  };
  return `[\n${targets.map(line).join(',\n')}\n]\n`;
}

export const RANKING_MAX_BYTES = 100_000;

export function rankingJson(ranking: unknown): string {
  const json = JSON.stringify(ranking, null, 2) + '\n';
  if (json.length > RANKING_MAX_BYTES) throw new Error(`ranking.json is ${json.length} bytes, exceeds ${RANKING_MAX_BYTES}`);
  return json;
}

export function printRanking({ mints }: Awaited<ReturnType<typeof audit>>) {
  console.table(
    mints.map((m) => ({
      mint: m.url,
      score: m.score.total,
      latencyMs: m.latencyMs ?? '-',
      failed: Object.entries(m.checks).filter(([, c]) => !c.ok).map(([name]) => name).join(' '),
      alerts: m.score.alerts.join(' '),
      error: m.error?.slice(0, 80) ?? '',
    })),
  );
}
