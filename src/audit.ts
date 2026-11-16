import { rename, writeFile } from 'node:fs/promises';
import { probeMint, type MintTarget, type ProbeDeps } from './probe.ts';
import { SCORE, rank } from './score.ts';

type Previous = { mints: Array<{ url: string; history: boolean[] }> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

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
export async function writeAtomic(path: string, text: string, fs: { writeFile(path: string, text: string): Promise<void>; rename(from: string, to: string): Promise<void> } = { writeFile, rename }) {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, path);
}

/** Probes every mint in order and ranks them: this object is the ranking.json the page reads.
 * `previous` is the last ranking.json, whose uptime history each mint carries forward. */
export async function audit(targets: MintTarget[], deps: ProbeDeps, previous: Previous = { mints: [] }) {
  const generatedAt = new Date(deps.now()).toISOString();
  const results = [];
  for (const target of targets) {
    const r = await probeMint(target, deps);
    const before = previous.mints.find((m) => m.url === target.url)?.history ?? [];
    const history = [...before, r.online].slice(-SCORE.historyRuns);
    const uptime = Math.round((100 * history.filter(Boolean).length) / history.length);
    results.push({ ...r, history, uptime });
  }
  return { generatedAt, weights: SCORE.weights, mints: rank(results) };
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
