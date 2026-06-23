#!/usr/bin/env bash
# Seed git-managed bot code/configs into the bind-mounted ./bots dir, then start
# the API. Runs every boot; designed to never block startup if seeding hiccups.
BOTS=/hummingbot-api/bots
SEED=/opt/seed-bots

mkdir -p "$BOTS/controllers" "$BOTS/scripts" "$BOTS/conf" \
         "$BOTS/credentials" "$BOTS/instances" "$BOTS/data" "$BOTS/archived" "$BOTS/logs" 2>/dev/null || true

# Code = always refresh from the image (git is the source of truth):
cp -r "$SEED/controllers/." "$BOTS/controllers/" 2>/dev/null || true
cp -r "$SEED/scripts/."     "$BOTS/scripts/"     2>/dev/null || true
# Configs = seed only what's missing, so dashboard-created/edited configs survive:
cp -rn "$SEED/conf/."       "$BOTS/conf/"        2>/dev/null || true

# Hand off to the stock API entrypoint:
exec uvicorn main:app --host 0.0.0.0 --port 8000
