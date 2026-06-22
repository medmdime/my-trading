# my-trading

My Hummingbot trading stack. **I maintain only my strategies** — the API engine, the
web dashboard, the broker and the database all run from **published Docker images**
that I pull (never build or edit). This repo contains *only my code*; everything
upstream is referenced by pinned image digest, not vendored.

## What I maintain vs. what I don't

| Component | Source | Maintained by me? |
|-----------|--------|-------------------|
| API engine | `hummingbot/hummingbot-api` image (pinned) | ❌ upstream |
| Web dashboard | `hummingbot/dashboard` image (pinned) | ❌ upstream |
| Broker / DB | `emqx:5`, `postgres:16` images (pinned) | ❌ upstream |
| **My strategies** | `bots/controllers/` | ✅ |
| **My configs** | `bots/conf/controllers/` | ✅ |
| **My dashboard page + backtest fix** | `dashboard-patches/` | ✅ |

## Upstream projects referenced

This stack is composed of these third-party projects. I do not maintain or modify
their source — `docker-compose.yml` pulls them by **digest** (pinned 2026-06-22) so
builds are reproducible. See [`NOTICE`](./NOTICE) for licensing/attribution.

| Project | Role | GitHub | Image (Docker Hub) | Pinned digest |
|---------|------|--------|--------------------|---------------|
| hummingbot-api | Trading engine / REST API | https://github.com/hummingbot/hummingbot-api | https://hub.docker.com/r/hummingbot/hummingbot-api | `sha256:4ebeed37…84784e` |
| dashboard | Streamlit web UI | https://github.com/hummingbot/dashboard | https://hub.docker.com/r/hummingbot/dashboard | `sha256:fd28cc85…00d80a` |
| EMQX | MQTT broker (bot ↔ API) | https://github.com/emqx/emqx | https://hub.docker.com/_/emqx | `sha256:c944155b…84f4` |
| PostgreSQL | API database | https://github.com/postgres/postgres | https://hub.docker.com/_/postgres | `sha256:081f1bc7…b417` |

> Optional, not part of the compose stack: the Hummingbot MCP server
> (`hummingbot/mcp`, https://github.com/hummingbot/hummingbot-mcp) is wired in
> `.mcp.json` so an AI assistant can drive the API.

## Layout

```
my-trading/
├── docker-compose.yml        # the ONE compose file for the whole stack (4 services, pinned images)
├── .env.example              # template; copy to .env (gitignored — holds creds + BOTS_PATH)
├── .mcp.json                 # optional: Hummingbot MCP server for AI assistants
├── init-db.sql               # postgres bootstrap (from upstream, rarely changes)
├── bots/                     # ← mounted into the API container
│   ├── controllers/directional_trading/scalping_breakout.py   # MY strategy
│   └── conf/controllers/*.yml                                  # MY configs
└── dashboard-patches/        # MY interface bits, overlaid onto the stock dashboard image
    ├── components/backtesting.py          # fix: posts to /backtesting/run (+ excluded-connector fallback)
    └── pages/
        ├── permissions.py                 # nav (only my Scalping Breakout page)
        └── config/scalping_breakout/      # my strategy's config + backtest UI
```

## Quick start

```bash
cp .env.example .env          # then set BOTS_PATH to this repo's absolute path
docker compose up -d          # start everything
# API  -> http://localhost:8000/docs
# UI   -> http://localhost:8501   (Config Generator → 🚀 Scalping Breakout)
```

## Update an upstream project (without touching my code)

Images are pinned by digest, so `docker compose pull` is reproducible (won't drift).
To move to a newer upstream version:

```bash
docker pull hummingbot/hummingbot-api:latest                 # fetch newest
docker inspect --format '{{index .RepoDigests 0}}' \
  hummingbot/hummingbot-api:latest                           # copy the new digest
# paste it into docker-compose.yml (replace the @sha256:… for that image), then:
docker compose up -d
```

My `bots/` and `dashboard-patches/` are never touched by an image update.

## Add a new strategy

1. Drop `my_strategy.py` into `bots/controllers/directional_trading/`.
2. Add a config YAML in `bots/conf/controllers/`.
3. (Optional) add a dashboard page under `dashboard-patches/pages/config/` and list it
   in `dashboard-patches/pages/permissions.py`.
4. `docker compose restart hummingbot-api dashboard`.

## Notes

- **Backtest connector:** the engine excludes `hyperliquid_perpetual` as a backtest
  trading-rules connector, so backtest with `connector_name=binance_perpetual` and
  deploy live with `connector_name=hyperliquid_perpetual`. The dashboard backtest
  overlay swaps this automatically; the saved/live config is untouched.
- `dashboard-patches/` exists because the stock dashboard image (a) still posts
  backtests to the old 404 endpoint and (b) has no page for my custom controller.
  These files are the *only* UI bits I own; everything else stays stock.
- `BOTS_PATH` in `.env` must be this repo's absolute path (the API bind-mounts it into
  every bot it deploys). See `.env.example`.
