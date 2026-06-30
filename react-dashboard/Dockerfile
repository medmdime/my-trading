# --- build the static SPA with Bun ---
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Browser-exposed build config. API/WS go to same-origin /api,/ws (nginx proxies them).
ENV VITE_API_BASE=/api \
    VITE_WS_BASE=/ws \
    VITE_ENV=prod \
    VITE_TARGET_LABEL="LIVE PROD · stylette.info"
RUN bun run build

# --- serve with nginx ---
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
