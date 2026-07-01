# my-trading

My Hummingbot trading stack. **I maintain my strategies and my UI** — the API engine,
the broker and the database run from **published Docker images** that I pull (never
build or edit their source). This repo contains *my code*; everything upstream is
referenced by pinned image digest, not vendored.

## What I maintain vs. what I don't

| Component | Source | Maintained by me? |
|-----------|--------|-------------------|
| API engine | `hummingbot/hummingbot-api` image (pinned) + my patches baked in | ✅ patches / ❌ upstream base |
| Broker / DB | `emqx:5`, `postgres:16` images (pinned) | ❌ upstream |
| **Web UI** | `react-dashboard/` (Bun/Vite/React) | ✅ |
| **My strategies** | `bots/controllers/` | ✅ |
| **My configs** | `bots/conf/controllers/` | ✅ |

## Upstream projects referenced

This stack is composed of these third-party projects. I do not maintain or modify
their source — `docker-compose.yml` pulls them by **digest** so builds are
reproducible. See [`NOTICE`](./NOTICE) for licensing/attribution.

| Project | Role | GitHub | Image (Docker Hub) |
|---------|------|--------|--------------------|
| hummingbot-api | Trading engine / REST API | https://github.com/hummingbot/hummingbot-api | https://hub.docker.com/r/hummingbot/hummingbot-api |
| EMQX | MQTT broker (bot ↔ API) | https://github.com/emqx/emqx | https://hub.docker.com/_/emqx |
| PostgreSQL | API database | https://github.com/postgres/postgres | https://hub.docker.com/_/postgres |

> Optional, not part of the compose stack: the Hummingbot MCP server
> (`hummingbot/mcp`, https://github.com/hummingbot/hummingbot-mcp) is wired in
> `.mcp.json` so an AI assistant can drive the API.

## Layout

```
my-trading/
├── docker-compose.yml        # the ONE compose file for the whole stack (4 services)
├── .env.example               # template; copy to .env (gitignored — holds creds)
├── .mcp.json                  # optional: Hummingbot MCP server for AI assistants
├── init-db.sql                # postgres bootstrap (from upstream, rarely changes)
├── api.Dockerfile             # hummingbot-api + my controllers/configs/patches baked in
├── api-seed-entrypoint.sh     # seeds bots/{controllers,scripts,conf,credentials} into
│                               # the bind-mounted ./bots on every boot (see below)
├── api-patches/                # patches overlaid onto the hummingbot-api image
├── bots/                      # ← bind-mounted into the API container
│   ├── controllers/directional_trading/scalping_breakout.py   # MY strategy
│   ├── conf/controllers/*.yml                                  # MY configs
│   └── credentials/master_account/                             # account + connector creds
└── react-dashboard/           # MY web UI (Bun/Vite/React), replaces the old Streamlit UI
```

## Quick start (works the same on any server)

```bash
cp .env.example .env          # defaults (admin/admin) work out of the box locally
docker compose up -d --build  # start everything
# API   -> http://localhost:8002/docs
# UI    -> http://localhost:8090
```

On first run, open the UI and use **Accounts → Create master account** to add your
exchange API keys — nothing sensitive is baked into the image or committed to git.

## Why the bind-mount seeding exists

Coolify (and most PaaS-style Docker hosts) do **not** seed bind-mounted volumes from
the git repo — a fresh `./bots` on the server starts empty, so a naive bind mount
would have no controllers/scripts/configs and bots would crash with "Unknown
strategy". Coolify **does** build images from the repo, so `api.Dockerfile` bakes
`bots/controllers`, `bots/scripts`, `bots/conf`, and the non-secret parts of
`bots/credentials` (the `master_account` template files + empty `connectors/`
folders — never real API keys) into `/opt/seed-bots`, and
`api-seed-entrypoint.sh` copies them into the live bind mount on every boot —
code is always refreshed, configs/credentials are seeded only if missing (so
UI-created accounts and edited configs survive restarts). This means `git push`
alone is enough to deploy everything, on any host.

## Update the upstream API image

```bash
docker pull hummingbot/hummingbot-api:latest                 # fetch newest
docker inspect --format '{{index .RepoDigests 0}}' \
  hummingbot/hummingbot-api:latest                           # copy the new digest
# paste it into api.Dockerfile's FROM line, then:
docker compose up -d --build
```

My `bots/`, `api-patches/` and `react-dashboard/` are never touched by an upstream
image update.

## Add a new strategy

1. Drop `my_strategy.py` into `bots/controllers/directional_trading/`.
2. Add a config YAML in `bots/conf/controllers/`.
3. `docker compose restart hummingbot-api`.
4. Deploy/configure it from the React UI.

## Notes

- **Backtest connector:** `api-patches/` overrides the engine so Hyperliquid
  (incl. HIP-3 builder-dex markets) can be backtested directly — no more
  swapping to `binance_perpetual`.
- `BOTS_PATH` in `.env` must be this repo's absolute path on the **host** running
  Docker (the API bind-mounts it into every bot instance it deploys). See
  `.env.example`.
