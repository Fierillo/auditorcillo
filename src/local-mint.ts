// Starts mint-local/mint.py (Nutshell on FakeWallet) and waits until it answers.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export type LocalMintMode = 'honest' | 'double-spend' | 'keyset';
export type LocalMint = { url: string; stop(): void };

const root = fileURLToPath(new URL('..', import.meta.url));

export async function startLocalMint(port: number, mode: LocalMintMode): Promise<LocalMint> {
  const log = `/tmp/auditorcillo-mint-${mode}.log`;
  const child = spawn(`${root}.venv/bin/python`, [`${root}mint-local/mint.py`, String(port), mode], {
    stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')],
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = () => void child.kill();
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    if (await fetch(`${url}/v1/info`).then((r) => r.ok, () => false)) return { url, stop };
    await sleep(500);
  }
  stop();
  throw new Error(`local mint ${mode} did not start on :${port}, see ${log}`);
}
