/** Formatting + small helpers shared across pages. */

export function fmtUsd(n: number | null | undefined, dp = 2): string {
  if (n == null || Number.isNaN(n)) return "—"
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
}

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || Number.isNaN(n)) return "—"
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
}

export function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || Number.isNaN(n)) return "—"
  return `${n >= 0 ? "" : ""}${n.toFixed(dp)}%`
}

/** Tailwind text color for a signed PnL value. */
export function pnlColor(n: number | null | undefined): string {
  if (n == null || n === 0) return "text-muted-foreground"
  return n > 0 ? "text-emerald-500" : "text-red-500"
}

export function fmtTs(ts: number | string | null | undefined): string {
  if (ts == null) return "—"
  // Accept seconds, ms, or ISO string.
  const d =
    typeof ts === "string"
      ? new Date(ts)
      : new Date(ts > 1e12 ? ts : ts * 1000)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString()
}

/** Hummingbot tags every bot container with this base image. */
export const BOT_IMAGE_HINT = "hummingbot/hummingbot"

/** Strip the "CloseType." prefix the API puts on close-type keys. */
export function cleanCloseType(k: string): string {
  return k.replace(/^CloseType\./, "")
}

export function signalLabel(signal: number | null | undefined): {
  text: string
  className: string
} {
  if (signal === 1) return { text: "LONG", className: "bg-emerald-600 text-white" }
  if (signal === -1) return { text: "SHORT", className: "bg-red-600 text-white" }
  return { text: "FLAT", className: "bg-muted text-muted-foreground" }
}
