import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from 'nostr-tools/nip04';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { nwcWallet, type NwcRelay } from '../src/nwc.ts';
import { NotPaid } from '../src/probe.ts';

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

  it('rejects with a plain error, not NotPaid, when pay_invoice was published and the wallet never answers', async () => {
    const w = walletRelay(() => null);
    const error = await nwcWallet(w.uri, { connect: async () => w.relay, timeoutMs: 20 }).payInvoice('lnbc8').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotPaid);
    expect(error).toMatchObject({ message: expect.stringMatching(/no answer/) });
    expect(w.requests).toHaveLength(1);
  });

  const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e as Error);

  it('rejects with NotPaid for every wallet error code that proves nothing was paid', async () => {
    for (const code of ['RATE_LIMITED', 'NOT_IMPLEMENTED', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RESTRICTED', 'UNAUTHORIZED', 'UNSUPPORTED_ENCRYPTION']) {
      const w = walletRelay(() => ({ error: { code, message: 'refused' }, result: null }));
      const error = await failure(nwcWallet(w.uri, { connect: async () => w.relay }).payInvoice('lnbc8'));
      expect(error, code).toBeInstanceOf(NotPaid);
      expect(error?.message, code).toContain(code);
    }
  });

  it('rejects with a plain error for codes that leave a payment possible: PAYMENT_FAILED may be a timeout', async () => {
    for (const code of ['PAYMENT_FAILED', 'INTERNAL', 'OTHER', 'SOMETHING_NEW']) {
      const w = walletRelay(() => ({ error: { code, message: 'unclear' }, result: null }));
      const error = await failure(nwcWallet(w.uri, { connect: async () => w.relay }).payInvoice('lnbc8'));
      expect(error, code).toBeInstanceOf(Error);
      expect(error, code).not.toBeInstanceOf(NotPaid);
      expect(error?.message, code).toContain(code);
    }
  });

  it('rejects with NotPaid when the request never left: the relay is unreachable or the caller aborted first', async () => {
    const w = walletRelay(() => null);
    const down = await failure(nwcWallet(w.uri, { connect: async () => Promise.reject(new Error('relay down')) }).payInvoice('lnbc8'));
    expect(down).toBeInstanceOf(NotPaid);
    expect(down?.message).toContain('relay down');
    const ctl = new AbortController();
    const connect = async () => (ctl.abort(new Error('mint time is up')), w.relay);
    const aborted = await failure(nwcWallet(w.uri, { connect }).payInvoice('lnbc8', ctl.signal));
    expect(aborted).toBeInstanceOf(NotPaid);
    expect(aborted?.message).toContain('mint time is up');
    expect(w.requests).toHaveLength(0);
  });

  it('counts a pay_invoice reply without a preimage as paid, since the wallet did answer OK', async () => {
    const w = walletRelay(() => ({ result: {} }));
    await expect(nwcWallet(w.uri, { connect: async () => w.relay }).payInvoice('lnbc8')).resolves.toBeUndefined();
  });

  it('settles payInvoice promptly once the signal aborts: NotPaid if nothing was published, a plain error if it was', async () => {
    const settles = (promise: Promise<unknown>, ms = 50) =>
      Promise.race([
        failure(promise),
        new Promise<Error>((_, reject) => setTimeout(() => reject(new Error(`payInvoice did not settle within ${ms} ms`)), ms)),
      ]);
    const unpublished = walletRelay(() => null);
    const before = new AbortController();
    const pendingBefore = nwcWallet(unpublished.uri, { connect: () => new Promise(() => {}) }).payInvoice('lnbc8', before.signal);
    before.abort(new Error('mint time is up'));
    const early = await settles(pendingBefore);
    expect(early).toBeInstanceOf(NotPaid);
    expect(early?.message).toContain('mint time is up');
    expect(unpublished.requests).toHaveLength(0);

    const published = walletRelay(() => null);
    let released!: () => void;
    const sawPublish = new Promise<void>((resolve) => {
      released = resolve;
    });
    const relay = {
      ...published.relay,
      async publish(event: Event) {
        const result = await published.relay.publish(event);
        released();
        return result;
      },
    };
    const after = new AbortController();
    const pendingAfter = nwcWallet(published.uri, { connect: async () => relay }).payInvoice('lnbc8', after.signal);
    await sawPublish;
    after.abort(new Error('mint time is up'));
    const late = await settles(pendingAfter);
    expect(late).toBeInstanceOf(Error);
    expect(late).not.toBeInstanceOf(NotPaid);
    expect(late?.message).toContain('mint time is up');
    expect(published.requests).toHaveLength(1);
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
