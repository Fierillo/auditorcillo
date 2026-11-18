import { rename, writeFile } from 'node:fs/promises';
import { isObject, probeMint, type MintTarget, type ProbeDeps, type ProbeResult } from './probe.ts';
import { SCORE, rank } from './score.ts';

type Previous = { mints: Array<{ url: string; history: boolean[] }> };

/** The previous ranking.json as far as it is usable: a broken or foreign file just restarts the history. */
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
      .map((m) => ({ url: m.url, history: Array.isArray(m.history) ? m.history.filter((h): h is boolean => typeof h === 'boolean') : [] })),
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
/** All probing must end within this, leaving the rest of the workflow timeout for install and commit. */
export const RUN_BUDGET_MS = 15 * 60_000;

/** Mints probed at once so that even if every one uses its full limit the run ends within the budget. */
export function concurrency(mints: number, mintTimeoutMs: number): number {
  return Math.max(1, Math.ceil((mints * mintTimeoutMs) / RUN_BUDGET_MS));
}

/** Probes the mints, `concurrency()` at a time, and ranks them: this object is the ranking.json the page reads.
 * `previous` is the last ranking.json, whose uptime history each mint carries forward. */
export async function audit(targets: MintTarget[], deps: ProbeDeps, previous: Previous = { mints: [] }) {
  const generatedAt = new Date(deps.now()).toISOString();
  const results: Array<ProbeResult & { history: boolean[]; uptime: number }> = [];
  const queue = [...targets];
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      const r = await probeMint(target, deps);
      const before = previous.mints.find((m) => m.url === target.url)?.history ?? [];
      const history = [...before, r.online].slice(-SCORE.historyRuns);
      const uptime = Math.round((100 * history.filter(Boolean).length) / history.length);
      results.push({ ...r, history, uptime });
    }
  };
  await Promise.all(Array.from({ length: concurrency(targets.length, deps.mintTimeoutMs) }, worker));
  return { generatedAt, weights: SCORE.weights, mints: rank(results) };
}

/** mints.json, one mint per line, with every mint this run caught keeping our sats flagged as scam.
 * Flags are only ever added here; removing one is a manual edit. */
export function flaggedMintsJson(targets: MintTarget[], mints: Array<{ url: string; scam?: true }>): string {
  const caught = new Set(mints.filter((m) => m.scam).map((m) => m.url));
  const line = (t: MintTarget) =>
    `  { ${Object.entries(caught.has(t.url) ? { ...t, scam: true } : t).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
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
