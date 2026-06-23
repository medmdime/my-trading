# Hummingbot API engine + MY git-managed bot code/configs baked in.
#
# Why bake instead of bind-mount: Coolify does NOT seed bind-mounts from the
# repo, so `./bots` lands EMPTY on the server (no controllers, no v2 script,
# no configs) and bots crash with "Unknown strategy" / missing controller.
# Coolify DOES build images from the repo, so baking the code makes a plain
# `git push` deploy everything. Runtime state + secrets stay on bind-mounted
# subdirs (see docker-compose.yml) so they persist across deploys.
FROM hummingbot/hummingbot-api:latest@sha256:4ebeed379a1f99cad8e2b1090108d44357900a4c88291488028936b56844784e

# Code (read-only at runtime) + initial configs, straight from the repo:
COPY bots/controllers /hummingbot-api/bots/controllers
COPY bots/scripts     /hummingbot-api/bots/scripts
COPY bots/conf        /hummingbot-api/bots/conf
