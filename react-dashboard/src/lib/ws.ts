import * as React from "react"

import { wsUrl } from "./env"

export type WsEndpoint = "executors" | "market-data"
export type WsStatus = "connecting" | "open" | "closed"

export interface WsMessage<T = unknown> {
  type: string
  subscription_id?: string
  data?: T
  [k: string]: unknown
}

/**
 * Open a websocket to a hummingbot-api endpoint, fire `subscribe` message(s) on
 * connect, and stream messages to `onMessage`. Handles ping/pong heartbeat and
 * auto-reconnect with backoff. Auth is added by the Vite proxy on upgrade.
 *
 * `subscriptions` is the list of subscribe payloads (without the "action" key).
 * Pass a stable array (memoize at the call site) — the connection re-subscribes
 * whenever its JSON changes.
 */
export function useWsSubscription<T = unknown>(
  endpoint: WsEndpoint,
  subscriptions: Array<Record<string, unknown>> | null,
  onMessage: (msg: WsMessage<T>) => void,
): WsStatus {
  const [status, setStatus] = React.useState<WsStatus>("connecting")
  const onMessageRef = React.useRef(onMessage)
  onMessageRef.current = onMessage

  // Stable key so the effect only re-runs when the actual subscriptions change.
  const subsKey = subscriptions ? JSON.stringify(subscriptions) : null

  React.useEffect(() => {
    if (subsKey == null) {
      setStatus("closed")
      return
    }

    let ws: WebSocket | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let disposed = false

    const subs = JSON.parse(subsKey) as Array<Record<string, unknown>>

    const connect = () => {
      if (disposed) return
      setStatus("connecting")
      ws = new WebSocket(wsUrl(endpoint))

      ws.onopen = () => {
        attempt = 0
        setStatus("open")
        for (const sub of subs) {
          ws?.send(JSON.stringify({ action: "subscribe", ...sub }))
        }
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "ping" }))
          }
        }, 25_000)
      }

      ws.onmessage = (ev) => {
        let msg: WsMessage<T>
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.type === "pong" || msg.type === "subscribed" || msg.type === "unsubscribed") {
          return
        }
        onMessageRef.current(msg)
      }

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer)
        setStatus("closed")
        if (disposed) return
        attempt += 1
        const delay = Math.min(1000 * 2 ** attempt, 15_000)
        reconnectTimer = setTimeout(connect, delay)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      disposed = true
      if (pingTimer) clearInterval(pingTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [endpoint, subsKey])

  return status
}
