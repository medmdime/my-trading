#!/usr/bin/env bash
# Seed git-managed bot code/configs into the bind-mounted ./bots dir, then start
# the API. Runs every boot; designed to never block startup if seeding hiccups.
BOTS=/hummingbot-api/bots
SEED=/opt/seed-bots

mkdir -p "$BOTS/controllers" "$BOTS/scripts" "$BOTS/conf" \
         "$BOTS/credentials/master_account/connectors" \
         "$BOTS/instances" "$BOTS/data" "$BOTS/archived" "$BOTS/logs" 2>/dev/null || true

# Code = always refresh from the image (git is the source of truth):
cp -r "$SEED/controllers/." "$BOTS/controllers/" 2>/dev/null || true
cp -r "$SEED/scripts/."     "$BOTS/scripts/"     2>/dev/null || true
# Configs / credentials = seed only what's missing, so UI-created accounts,
# added connector credentials and edited configs all survive across restarts:
cp -rn "$SEED/conf/."        "$BOTS/conf/"        2>/dev/null || true
cp -rn "$SEED/credentials/." "$BOTS/credentials/"  2>/dev/null || true

# Hand off to the stock API entrypoint:
exec uvicorn main:app --host 0.0.0.0 --port 8000
