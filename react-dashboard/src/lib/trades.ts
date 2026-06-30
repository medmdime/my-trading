// Normalize archived/backtest executors into a uniform round-trip shape,
// mirroring dashboard-patches/components/trade_viz.py.

export const CLOSE_TYPES: Record<number, string> = {
  1: "TIME_LIMIT",
  2: "STOP_LOSS",
  3: "TAKE_PROFIT",
  4: "EXPIRED",
  5: "EARLY_STOP",
  6: "TRAILING_STOP",
  7: "INSUFFICIENT_BALANCE",
  8: "FAILED",
  9: "COMPLETED",
  10: "POSITION_HOLD",
}

export function closeTypeName(ct: unknown): string {
  if (typeof ct === "string") return ct.replace("CloseType.", "")
  if (typeof ct === "number") return CLOSE_TYPES[ct] ?? String(ct)
  return "—"
}

export interface Trade {
  id: string
  controllerId: string
  tradingPair: string
  side: "LONG" | "SHORT"
  entry: number
  exit: number
  amountQuote: number
  netPnlQuote: number
  netPnlPct: number
  feesQuote: number
  closeType: string
  ts: number // entry, seconds
  closeTs: number // exit, seconds
}

function parseMaybeJson(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>
  if (typeof v === "string") {
    try {
      return JSON.parse(v)
    } catch {
      return {}
    }
  }
  return {}
}

const num = (v: unknown): number => {
  const f = typeof v === "string" ? parseFloat(v) : (v as number)
  return Number.isFinite(f) ? f : 0
}

/** Seconds, coercing a millisecond timestamp down if needed. */
const secs = (v: unknown): number => {
  const f = num(v)
  return Math.floor(f > 1e12 ? f / 1000 : f)
}

/** Normalize one raw executor (archived or backtest) into a Trade. */
export function normalizeExecutor(raw: Record<string, unknown>): Trade {
  const cfg = parseMaybeJson(raw.config)
  const ci = parseMaybeJson(raw.custom_info)
  const entry = num(ci.current_position_average_price ?? cfg.entry_price)
  const exit = num(ci.close_price ?? entry)
  const side = num(raw.side ?? cfg.side) === 1 ? "LONG" : "SHORT"
  return {
    id: String(raw.id ?? ""),
    controllerId: String(raw.controller_id ?? cfg.controller_id ?? ""),
    tradingPair: String(cfg.trading_pair ?? ""),
    side,
    entry,
    exit,
    amountQuote: num(raw.filled_amount_quote),
    netPnlQuote: num(raw.net_pnl_quote),
    netPnlPct: num(raw.net_pnl_pct),
    feesQuote: num(raw.cum_fees_quote),
    closeType: closeTypeName(raw.close_type),
    ts: secs(raw.timestamp),
    closeTs: secs(raw.close_timestamp),
  }
}

/**
 * Convert backtest `processed_data` (column-oriented dict of parallel arrays)
 * into row objects. Also tolerates an array-of-rows shape just in case.
 * Drops warm-up rows where timestamp/close is null.
 */
export function processedToRows(pd: unknown): ProcessedRow[] {
  if (!pd) return []
  if (Array.isArray(pd)) {
    return (pd as Record<string, unknown>[])
      .filter((r) => r.timestamp != null && r.close != null)
      .map((r) => ({
        timestamp: secs(r.timestamp),
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close: num(r.close),
        volume: num(r.volume),
        resistance: r.resistance == null ? undefined : num(r.resistance),
        support: r.support == null ? undefined : num(r.support),
        signal: r.signal == null ? undefined : num(r.signal),
      }))
  }
  const cols = pd as Record<string, unknown[]>
  const ts = cols.timestamp
  if (!Array.isArray(ts)) return []
  const col = (k: string, i: number) => (Array.isArray(cols[k]) ? cols[k][i] : null)
  const rows: ProcessedRow[] = []
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] == null || col("close", i) == null) continue
    const res = col("resistance", i)
    const sup = col("support", i)
    const sig = col("signal", i)
    rows.push({
      timestamp: secs(ts[i]),
      open: num(col("open", i)),
      high: num(col("high", i)),
      low: num(col("low", i)),
      close: num(col("close", i)),
      volume: num(col("volume", i)),
      resistance: res == null ? undefined : num(res),
      support: sup == null ? undefined : num(sup),
      signal: sig == null ? undefined : num(sig),
    })
  }
  return rows
}

export interface TradeSummary {
  count: number
  wins: number
  winRate: number
  netPnl: number
  fees: number
  volume: number
  closeTypeCounts: Record<string, number>
}

export function summarize(trades: Trade[]): TradeSummary {
  const closeTypeCounts: Record<string, number> = {}
  let wins = 0
  let netPnl = 0
  let fees = 0
  let volume = 0
  for (const t of trades) {
    if (t.netPnlQuote > 0) wins += 1
    netPnl += t.netPnlQuote
    fees += t.feesQuote
    volume += t.amountQuote
    closeTypeCounts[t.closeType] = (closeTypeCounts[t.closeType] ?? 0) + 1
  }
  return {
    count: trades.length,
    wins,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    netPnl,
    fees,
    volume,
    closeTypeCounts,
  }
}

/** A row of backtest processed_data. */
export interface ProcessedRow {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  resistance?: number
  support?: number
  rel_vol?: number
  signal?: number
  trend_ma?: number
  rsi?: number
}
