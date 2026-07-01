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
  /** The controller config this trade ran under (archived executors carry it). */
  rawConfig?: Record<string, unknown>
}

/** "15m" -> 900, "3m" -> 180, "1h" -> 3600. Falls back to 60s. */
export function intervalSecs(interval?: string): number {
  if (!interval) return 60
  const m = /^(\d+)\s*([smhd])$/.exec(interval.trim())
  if (!m) return 60
  const n = parseInt(m[1], 10)
  const u = m[2]
  return u === "s" ? n : u === "m" ? n * 60 : u === "h" ? n * 3600 : n * 86400
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
    rawConfig: Object.keys(cfg).length ? cfg : undefined,
  }
}

/**
 * Convert backtest `processed_data` into row objects.
 *
 * The API serializes a pandas DataFrame with `.to_dict()`, so each column is a
 * dict keyed by the row index: `{ "<idx>": value, ... }` — NOT a flat array.
 * There are also duplicate `*_bt` columns (the candles resampled to the backtest
 * resolution); we read the plain (live-resolution) columns. We tolerate an
 * array-of-rows shape and array columns too, just in case the shape ever changes.
 * Drops warm-up rows where timestamp/close is null, and sorts by time.
 */
export function processedToRows(pd: unknown): ProcessedRow[] {
  if (!pd) return []

  // Shape A: array of row objects.
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
        rel_vol: r.rel_vol == null ? undefined : num(r.rel_vol),
        signal: r.signal == null ? undefined : num(r.signal),
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  // Shape B: column-oriented. Normalize every column to an index->value map so
  // a column can be either a dict ({idx: val}) or an array ([val, ...]).
  const cols = pd as Record<string, unknown>
  const toMap = (col: unknown): Record<string, unknown> | null => {
    if (col == null) return null
    if (Array.isArray(col)) {
      const m: Record<string, unknown> = {}
      col.forEach((v, i) => (m[String(i)] = v))
      return m
    }
    if (typeof col === "object") return col as Record<string, unknown>
    return null
  }

  const tsMap = toMap(cols.timestamp)
  if (!tsMap) return []
  const maps: Record<string, Record<string, unknown> | null> = {}
  for (const k of ["open", "high", "low", "close", "volume", "resistance", "support", "rel_vol", "signal"]) {
    maps[k] = toMap(cols[k])
  }
  const at = (k: string, idx: string) => maps[k]?.[idx] ?? null

  const rows: ProcessedRow[] = []
  for (const idx of Object.keys(tsMap)) {
    const t = tsMap[idx]
    if (t == null || at("close", idx) == null) continue
    const res = at("resistance", idx)
    const sup = at("support", idx)
    const rv = at("rel_vol", idx)
    const sig = at("signal", idx)
    rows.push({
      timestamp: secs(t),
      open: num(at("open", idx)),
      high: num(at("high", idx)),
      low: num(at("low", idx)),
      close: num(at("close", idx)),
      volume: num(at("volume", idx)),
      resistance: res == null ? undefined : num(res),
      support: sup == null ? undefined : num(sup),
      rel_vol: rv == null ? undefined : num(rv),
      signal: sig == null ? undefined : num(sig),
    })
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Reconstruct round-trip trades from raw fills (the live-bot db has fills but no
 * executors until it's archived). Uses net-signed-inventory: legs that grow the
 * absolute position are entries, legs that shrink it are exits; a position closes
 * when signed inventory returns to zero. Mirrors trade_viz.py::fills_to_positions.
 *
 * Fills shape (from /archived-bots/{db}/trades): { timestamp(ms), trade_type
 * "BUY"|"SELL", price, amount, trade_fee_in_quote, trading_pair }.
 */
export function fillsToTrades(fills: Record<string, unknown>[]): Trade[] {
  const rows = fills
    .map((f) => ({
      ts: secs(f.timestamp),
      type: String(f.trade_type ?? "").toUpperCase(),
      price: num(f.price),
      amount: Math.abs(num(f.amount)),
      fee: num(f.trade_fee_in_quote ?? f.trade_fee),
      pair: String(f.trading_pair ?? ""),
    }))
    .filter((f) => f.amount > 0 && f.price > 0)
    .sort((a, b) => a.ts - b.ts)

  const trades: Trade[] = []
  let pos = 0
  let entryQty = 0
  let entryNotional = 0
  let exitQty = 0
  let exitNotional = 0
  let side: "LONG" | "SHORT" = "LONG"
  let openTs = 0
  let closeTs = 0
  let fees = 0
  let pair = ""
  let seq = 0

  const reset = () => {
    entryQty = 0
    entryNotional = 0
    exitQty = 0
    exitNotional = 0
    fees = 0
    openTs = 0
    closeTs = 0
  }

  for (const f of rows) {
    const signed = f.type === "BUY" ? f.amount : -f.amount
    const prev = pos
    if (prev === 0) {
      side = signed > 0 ? "LONG" : "SHORT"
      openTs = f.ts
      pair = f.pair
    }
    // A leg that pushes further from zero is an entry; one toward zero is an exit.
    const increasing = prev === 0 || Math.sign(signed) === Math.sign(prev)
    if (increasing) {
      entryQty += f.amount
      entryNotional += f.amount * f.price
    } else {
      exitQty += f.amount
      exitNotional += f.amount * f.price
      closeTs = f.ts
    }
    fees += f.fee
    pos = prev + signed
    if (Math.abs(pos) < 1e-9) pos = 0

    if (prev !== 0 && pos === 0) {
      const entry = entryQty ? entryNotional / entryQty : 0
      const exit = exitQty ? exitNotional / exitQty : entry
      const qty = entryQty
      const dir = side === "LONG" ? 1 : -1
      const amountQuote = entry * qty
      const net = (exit - entry) * qty * dir - fees
      trades.push({
        id: `fill-${openTs}-${seq++}`,
        controllerId: "",
        tradingPair: pair,
        side,
        entry,
        exit,
        amountQuote,
        netPnlQuote: net,
        netPnlPct: amountQuote ? net / amountQuote : 0,
        feesQuote: fees,
        closeType: "LIVE",
        ts: openTs,
        closeTs: closeTs || openTs,
      })
      reset()
    }
  }
  return trades
}

export interface TradePair {
  status: "matched" | "live-only" | "backtest-only"
  live?: Trade
  backtest?: Trade
  /** seconds between the two entries when matched */
  gap?: number
}

/**
 * Pair live trades with backtest trades that represent the SAME breakout: same
 * side and entry within `tol` seconds (live enters intrabar/earlier, backtest at
 * the close). Greedy nearest-match. Unmatched live = fake-outs the backtest never
 * took; unmatched backtest = breakouts live missed. Result is time-sorted.
 */
export function reconcileTrades(live: Trade[], backtest: Trade[], tol: number): TradePair[] {
  const used = new Set<number>()
  const pairs: TradePair[] = []
  for (const lv of [...live].sort((a, b) => a.ts - b.ts)) {
    let best = -1
    let bestD = Infinity
    backtest.forEach((bt, idx) => {
      if (used.has(idx) || bt.side !== lv.side) return
      const d = Math.abs(bt.ts - lv.ts)
      if (d <= tol && d < bestD) {
        bestD = d
        best = idx
      }
    })
    if (best >= 0) {
      used.add(best)
      pairs.push({ status: "matched", live: lv, backtest: backtest[best], gap: bestD })
    } else {
      pairs.push({ status: "live-only", live: lv })
    }
  }
  backtest.forEach((bt, idx) => {
    if (!used.has(idx)) pairs.push({ status: "backtest-only", backtest: bt })
  })
  return pairs.sort((a, b) => {
    const at = (a.live ?? a.backtest)!.ts
    const bt = (b.live ?? b.backtest)!.ts
    return at - bt
  })
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

/**
 * Rebuild the resistance/support/rel_vol/signal channel locally from raw candles,
 * an exact port of scalping_breakout.update_processed_data:
 *   resistance = high.rolling(range_lookback).max().shift(1)
 *   support    = low.rolling(range_lookback).min().shift(1)
 *   rel_vol    = volume / volume.rolling(vol_lookback).mean()
 *   LONG when close > resistance & rel_vol > mult ; SHORT when close < support & gate.
 * Lets the UI draw the channel without a throttled backtest.
 */
export function computeChannel(
  candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>,
  rangeLookback = 20,
  volLookback = 20,
  mult = 2,
): ProcessedRow[] {
  const c = [...candles].sort((a, b) => a.timestamp - b.timestamp)
  const out: ProcessedRow[] = []
  for (let i = 0; i < c.length; i++) {
    // Channel is the max high / min low of the `rangeLookback` bars BEFORE i (shift(1)).
    let resistance: number | undefined
    let support: number | undefined
    if (i >= rangeLookback) {
      let mx = -Infinity
      let mn = Infinity
      for (let j = i - rangeLookback; j <= i - 1; j++) {
        if (c[j].high > mx) mx = c[j].high
        if (c[j].low < mn) mn = c[j].low
      }
      resistance = mx
      support = mn
    }
    // rel_vol uses the rolling mean INCLUDING the current bar (no shift).
    let relVol: number | undefined
    if (i >= volLookback - 1) {
      let s = 0
      for (let j = i - volLookback + 1; j <= i; j++) s += c[j].volume
      const mean = s / volLookback
      relVol = mean > 0 ? c[i].volume / mean : undefined
    }
    let signal = 0
    if (resistance != null && relVol != null && c[i].close > resistance && relVol > mult) signal = 1
    else if (support != null && relVol != null && c[i].close < support && relVol > mult) signal = -1
    out.push({
      timestamp: c[i].timestamp,
      open: c[i].open,
      high: c[i].high,
      low: c[i].low,
      close: c[i].close,
      volume: c[i].volume,
      resistance,
      support,
      rel_vol: relVol,
      signal,
    })
  }
  return out
}

/**
 * Deterministic local backtest of the breakout controller over raw candles —
 * uses the reliable historical-candles feed instead of the throttle-prone
 * /backtesting/run. Mirrors the controller signal + a PositionExecutor-style
 * exit (stop-loss / take-profit / trailing / time-limit, checked intrabar on
 * each bar's high/low). Approximations: signals are read on CLOSED candles
 * (so it won't reproduce live's forming-candle/intrabar fake-out entries — that
 * gap IS the live-vs-backtest divergence), and when SL & TP are both touched in
 * one bar the stop is assumed first (conservative).
 */
export function simulateBreakout(
  candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>,
  config: Record<string, unknown>,
): Trade[] {
  const g = (k: string, d: number) => {
    const v = Number(config[k])
    return Number.isFinite(v) ? v : d
  }
  const rl = g("range_lookback", 20)
  const vl = g("vol_lookback", 20)
  const mult = g("rel_volume_mult", 2)
  const offset = g("signal_candle_offset", 0)
  const sl = g("stop_loss", 0)
  const tp = g("take_profit", 0)
  const timeLimit = g("time_limit", 0)
  const cooldown = g("cooldown_time", 0)
  const amountQuote = g("total_amount_quote", 0)
  const trail = config.trailing_stop as { activation_price?: number; trailing_delta?: number } | undefined
  const act = trail?.activation_price != null ? Number(trail.activation_price) : null
  const delta = trail?.trailing_delta != null ? Number(trail.trailing_delta) : null
  const pair = String(config.trading_pair ?? "")
  const feeRate = 0.0006

  const rows = computeChannel(candles, rl, vl, mult)
  const trades: Trade[] = []
  let lastCloseTs = -Infinity
  let i = 0
  while (i < rows.length) {
    const sIdx = i - offset
    const sig = sIdx >= 0 ? rows[sIdx].signal ?? 0 : 0
    if (sig === 0 || rows[i].timestamp < lastCloseTs + cooldown) {
      i++
      continue
    }
    const side: "LONG" | "SHORT" = sig === 1 ? "LONG" : "SHORT"
    const dir = sig
    const entry = rows[i].close
    const entryTs = rows[i].timestamp
    let stopPrice = side === "LONG" ? entry * (1 - sl) : entry * (1 + sl)
    const tpPrice = side === "LONG" ? entry * (1 + tp) : entry * (1 - tp)
    let peak = entry
    let trailArmed = false
    let exit: number | null = null
    let closeType = ""
    let closeTs = 0

    for (let j = i + 1; j < rows.length; j++) {
      const bar = rows[j]
      if (act != null && delta != null) {
        const fav = side === "LONG" ? bar.high : bar.low
        const actPrice = side === "LONG" ? entry * (1 + act) : entry * (1 - act)
        if (!trailArmed && (side === "LONG" ? fav >= actPrice : fav <= actPrice)) trailArmed = true
        if (trailArmed) {
          if (side === "LONG") {
            peak = Math.max(peak, bar.high)
            stopPrice = Math.max(stopPrice, peak * (1 - delta))
          } else {
            peak = Math.min(peak, bar.low)
            stopPrice = Math.min(stopPrice, peak * (1 + delta))
          }
        }
      }
      const hitStop = side === "LONG" ? bar.low <= stopPrice : bar.high >= stopPrice
      const hitTp = tp > 0 && (side === "LONG" ? bar.high >= tpPrice : bar.low <= tpPrice)
      if (hitStop) {
        exit = stopPrice
        closeType = trailArmed ? "TRAILING_STOP" : "STOP_LOSS"
        closeTs = bar.timestamp
        break
      }
      if (hitTp) {
        exit = tpPrice
        closeType = "TAKE_PROFIT"
        closeTs = bar.timestamp
        break
      }
      if (timeLimit > 0 && bar.timestamp - entryTs >= timeLimit) {
        exit = bar.close
        closeType = "TIME_LIMIT"
        closeTs = bar.timestamp
        break
      }
    }
    if (exit == null) break // position still open at the end of data — don't record

    const qty = amountQuote && entry ? amountQuote / entry : 1
    const notional = amountQuote || entry * qty
    const fees = notional * feeRate * 2
    const net = (exit - entry) * qty * dir - fees
    trades.push({
      id: `sim-${entryTs}`,
      controllerId: String(config.id ?? ""),
      tradingPair: pair,
      side,
      entry,
      exit,
      amountQuote: notional,
      netPnlQuote: net,
      netPnlPct: notional ? net / notional : 0,
      feesQuote: fees,
      closeType,
      ts: entryTs,
      closeTs,
    })
    lastCloseTs = closeTs
    while (i < rows.length && rows[i].timestamp <= closeTs) i++
  }
  return trades
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
