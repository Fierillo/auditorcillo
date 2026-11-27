# Auditorcillo

Audits public [Cashu](https://cashu.space) mints and ranks them by **observed behaviour**: a NUT a mint announces in `/v1/info` only counts once the auditor has seen it work. Includes local cheating mints that the auditor catches.

- A GitHub Action (`.github/workflows/ranking.yml`) runs public checks and updates uptime every 3 hours, runs the paid cycle on real mints once a day (`12:17` UTC / `09:17` ART, reusing the last paid result in between), and commits `site/ranking.json`.
- `site/` is a static page (plain HTML/JS) deployed on Vercel (`vercel.json`) that reads that JSON. No server. English and Spanish: it follows the browser language and keeps an EN/ES toggle in `localStorage`.
- Branches: `master` is production (Vercel publishes it and the Action commits the ranking there); `dev` is preview.

## Run locally

```sh
pnpm install
pnpm test        # offline contract tests (network, clock and wallet injected)
pnpm typecheck
pnpm rank        # probes mints.json, writes site/ranking.json and prints a table

# Local Nutshell mints on FakeWallet (no real sats): needs Python 3.12 and uv
uv venv -p 3.12 .venv && VIRTUAL_ENV=.venv uv pip install -r mint-local/requirements.txt
pnpm demo        # audits an honest mint and two cheating ones (ports 3391-3393)
pnpm test:live   # same three mints as tests; the NWC test runs only with NWC_URL set
```

Serve the page with any static server, e.g. `npx serve site`.

## What is checked

| Check | NUT | When |
|---|---|---|
| `keysetIds`: every keyset id derives from its published keys | 02 | always |
| `keysetsListed`: every active keyset in `/v1/keysets` publishes keys | 02 | always |
| `mintQuote`: creates a bolt11 mint quote (never paid) | 04 | always |
| `meltQuote`: quotes a melt of that invoice (never paid) | 05 | always |
| `checkState`: a proof it never signed reads `UNSPENT` | 07 | if announced |
| `minted`, `dleq`, `swap`, `doubleSpendRejected`, `melted`, `spentState` | 03/04/05/07/12 | full cycle |

The full cycle runs on every probe for free on FakeWallet mints (`"cycle": true` in `mints.json`). On real mints it runs only if `NWC_URL` (a Nostr Wallet Connect URI, GitHub secret `NWC_URL`) is set and the clock is inside the daily `[12:00, 15:00)` UTC window (catching the `12:17` UTC / `09:17` ART cron slot even with delay; manual runs follow the same window): the wallet pays an 8-sat mint quote and receives the melt of 4 sats, so each mint costs a few sats once per day, and the other 7 runs reuse the previous paid results (`paidCheckedAt`).

## Score (0–100)

All weights and thresholds live in `SCORE` in `src/score.ts`.

- **Availability 40**: uptime over the last 56 runs (7 days), times a latency factor: full up to 300 ms, falling to half at 3 s.
- **NUT compliance 30**: share of the NUT checks above that passed (NUT-02 checks excluded).
- **Keyset consistency 20**: share of the NUT-02 checks that passed.
- **Fees 0**: shown but not counted yet; they will be measured with a real withdrawal: load 100 sats into the mint, withdraw them and count what it kept (input fees included). Once measured, the weights become 35/25/15/15/10 (only `SCORE.weights` changes): full points at 0 % kept, none at 5 % or more, linear in between, and no fee data earns nothing.
- **Info 10**: share of `name`, `pubkey`, `version`, `description`, `contact` filled in.

An offline mint gets 0. A mint that accepts an already spent token or whose keyset ids don't match its keys gets 0 and an alert.

## Cheating mints (`mint-local/mint.py`)

- `double-spend`: never records spent proofs, so it accepts the same token twice.
- `keyset`: publishes two keys swapped, so its keyset id no longer derives from its keys.

## Layout

- `src/score.ts` scoring policy and ranking (pure)
- `src/probe.ts` checks against a `MintPort`, timing and errors (pure)
- `src/cashu.ts` `MintPort` implemented with `@cashu/cashu-ts`
- `src/nwc.ts` optional NIP-47 wallet (nostr-tools)
- `src/audit.ts` probes a list, carries uptime history, builds `ranking.json`
- `src/cli.ts`, `src/demo.ts`, `src/local-mint.ts` wiring

## License

MIT © 2026 Fierillo
