// Wiring only: probe the mints in the list, rank them and write the JSON the page reads.
// Usage: node src/cli.ts <mints.json> <ranking.json>   (NWC_URL optional: runs the paid cycle on real mints once a day in 12:00-15:00 UTC)
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { setGlobalRequestOptions } from '@cashu/cashu-ts';
import { setGlobalDispatcher } from 'undici';
import { audit, flaggedMintsJson, isPaidRun, MINT_TIMEOUT_MS, PAY_TIMEOUT_MS, parsePrevious, printRanking, rankingJson, writeAtomic } from './audit.ts';
import { cappedFetch, cashuPort } from './cashu.ts';
import { nwcWallet } from './nwc.ts';
import { mintAgent } from './url.ts';

const [listPath, outPath] = process.argv.slice(2);
if (!listPath || !outPath) throw new Error('usage: node src/cli.ts <mints.json> <ranking.json>');

setGlobalDispatcher(mintAgent()); // every connection re-checks the resolved address (DNS rebinding)
setGlobalRequestOptions({ requestTimeout: 15_000, redirect: 'error' });
globalThis.fetch = cappedFetch(globalThis.fetch, 1_000_000);
const wallet = process.env.NWC_URL && isPaidRun(Date.now()) ? nwcWallet(process.env.NWC_URL) : undefined;
const previous = parsePrevious(await readFile(outPath, 'utf8').catch(() => '')); // carries uptime history
const targets = JSON.parse(await readFile(listPath, 'utf8'));
const ranking = await audit(targets, {
  port: cashuPort,
  now: Date.now,
  sleep: (ms) => sleep(ms),
  amount: 8,
  payTimeoutMs: PAY_TIMEOUT_MS,
  mintTimeoutMs: MINT_TIMEOUT_MS,
  wallet,
}, previous, (flags) => writeAtomic(listPath, flaggedMintsJson(targets, flags))); // each new scam/pending flag is saved as soon as its probe ends
await writeAtomic(outPath, rankingJson(ranking));
printRanking(ranking);
console.log(`written ${outPath}`);
process.exit(0); // an NWC relay socket would otherwise keep the process alive
