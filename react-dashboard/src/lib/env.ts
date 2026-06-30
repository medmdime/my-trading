// Browser-visible configuration. Credentials never live here — the Vite dev
// proxy injects Basic auth server-side (see vite.config.ts).

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api"
export const WS_BASE = import.meta.env.VITE_WS_BASE ?? "/ws"

/** Human label for what we're pointed at, shown in the top banner. */
export const TARGET_LABEL =
  import.meta.env.VITE_TARGET_LABEL ?? "LIVE PROD · api.stylette.info"

/** True when pointed at a live/production API — arms confirm dialogs + red banner. */
export const IS_LIVE = (import.meta.env.VITE_ENV ?? "prod") === "prod"

/** Build a ws:// or wss:// URL to a hummingbot-api websocket through the proxy. */
export function wsUrl(endpoint: "executors" | "market-data"): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${window.location.host}${WS_BASE}/${endpoint}`
}
