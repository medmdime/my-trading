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
COPY bots/controllers /opt/seed-bots/controllers
COPY bots/scripts     /opt/seed-bots/scripts
COPY bots/conf        /opt/seed-bots/conf


COPY api-seed-entrypoint.sh /usr/local/bin/api-seed-entrypoint.sh
RUN chmod +x /usr/local/bin/api-seed-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/api-seed-entrypoint.sh"]
