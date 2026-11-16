// LightningWallet over Nostr Wallet Connect (NIP-47), only to run the full cycle on mints without FakeWallet.
import { decrypt, encrypt } from 'nostr-tools/nip04';
import { nip47 } from 'nostr-tools';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import type { Filter } from 'nostr-tools/filter';
import type { LightningWallet } from './probe.ts';

/** The slice of a nostr-tools Relay that NWC uses; injected in tests. */
export type NwcRelay = {
  subscribe(filters: Filter[], params: { onevent: (e: Event) => void }): { close(): void };
  publish(event: Event): Promise<string>;
};

type Options = { connect?: (url: string) => Promise<NwcRelay>; timeoutMs?: number };

const HEX32 = /^[0-9a-f]{64}$/i;

/** Parses the NWC connection string; any failure is a fixed message, because the string holds the wallet secret. */
function parseNwcUrl(uri: string) {
  try {
    const { pubkey: walletPubkey, relays, secret } = nip47.parseConnectionString(uri);
    if (!HEX32.test(walletPubkey) || !HEX32.test(secret) || !relays.length) throw new Error();
    const key = Uint8Array.from(Buffer.from(secret, 'hex'));
    return { walletPubkey, relays, key, appPubkey: getPublicKey(key) };
  } catch {
    throw new Error('invalid NWC_URL');
  }
}

export function nwcWallet(uri: string, { connect = (url) => Relay.connect(url), timeoutMs = 60_000 }: Options = {}): LightningWallet {
  const { walletPubkey, relays, key, appPubkey } = parseNwcUrl(uri);
  let relay: Promise<NwcRelay> | undefined;

  async function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const r = await (relay ??= connect(relays[0]));
    const content = encrypt(key, walletPubkey, JSON.stringify({ method, params }));
    const event = finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [['p', walletPubkey]], content }, key);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => done(() => reject(new Error(`NWC ${method}: no answer in ${timeoutMs} ms`))), timeoutMs);
      const sub = r.subscribe([{ kinds: [23195], authors: [walletPubkey], '#e': [event.id], '#p': [appPubkey] }], {
        onevent(reply) {
          const { result, error } = JSON.parse(decrypt(key, walletPubkey, reply.content));
          done(() => (error ? reject(new Error(`NWC ${method}: ${error.code} ${error.message}`)) : resolve(result)));
        },
      });
      function done(settle: () => void) {
        clearTimeout(timer);
        sub.close();
        settle();
      }
      r.publish(event).catch((e) => done(() => reject(e)));
    });
  }

  return {
    async payInvoice(invoice) {
      await request('pay_invoice', { invoice });
    },
    async makeInvoice(sats) {
      return (await request<{ invoice: string }>('make_invoice', { amount: sats * 1000, description: 'Auditorcillo' })).invoice;
    },
  };
}
