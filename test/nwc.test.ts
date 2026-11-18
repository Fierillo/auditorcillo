import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from 'nostr-tools/nip04';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { nwcWallet, type NwcRelay } from '../src/nwc.ts';

/** A relay with an NWC wallet behind it: decrypts each request, records it and answers with `reply`. */
function walletRelay(reply: (req: { method: string; params: Record<string, unknown> }) => object | null) {
  const walletKey = generateSecretKey();
  const appKey = generateSecretKey();
  const uri = `nostr+walletconnect://${getPublicKey(walletKey)}?relay=wss://relay.test&secret=${Buffer.from(appKey).toString('hex')}`;
  const requests: Array<{ event: Event; body: { method: string; params: Record<string, unknown> } }> = [];
  let onevent: (e: Event) => void = () => {};
  const relay: NwcRelay = {
    subscribe(_filters, params) {
      onevent = params.onevent;
      return { close() {} };
    },
    async publish(event) {
      const body = JSON.parse(decrypt(walletKey, event.pubkey, event.content));
      requests.push({ event, body });
      const answer = reply(body);
      if (answer) {
        const content = encrypt(walletKey, event.pubkey, JSON.stringify({ result_type: body.method, ...answer }));
        onevent(finalizeEvent({ kind: 23195, created_at: event.created_at, tags: [['e', event.id], ['p', event.pubkey]], content }, walletKey));
      }
      return '';
    },
  };
  return { uri, relay, requests, walletPubkey: getPublicKey(walletKey) };
}

describe('nwcWallet (NIP-47)', () => {
  it('pays an invoice with an encrypted pay_invoice request addressed to the wallet', async () => {
    const w = walletRelay(() => ({ result: { preimage: 'ab' } }));
    await nwcWallet(w.uri, { connect: async () => w.relay }).payInvoice('lnbc8');
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0].event).toMatchObject({ kind: 23194, tags: [['p', w.walletPubkey]] });
    expect(w.requests[0].body).toEqual({ method: 'pay_invoice', params: { invoice: 'lnbc8' } });
  });

  it('asks make_invoice in millisats and returns the invoice', async () => {
    const w = walletRelay(() => ({ result: { invoice: 'lnbc4wallet' } }));
    expect(await nwcWallet(w.uri, { connect: async () => w.relay }).makeInvoice(4)).toBe('lnbc4wallet');
    expect(w.requests[0].body).toMatchObject({ method: 'make_invoice', params: { amount: 4000 } });
  });

  it('rejects with the wallet error', async () => {
    const w = walletRelay(() => ({ error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds' }, result: null }));
    await expect(nwcWallet(w.uri, { connect: async () => w.relay }).payInvoice('lnbc8')).rejects.toThrow(/INSUFFICIENT_BALANCE.*no funds/);
  });

  it('gives up when the wallet never answers', async () => {
    const w = walletRelay(() => null);
    await expect(nwcWallet(w.uri, { connect: async () => w.relay, timeoutMs: 20 }).payInvoice('lnbc8')).rejects.toThrow(/no answer/);
  });

  it('stops waiting for the wallet as soon as the caller aborts', async () => {
    const w = walletRelay(() => null);
    const ctl = new AbortController();
    const pending = nwcWallet(w.uri, { connect: async () => w.relay }).payInvoice('lnbc8', ctl.signal);
    ctl.abort(new Error('mint time is up'));
    await expect(pending).rejects.toThrow(/mint time is up/);
  });

  it('does not publish a request once the caller has aborted', async () => {
    const w = walletRelay(() => ({ result: { preimage: 'ab' } }));
    const ctl = new AbortController();
    const connect = async () => {
      ctl.abort(new Error('mint time is up'));
      return w.relay;
    };
    await expect(nwcWallet(w.uri, { connect }).payInvoice('lnbc8', ctl.signal)).rejects.toThrow(/mint time is up/);
    expect(w.requests).toHaveLength(0);
  });

  it('rejects a malformed NWC_URL without echoing it, since it holds the wallet secret', () => {
    const secret = 'deadbeef'.repeat(8);
    for (const uri of [`nostr+walletconnect://not a pubkey?secret=${secret}`, `nostr+walletconnect://${'a'.repeat(64)}?secret=${secret}`, `garbage ${secret}`, `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://r.test&secret=zz${secret}`]) {
      let error: unknown;
      try {
        nwcWallet(uri);
      } catch (e) {
        error = e;
      }
      expect(error, uri).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('invalid NWC_URL');
      expect(String((error as Error).stack)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
