# my-trading

My Hummingbot trading stack. **I maintain only my strategies** — everything else
(the API engine, the web dashboard) runs from published Docker images that I pull,
never build or edit.

## What I maintain vs. what I don't

| Component | Source | How it updates | Maintained by me? |
|-----------|--------|----------------|-------------------|
| API engine | `hummingbot/hummingbot-api:latest` image | `docker compose pull` | ❌ upstream |
| Web dashboard | `hummingbot/dashboard:latest` image | `docker compose pull` | ❌ upstream |
| Broker / DB | `emqx:5`, `postgres:16` images | `docker compose pull` | ❌ upstream |
| **My strategies** | `bots/controllers/` | I edit them | ✅ |
| **My configs** | `bots/conf/controllers/` | I edit them | ✅ |
| **My dashboard page + backtest fix** | `dashboard-patches/` | I edit them | ✅ |

The "reference to the code I don't maintain" is simply the **image tag** in
`docker-compose.yml` (e.g. `hummingbot/hummingbot-api:latest`) — no git submodule,
no source clone to babysit.

## Layout

```
my-trading/
├── docker-compose.yml        # thin orchestration: images + my volume mounts
├── .env                      # creds/ports (gitignored)
├── init-db.sql               # postgres bootstrap (from upstream, rarely changes)
├── bots/
│   ├── controllers/directional_trading/scalping_breakout.py   # MY strategy
│   └── conf/controllers/*.yml                                  # MY configs
└── dashboard-patches/        # MY interface bits, overlaid onto the stock dashboard image
    ├── components/backtesting.py          # fix: posts to /backtesting/run
    └── pages/
        ├── permissions.py                 # nav (only my Scalping Breakout page)
        └── config/scalping_breakout/      # my strategy's config + backtest UI
```

## Run

```bash
docker compose up -d           # start everything
# API  -> http://localhost:8000/docs
# UI   -> http://localhost:8501   (Config Generator → Scalping Breakout)
```

## Update upstream (engine + UI) without touching my code

```bash
docker compose pull            # get latest images from Docker Hub
docker compose up -d           # recreate containers; my bots/ + patches are untouched
```

## Add a new strategy

1. Drop `my_strategy.py` into `bots/controllers/directional_trading/`.
2. Add a config YAML in `bots/conf/controllers/`.
3. (Optional) add a dashboard page under `dashboard-patches/pages/config/` and list it
   in `dashboard-patches/pages/permissions.py`.
4. `docker compose restart hummingbot-api dashboard`.

## Notes

- `dashboard-patches/` exists because the stock dashboard image (a) still posts
  backtests to the old 404 endpoint and (b) has no page for my custom controller.
  These three files are the *only* UI bits I own; everything else stays stock.
- After an image update, sanity-check that `dashboard-patches/permissions.py` still
  matches the upstream nav structure (it rarely changes).
