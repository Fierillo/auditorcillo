// The whole scoring policy lives here: change weights or thresholds only in SCORE.
export const SCORE = {
  weights: { availability: 40, nuts: 30, keysets: 20, info: 10 },
  /** Uptime is the share of the last runs a mint answered in (the Action runs every 3 h: 56 runs = 7 days). */
  historyRuns: 56,
  /** Full availability up to `full` ms; it falls linearly to half at `slow` ms and stays there. */
  latencyMs: { full: 300, slow: 3000 },
  /** NUTs whose checks count as keyset consistency; every other check counts as NUT compliance. */
  keysetNuts: [1, 2],
  /** Failing any of these means the mint cheats or can't be trusted: score 0 and an alert. */
  critical: ['keysetIds', 'doubleSpendRejected'],
} as const;

export type Part = keyof typeof SCORE.weights;
export type CheckResult = { nut: number; ok: boolean };
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
};
export type Score = { total: number; parts: Record<Part, number>; alerts: string[] };

const share = (oks: boolean[]) => (oks.length ? oks.filter(Boolean).length / oks.length : 0);

export function score(o: Observation): Score {
  const { weights, latencyMs, keysetNuts, critical } = SCORE;
  const checks = Object.values(o.checks);
  const isKeyset = (c: CheckResult) => (keysetNuts as readonly number[]).includes(c.nut);
  const slowness = Math.min(1, Math.max(0, ((o.latencyMs ?? Infinity) - latencyMs.full) / (latencyMs.slow - latencyMs.full)));

  const parts: Record<Part, number> = o.online
    ? {
        availability: weights.availability * (o.history?.length ? share(o.history) : 1) * (1 - slowness / 2),
        nuts: weights.nuts * share(checks.filter((c) => !isKeyset(c)).map((c) => c.ok)),
        keysets: weights.keysets * share(checks.filter(isKeyset).map((c) => c.ok)),
        info: weights.info * share(Object.values(o.info)),
      }
    : { availability: 0, nuts: 0, keysets: 0, info: 0 };
  const alerts = critical.filter((name) => o.checks[name]?.ok === false);
  const total = alerts.length ? 0 : Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, parts, alerts };
}

export function rank<T extends Observation>(results: T[]): Array<T & { score: Score }> {
  return results
    .map((r) => ({ ...r, score: score(r) }))
    .sort((a, b) => b.score.total - a.score.total || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
}
