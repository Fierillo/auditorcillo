// The whole scoring policy lives here: change weights or thresholds only in SCORE.
import { CYCLE_CHECKS } from '../site/checks.js';
export const SCORE = {
  /** Fees are shown but weigh 0 until a real withdrawal measures them; then this becomes 35/25/15/15/10. */
  weights: { availability: 40, nuts: 30, keysets: 20, fees: 0, info: 10 },
  /** Uptime is the share of the last runs a mint answered in (the Action runs every 3 h: 56 runs = 7 days). */
  historyRuns: 56,
  /** Full availability up to `full` ms; it falls linearly to half at `slow` ms and stays there. */
  latencyMs: { full: 300, slow: 3000 },
  /** NUTs whose checks count as keyset consistency; every other check counts as NUT compliance. */
  keysetNuts: [1, 2],
  /** Full fee points when the mint keeps 0 % of a withdrawal, none from `zeroPct` up, linear in between. */
  fees: { zeroPct: 5 },
  /** Failing any of these, or never reaching one in an incomplete probe, means the mint cheats or can't be trusted: score 0 and an alert. */
  critical: ['keysetIds', 'doubleSpendRejected'],
} as const;

export type Part = keyof typeof SCORE.weights;
export type CheckResult = { nut: number; ok: boolean; cycle?: true };
export type Observation = {
  online: boolean;
  /** Whether the mint answered in each recent run, newest last; missing = this run only. */
  history?: boolean[];
  /** Median latency of the public reads. */
  latencyMs: number | null;
  /** Which /v1/info fields the mint filled in. */
  info: Record<string, boolean>;
  /** Only checks that were actually run; a NUT the mint doesn't announce isn't tested. */
  checks: Record<string, CheckResult>;
  /** The probe was cut short: a critical check it never reached counts as failed. */
  incomplete?: boolean;
  /** NUTs of the checks a probe planned but never ran: they count as failed, but raise no alert. */
  unrun?: number[];
  /** The mint kept sats we paid it: score 0 until the flag is removed by hand. */
  scam?: boolean;
  /** A payment may exist and the cycle never ended in the melt: never scores above an honest mint. */
  pending?: boolean;
  /** What the mint kept, in % of a real withdrawal (load 100 sats, withdraw them, count what is missing); input fees included. */
  fees?: { keptPct: number };
};
export type Score = { total: number; parts: Record<Part, number>; alerts: string[] };

const share = (oks: boolean[]) => (oks.length ? oks.filter(Boolean).length / oks.length : 0);

/** Share of the fee points: 1 at 0 % kept, 0 from SCORE.fees.zeroPct up. Missing or invalid fee data is not measured and earns nothing, so hiding fees never pays. */
export function feeShare(fees: Observation['fees']): number {
  const kept = fees?.keptPct;
  if (typeof kept !== 'number' || !Number.isFinite(kept) || kept < 0) return 0;
  return Math.max(0, 1 - kept / SCORE.fees.zeroPct);
}

export function score(o: Observation): Score {
  const { weights, latencyMs, keysetNuts, critical } = SCORE;
  const checks = { ...o.checks };
  const unrun = [...(o.unrun ?? [])];
  // A pending mint never finished the melt: melted counts as failed, even if a copied check says it passed.
  if (o.pending) {
    if (!Object.hasOwn(checks, 'melted')) {
      const i = unrun.indexOf(CYCLE_CHECKS.melted);
      if (i !== -1) unrun.splice(i, 1);
    }
    checks.melted = { nut: CYCLE_CHECKS.melted, ok: false, cycle: true };
  }
  const listed = Object.values(checks);
  const isKeyset = (nut: number) => (keysetNuts as readonly number[]).includes(nut);
  /** Pass/fail of every check in one part, the ones a probe never ran counting as failed. */
  const oks = (keyset: boolean) => [
    ...listed.filter((c) => isKeyset(c.nut) === keyset).map((c) => c.ok),
    ...unrun.filter((nut) => isKeyset(nut) === keyset).map(() => false),
  ];
  const slowness = Math.min(1, Math.max(0, ((o.latencyMs ?? Infinity) - latencyMs.full) / (latencyMs.slow - latencyMs.full)));

  const parts: Record<Part, number> = o.online
    ? {
        availability: weights.availability * (o.history?.length ? share(o.history) : 1) * (1 - slowness / 2),
        nuts: weights.nuts * share(oks(false)),
        keysets: weights.keysets * share(oks(true)),
        fees: weights.fees * feeShare(o.fees),
        info: weights.info * share(Object.values(o.info)),
      }
    : { availability: 0, nuts: 0, keysets: 0, fees: 0, info: 0 };
  const alerts = [
    ...(o.scam ? ['scam'] : []),
    ...critical.filter((name) => o.checks[name]?.ok === false || (o.incomplete && !o.checks[name])),
  ];
  const total = alerts.length ? 0 : Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, parts, alerts };
}

export function rank<T extends Observation>(results: T[]): Array<T & { score: Score }> {
  return results
    .map((r) => ({ ...r, score: score(r) }))
    .sort((a, b) => b.score.total - a.score.total || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
}
