# Condor (github.com/hummingbot/condor) — Telegram bot + FastAPI web dashboard.
# In production main.py serves the built frontend AND /api/v1 + WS on :8088.
# Pinned to a known commit; talks to the Hummingbot API over the shared docker
# network (config.yml -> http://hummingbot-api:8000).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    WEB_PORT=8088 \
    UV_LINK_MODE=copy

# git (clone), node (frontend build), ffmpeg (voice), build tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates build-essential ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && pip install --no-cache-dir uv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ARG CONDOR_SHA=016aa31a744d0ef59a56e01947b83cda267a40ce
RUN git clone https://github.com/hummingbot/condor.git . \
    && git checkout ${CONDOR_SHA}

# Build the SPA (served by main.py in production).
RUN cd frontend && npm ci && npm run build

# Install Python deps (skip dev tooling).
RUN uv sync --no-dev

# Pre-seed the Hummingbot API connection (admin user comes from ADMIN_USER_ID env).
COPY config.yml ./config.yml

EXPOSE 8088
CMD ["uv", "run", "python", "main.py"]
