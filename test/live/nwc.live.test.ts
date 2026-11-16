// Real NWC wallet contract; skipped unless NWC_URL is set. Only asks for an invoice: spends nothing.
import { describe, expect, it } from 'vitest';
import { nwcWallet } from '../../src/nwc.ts';

describe.skipIf(!process.env.NWC_URL)('nwcWallet on a real wallet', () => {
  it('makes a bolt11 invoice', async () => {
    expect(await nwcWallet(process.env.NWC_URL!).makeInvoice(1)).toMatch(/^ln/i);
  }, 60_000);
});
