# Trading Console (React)

A simple, real-data React dashboard for the Hummingbot trading stack — the
replacement for the Streamlit dashboard. Talks **directly** to the Hummingbot API.

## Run (local dev)

```bash
bun install
bun run dev      # http://localhost:5173
```

Config lives in `.env` (copy from `.env.example`):

- `API_TARGET` / `API_USER` / `API_PASS` — **server-side only** (no `VITE_` prefix).
  The Vite dev proxy forwards `/api` → `{API_TARGET}` and `/ws` → its `ws(s)` form,
  injecting Basic auth on the way out. **Credentials never reach the browser.**
- Default `API_TARGET` is the live prod API (`https://api.stylette.info`). Point it at
  a local stack for a sandbox.
- `VITE_ENV=prod` shows the red **LIVE PROD** banner and arms confirm dialogs on all
  control actions (stop / archive / start).

`bun run build` / `bun run typecheck` for a production build / type check.

## Pages

- **Overview** — account value, live per-controller PnL, running bots, volume.
- **Instances** — start / stop / **archive** bot containers using the correct
  endpoints (`/docker/stop-container`, `/bot-orchestration/stop-and-archive-bot`).
  Fixes the old dashboard's 404 on archive.
- **Decision Inspector** — live candle stream (`/ws/market-data`) with the breakout
  channel, signal, and relative volume per tick (see "Live decisions" below).
- **Trade Analysis** — archived round-trip trades, backtest runner, and a
  live-vs-backtest overlay with the documented divergence causes.

## Live decisions require a controller restart

The Inspector's per-tick signal/levels come from the controller's
`get_custom_info()` (added in
`bots/controllers/directional_trading/scalping_breakout{,_filtered}.py`). It is
additive (no new config keys) and published every tick via `v2_with_controllers`.

To light it up:

1. Rebuild the API image via Coolify (so the new controller code ships).
2. Restart the live bots so they run the new controller and emit `custom_info`.

Until then the Inspector still streams live candles; the signal/level panel shows an
empty state.

## Codegen

`src/lib/api-types.ts` is generated from the API's OpenAPI schema:

```bash
bunx openapi-typescript ./oa.json -o src/lib/api-types.ts
```

Refresh `oa.json` and regenerate if the API image is bumped.
