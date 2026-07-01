# Hummingbot API engine + MY git-managed bot code/configs, seeded on startup.
#
# Why this exists: Coolify does NOT seed bind-mounts from the repo, so ./bots
# lands EMPTY on the server (no controllers, no v2_with_controllers script, no
# configs) and bots crash with "Unknown strategy" / missing controller. Coolify
# DOES build images from the repo. So we bake the code/configs into a SEED dir
# and an entrypoint copies them into the bind-mounted ./bots on startup — that
# way the content reaches the HOST dir, which both the API and the bot
# containers it launches (they mount controllers/scripts from the host) can see.
FROM hummingbot/hummingbot-api:latest@sha256:4ebeed379a1f99cad8e2b1090108d44357900a4c88291488028936b56844784e

# Baked copy (kept separate from the live, bind-mounted /hummingbot-api/bots):
COPY bots/controllers  /opt/seed-bots/controllers
COPY bots/scripts      /opt/seed-bots/scripts
COPY bots/conf         /opt/seed-bots/conf
# credentials/: only the non-secret master_account template files + empty
# connectors/ dir markers make it past .dockerignore (real API keys never do).
# Without this, a fresh deploy has no master_account/connectors dir at all and
# the accounts UI 404s until someone manually creates it on the server.
COPY bots/credentials  /opt/seed-bots/credentials

# --- my-trading: make the Hyperliquid HIP-3 builder-dex markets backtestable ---
# Hummingbot excludes hyperliquid from backtesting (can't build the connector to
# fetch trading rules in the sandbox), which blocked backtesting SP500/SILVER/
# XYZ100 entirely. We overlay a patched data provider that injects Hyperliquid
# trading rules from a cached snapshot of the live API, plus a patched executor
# simulator that evaluates take-profit & trailing-stop intrabar (high/low) so
# backtests match live exits. Candle data already works (HL feed supports HIP-3).
ENV HB_SITE=/opt/conda/envs/hummingbot-api/lib/python3.12/site-packages/hummingbot
ENV HL_TRADING_RULES_PATH=/opt/seed-bots/hl_trading_rules.json
COPY api-patches/hl_trading_rules.json          /opt/seed-bots/hl_trading_rules.json
COPY api-patches/backtesting_data_provider.py   ${HB_SITE}/strategy_v2/backtesting/backtesting_data_provider.py
COPY api-patches/position_executor_simulator.py ${HB_SITE}/strategy_v2/backtesting/executors_simulator/position_executor_simulator.py

COPY api-seed-entrypoint.sh /usr/local/bin/api-seed-entrypoint.sh
RUN chmod +x /usr/local/bin/api-seed-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/api-seed-entrypoint.sh"]
