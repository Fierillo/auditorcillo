// Demo: audits three local FakeWallet mints, one honest and two cheating, and prints the ranking.
// Usage: node src/demo.ts   (needs the venv from the README)
import { setTimeout as sleep } from 'node:timers/promises';
import { audit, printRanking } from './audit.ts';
import { cashuPort } from './cashu.ts';
import { startLocalMint } from './local-mint.ts';

const mints = await Promise.all([startLocalMint(3391, 'honest'), startLocalMint(3392, 'double-spend'), startLocalMint(3393, 'keyset')]);
try {
  const ranking = await audit(
    mints.map(({ url }) => ({ url, cycle: true })),
    { port: (url) => cashuPort(url, { allowLocal: true }), now: Date.now, sleep: (ms) => sleep(ms), amount: 8, payTimeoutMs: 10_000 },
  );
  printRanking(ranking);
} finally {
  mints.forEach((m) => m.stop());
}
