// Wiring only: probe the mints in the list, rank them and write the JSON the page reads.
// Usage: node src/cli.ts <mints.json> <ranking.json>   (NWC_URL optional: runs the paid cycle on real mints)
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { setGlobalRequestOptions } from '@cashu/cashu-ts';
import { audit, printRanking, rankingJson } from './audit.ts';
import { cappedFetch, cashuPort } from './cashu.ts';
import { nwcWallet } from './nwc.ts';

const [listPath, outPath] = process.argv.slice(2);
if (!listPath || !outPath) throw new Error('usage: node src/cli.ts <mints.json> <ranking.json>');

setGlobalRequestOptions({ requestTimeout: 15_000, redirect: 'error' });
globalThis.fetch = cappedFetch(globalThis.fetch, 1_000_000);
const wallet = process.env.NWC_URL ? nwcWallet(process.env.NWC_URL) : undefined;
const previous = await readFile(outPath, 'utf8').then(JSON.parse, () => undefined); // carries uptime history
const ranking = await audit(JSON.parse(await readFile(listPath, 'utf8')), {
  port: cashuPort,
  now: Date.now,
  sleep: (ms) => sleep(ms),
  amount: 8,
  payTimeoutMs: 60_000,
  wallet,
}, previous);
await writeFile(outPath, rankingJson(ranking));
printRanking(ranking);
console.log(`written ${outPath}`);
process.exit(0); // an NWC relay socket would otherwise keep the process alive
