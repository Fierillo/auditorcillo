# Auditorcillo

[![ci](https://github.com/Fierillo/auditorcillo/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Fierillo/auditorcillo/actions/workflows/ci.yml)
[![ranking](https://github.com/Fierillo/auditorcillo/actions/workflows/ranking.yml/badge.svg?branch=master)](https://github.com/Fierillo/auditorcillo/actions/workflows/ranking.yml)
[![vercel](https://img.shields.io/website?url=https%3A%2F%2Fauditorcillo.vercel.app&label=vercel&logo=vercel)](https://auditorcillo.vercel.app)

A public ranking that audits [Cashu](https://cashu.space) mints: it tests what each mint actually does, not what it claims.
**See it live: [auditorcillo.vercel.app](https://auditorcillo.vercel.app)**

## How it works

```mermaid
flowchart LR
  A[GitHub Action<br>every 3 h] --> B[Tests each mint<br>in mints.json]
  B --> C[Saves site/ranking.json<br>on master]
  C --> D[Vercel publishes<br>the page]
```

Once a day it also does a small real payment (a few sats) on each mint, to check that minting, swapping and withdrawing really work.

## Score (0–10)

| What | Weight | Means |
|---|---:|---|
| Availability | 40 % | How often it answered in the last 7 days, and how fast |
| NUT compliance | 30 % | The Cashu features it announces really work |
| Keyset consistency | 20 % | Its keys match what it publishes |
| Info | 10 % | Filled in name, pubkey, version, description, contact |
| Fees | 0 % | Shows the fee each mint declares; will count once measured with a real 100-sat withdrawal |

A mint that is offline gets 0. A mint that accepts the same token twice, or whose keys don't match, gets 0 and an alert.
Weights live in `SCORE` in [`src/score.ts`](src/score.ts).

## Branches

- `master` = production ([auditorcillo.vercel.app](https://auditorcillo.vercel.app))
- `dev` = preview (Vercel gives it its own link)

## Run locally

Needs Node 24 and pnpm.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test                             # offline tests, no network
python3 -m http.server 3000 -d site   # open http://localhost:3000
```

Try it against local fake mints, one honest and two that cheat (no real sats; needs Python 3.12 and [uv](https://docs.astral.sh/uv/)):

```sh
uv venv -p 3.12 .venv && VIRTUAL_ENV=.venv uv pip install -r mint-local/requirements.txt
pnpm demo
```

## License

MIT © 2026 Fierillo
