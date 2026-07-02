import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { SeriesMarker, Time, UTCTimestamp } from "lightweight-charts"

import {
  getAllBotsStatus,
  getAllControllerConfigs,
  getArchivedBots,
  getArchivedExecutors,
  getArchivedTrades,
  getBotControllerConfigs,
  getHistoricalCandles,
  isLiveDbPath,
  liveDbPath,
  runBacktest,
  type ControllerConfig,
} from "@/lib/api"
import { cleanCloseType, fmtNum, fmtTs, fmtUsd, pnlColor } from "@/lib/format"
import {
  computeChannel,
  fillsToTrades,
  intervalSecs,
  normalizeExecutor,
  processedToRows,
  reconcileTrades,
  type Trade,
} from "@/lib/trades"
import { CandleChart, type Candle, type OverlayLine } from "@/components/CandleChart"
import { TradeRows, TradeSummaryCards } from "@/components/TradeTable"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type Tab = "archived" | "backtest"

const botNameFromPath = (p: string) => p.split("/").slice(-1)[0]?.replace(/\.sqlite$/, "") ?? p

interface BotSource {
  path: string
  label: string
  live: boolean
}

/** Running bots (live db paths) + archived bots, as a single selectable list. */
function useBotSources(): { live: BotSource[]; archived: BotSource[] } {
  const bots = useQuery({
    queryKey: ["allBotsStatus"],
    queryFn: getAllBotsStatus,
    refetchInterval: 10_000,
  })
  const archived = useQuery({ queryKey: ["archivedBots"], queryFn: getArchivedBots })

  const live: BotSource[] = Object.keys(bots.data?.data ?? {}).map((name) => ({
    path: liveDbPath(name),
    label: name,
    live: true,
  }))
  const arch: BotSource[] = (archived.data ?? []).map((p) => ({
    path: p,
    label: botNameFromPath(p),
    live: false,
  }))
  return { live, archived: arch }
}

/**
 * Trades for any bot db path. Live bots have no executors until archived, so we
 * reconstruct round-trips from raw fills; archived bots use their executors
 * (richer: real close types + PnL). Live sources re-poll so the list stays fresh.
 */
function useBotTrades(dbPath: string): { trades: Trade[]; isLoading: boolean } {
  const live = isLiveDbPath(dbPath)
  const execs = useQuery({
    queryKey: ["archivedExecutors", dbPath],
    queryFn: () => getArchivedExecutors(dbPath),
    enabled: !!dbPath && !live,
  })
  const fills = useQuery({
    queryKey: ["botFills", dbPath],
    queryFn: () => getArchivedTrades(dbPath),
    enabled: !!dbPath && live,
    refetchInterval: 10_000,
  })

  if (!dbPath) return { trades: [], isLoading: false }
  if (live) {
    const trades = fillsToTrades(fills.data?.trades ?? []).sort((a, b) => a.ts - b.ts)
    return { trades, isLoading: fills.isLoading }
  }
  const trades = (execs.data?.executors ?? []).map(normalizeExecutor).sort((a, b) => a.ts - b.ts)
  return { trades, isLoading: execs.isLoading }
}

function tradesToMarkers(
  trades: Trade[],
  shape: "arrow" | "circle",
): Array<SeriesMarker<Time>> {
  return trades.map((t) => {
    const win = t.netPnlQuote > 0
    return {
      time: t.ts as UTCTimestamp,
      position: t.side === "LONG" ? "belowBar" : "aboveBar",
      color: win ? "#10b981" : "#ef4444",
      shape:
        shape === "circle"
          ? "circle"
          : t.side === "LONG"
            ? "arrowUp"
            : "arrowDown",
      text: t.closeType,
    }
  })
}

export function Analysis() {
  const [tab, setTab] = React.useState<Tab>("archived")
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trade Analysis</h1>
        <p className="text-sm text-muted-foreground">
          Archived round-trips, backtests, and live-vs-backtest comparison.
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          variant={tab === "archived" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("archived")}
        >
          Bot trades (live + archived)
        </Button>
        <Button
          variant={tab === "backtest" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("backtest")}
        >
          Backtest &amp; Compare
        </Button>
      </div>
      {tab === "archived" ? <BotTradesTab /> : <BacktestTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Archived bots
// ---------------------------------------------------------------------------

function BotTradesTab() {
  const [dbPath, setDbPath] = React.useState("")
  const [selected, setSelected] = React.useState<Trade | null>(null)
  const { live, archived } = useBotSources()
  const { trades, isLoading } = useBotTrades(dbPath)
  const isLive = !!dbPath && isLiveDbPath(dbPath)

  // Live bots' fills carry no config; fetch the running bot's controller config
  // so the detail view can recompute the channel it saw.
  const botName = isLive ? botNameFromPath(dbPath) : ""
  const botConfigs = useQuery({
    queryKey: ["botConfigs", botName],
    queryFn: () => getBotControllerConfigs(botName),
    enabled: !!botName,
  })

  React.useEffect(() => setSelected(null), [dbPath])

  const configForSelected =
    selected?.rawConfig ??
    (botConfigs.data ?? []).find((c) => c.trading_pair === selected?.tradingPair) ??
    (botConfigs.data ?? [])[0]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={dbPath}
          onChange={(e) => setDbPath(e.target.value)}
        >
          <option value="">Select a bot…</option>
          {live.length > 0 && (
            <optgroup label="● Live (running)">
              {live.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          )}
          {archived.length > 0 && (
            <optgroup label="Archived">
              {archived.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {isLive && (
          <Badge className="bg-emerald-600 text-white">
            live · reconstructed from fills · refreshes every 10s
          </Badge>
        )}
      </div>

      {!dbPath && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Pick a live or archived bot to see its round-trip trades.
          </CardContent>
        </Card>
      )}
      {dbPath && isLoading && (
        <p className="text-sm text-muted-foreground">Loading trades…</p>
      )}
      {dbPath && !isLoading && (
        <>
          <TradeSummaryCards trades={trades} />
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {isLive ? "Round-trips so far" : "Closed trades"} ({trades.length})
                <span className="ml-2 font-normal text-muted-foreground">
                  · click a row for the decision detail
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {trades.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isLive
                    ? "No completed round-trips yet — the bot has an open or no position."
                    : "No executors in this archive."}
                </p>
              ) : (
                <TradeRows trades={trades} onSelect={setSelected} selectedId={selected?.id} />
              )}
            </CardContent>
          </Card>

          {trades.length > 0 && (
            <LiveVsBacktest
              liveTrades={trades}
              config={
                (isLive ? (botConfigs.data ?? [])[0] : trades.find((t) => t.rawConfig)?.rawConfig) as
                  | Record<string, unknown>
                  | undefined
              }
              live={isLive}
            />
          )}

          {selected && (
            <TradeDetail
              key={selected.id}
              trade={selected}
              config={configForSelected as Record<string, unknown> | undefined}
            />
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Compare a controller's ACTUAL trades against a backtest of the same controller
// over the same window (min entry → max exit of the live trades).
// ---------------------------------------------------------------------------

function LiveVsBacktest({
  liveTrades,
  config,
  live,
}: {
  liveTrades: Trade[]
  config?: Record<string, unknown>
  live: boolean
}) {
  const [run, setRun] = React.useState(false)
  React.useEffect(() => setRun(false), [config])

  const interval = String(config?.interval ?? "1m")
  const iv = intervalSecs(interval)
  const tsList = liveTrades.flatMap((t) => [t.ts, t.closeTs || t.ts]).filter(Boolean)
  const start = tsList.length ? Math.min(...tsList) - iv * 10 : 0
  const end = tsList.length ? Math.max(...tsList) + iv * 10 : 0
  const connector = String(config?.candles_connector ?? config?.connector_name ?? "hyperliquid_perpetual")
  const pair = String(config?.candles_trading_pair ?? config?.trading_pair ?? liveTrades[0]?.tradingPair ?? "")

  const hist = useQuery({
    queryKey: ["liveVsHist", connector, pair, interval, start, end],
    queryFn: () => getHistoricalCandles(connector, pair, interval, start, end),
    enabled: run && !!config && !!start,
    staleTime: 5 * 60_000,
    retry: 2,
  })

  // The backtest trades come from the REAL engine (same numbers as the old
  // dashboard / Backtest tab / Optimizer) — the chart channel below is drawn
  // locally but is display-only. Retries ride out the HL candle throttle.
  const bt = useQuery({
    queryKey: ["liveVsBtEngine", config?.id, interval, start, end],
    queryFn: async () => {
      const req = {
        start_time: start,
        end_time: end,
        backtesting_resolution: interval,
        trade_cost: 0.0006,
        config: { ...config, id: String(config?.id ?? "cmp") },
      }
      let last = await runBacktest(req)
      for (let i = 0; i < 5 && processedToRows(last?.processed_data).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 700 * (i + 1)))
        last = await runBacktest(req)
      }
      return last
    },
    enabled: run && !!config && !!start,
    staleTime: 5 * 60_000,
  })

  const processed = React.useMemo(
    () =>
      computeChannel(
        hist.data ?? [],
        Number(config?.range_lookback ?? 20),
        Number(config?.vol_lookback ?? 20),
        Number(config?.rel_volume_mult ?? 2),
      ),
    [hist.data, config],
  )
  const candles: Candle[] = processed.map((r) => ({
    time: r.timestamp,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }))
  const lines: OverlayLine[] = React.useMemo(() => {
    const res = processed.filter((r) => r.resistance != null).map((r) => ({ time: r.timestamp, value: r.resistance! }))
    const sup = processed.filter((r) => r.support != null).map((r) => ({ time: r.timestamp, value: r.support! }))
    const out: OverlayLine[] = []
    if (res.length) out.push({ key: "resistance", color: "#ef4444", data: res })
    if (sup.length) out.push({ key: "support", color: "#10b981", data: sup })
    return out
  }, [processed])

  const btTrades: Trade[] = React.useMemo(
    () => (bt.data?.executors ?? []).map(normalizeExecutor).sort((a, b) => a.ts - b.ts),
    [bt.data],
  )
  const markers: Array<SeriesMarker<Time>> = React.useMemo(
    () =>
      [...tradesToMarkers(btTrades, "arrow"), ...tradesToMarkers(liveTrades, "circle")].sort(
        (a, b) => (a.time as number) - (b.time as number),
      ),
    [btTrades, liveTrades],
  )

  const loading = hist.isPending || bt.isPending

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="text-sm">
          {live ? "Live" : "Actual"} vs Backtest — same controller, same window
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!config ? (
          <p className="text-sm text-amber-500">No controller config for this bot to backtest.</p>
        ) : !run ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Model <b>{String(config.id)}</b> on the {interval} candles over its {liveTrades.length}{" "}
              {live ? "live" : "recorded"} trades' window ({fmtTs(start)} → {fmtTs(end)}) and overlay
              what actually happened.
            </p>
            <Button size="sm" onClick={() => setRun(true)}>
              Run backtest &amp; compare
            </Button>
          </div>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">
            Running the backtest engine on {String(config.id)} over the trade window…
          </p>
        ) : hist.isError || bt.isError ? (
          <p className="text-sm text-red-500">
            {((hist.error ?? bt.error) as Error).message}
          </p>
        ) : (
          <>
            {candles.length > 0 && (
              <CandleChart candles={candles} lines={lines} markers={markers} height={420} />
            )}
            <div className="rounded-md border-l-2 border-primary/50 bg-primary/5 p-3 text-xs">
              <div className="font-medium">
                {live ? "Live" : "Actual"}: {liveTrades.length} trades · Backtest (real engine,{" "}
                {interval} resolution): {btTrades.length} trades
              </div>
              <div className="mt-1 text-muted-foreground">
                {btTrades.length < liveTrades.length
                  ? `Your bot took ${liveTrades.length - btTrades.length} more trade(s) than the engine backtest. If the bot ran offset 0 (forming candle) it entered intrabar on spikes the closed-bar engine never saw; slippage and restarts also contribute.`
                  : btTrades.length > liveTrades.length
                    ? "The engine fired more trades than live — live may have been down, in cooldown, or restarted during this window."
                    : "Live and the engine fired the same number of trades here."}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Circles = {live ? "live" : "actual"} entries · arrows = engine-backtest entries ·
              green = winner, red = loser.
            </p>

            <TradeReconciliation live={liveTrades} backtest={btTrades} tol={iv * 2} liveLabel={live ? "Live" : "Actual"} />

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-medium">
                  {live ? "Live" : "Actual"} aggregate ({liveTrades.length})
                </div>
                <TradeSummaryCards trades={liveTrades} />
              </div>
              <div>
                <div className="mb-2 text-xs font-medium">Backtest aggregate ({btTrades.length})</div>
                {btTrades.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    The engine fires no trades in this window with this config.
                  </p>
                ) : (
                  <TradeSummaryCards trades={btTrades} />
                )}
              </div>
            </div>
            <DivergenceNotes resolution={interval} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Reconcile live vs backtest trades: match same-breakout pairs, flag live-only
// (fake-outs) and backtest-only (missed), and show theoretical-vs-actual fills.
// ---------------------------------------------------------------------------

function TradeReconciliation({
  live,
  backtest,
  tol,
  liveLabel,
}: {
  live: Trade[]
  backtest: Trade[]
  tol: number
  liveLabel: string
}) {
  const pairs = React.useMemo(() => reconcileTrades(live, backtest, tol), [live, backtest, tol])
  const [open, setOpen] = React.useState<number | null>(null)
  const matched = pairs.filter((p) => p.status === "matched").length
  const liveOnly = pairs.filter((p) => p.status === "live-only").length
  const btOnly = pairs.filter((p) => p.status === "backtest-only").length

  const cell = (t?: Trade) =>
    t ? (
      <span className="tabular-nums">
        {fmtNum(t.entry, t.entry > 1000 ? 1 : 4)} → {fmtNum(t.exit, t.exit > 1000 ? 1 : 4)}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Matched trades</span>
        <Badge variant="secondary">{matched} matched</Badge>
        <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400">
          {liveOnly} {liveLabel.toLowerCase()}-only (fake-outs)
        </Badge>
        <Badge className="bg-sky-500/15 text-sky-600 dark:text-sky-400">{btOnly} backtest-only (missed)</Badge>
      </div>
      <div className="overflow-auto rounded-md border text-xs">
        <table className="w-full">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Match</th>
              <th className="px-2 py-1.5 text-left font-medium">Side</th>
              <th className="px-2 py-1.5 text-left font-medium">Time</th>
              <th className="px-2 py-1.5 text-right font-medium">{liveLabel} entry → exit</th>
              <th className="px-2 py-1.5 text-right font-medium">Backtest entry → exit</th>
              <th className="px-2 py-1.5 text-right font-medium">{liveLabel} PnL</th>
              <th className="px-2 py-1.5 text-right font-medium">BT PnL</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => {
              const t = p.live ?? p.backtest!
              const rowBg =
                p.status === "live-only"
                  ? "bg-amber-500/5"
                  : p.status === "backtest-only"
                    ? "bg-sky-500/5"
                    : ""
              const clickable = p.status === "matched"
              return (
                <React.Fragment key={i}>
                  <tr
                    className={`border-t ${rowBg} ${clickable ? "cursor-pointer hover:bg-muted/50" : ""}`}
                    onClick={() => clickable && setOpen(open === i ? null : i)}
                  >
                    <td className="px-2 py-1.5">
                      {p.status === "matched" ? (
                        <span className="text-emerald-500">✓ pair</span>
                      ) : p.status === "live-only" ? (
                        <span className="text-amber-600 dark:text-amber-400">⚠ live-only</span>
                      ) : (
                        <span className="text-sky-600 dark:text-sky-400">○ missed</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge
                        className={`text-[10px] ${t.side === "LONG" ? "bg-emerald-600" : "bg-red-600"} text-white`}
                      >
                        {t.side}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{fmtTs(t.ts)}</td>
                    <td className="px-2 py-1.5 text-right">{cell(p.live)}</td>
                    <td className="px-2 py-1.5 text-right">{cell(p.backtest)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${p.live ? pnlColor(p.live.netPnlQuote) : ""}`}>
                      {p.live ? fmtUsd(p.live.netPnlQuote) : "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${p.backtest ? pnlColor(p.backtest.netPnlQuote) : ""}`}>
                      {p.backtest ? fmtUsd(p.backtest.netPnlQuote) : "—"}
                    </td>
                  </tr>
                  {open === i && p.status === "matched" && (
                    <tr className="border-t bg-muted/20">
                      <td colSpan={7} className="px-3 py-2">
                        <FillDetail live={p.live!} bt={p.backtest!} gap={p.gap} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            {pairs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">
                  No trades to reconcile.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Click a ✓ pair to see the theoretical (backtest) fill vs the live fill — how much slippage
        you paid on entry and exit. ⚠ {liveLabel.toLowerCase()}-only rows are fake-outs the backtest
        rejected.
      </p>
    </div>
  )
}

function FillDetail({ live, bt, gap }: { live: Trade; bt: Trade; gap?: number }) {
  const dp = live.entry > 1000 ? 1 : 4
  // Slippage: worse = you got a less favourable price than the model assumed.
  const entryDiff = live.entry - bt.entry
  const entryWorse = live.side === "LONG" ? entryDiff > 0 : entryDiff < 0
  const exitDiff = live.exit - bt.exit
  const exitWorse = live.side === "LONG" ? exitDiff < 0 : exitDiff > 0

  const Leg = ({
    label,
    theo,
    actual,
    diff,
    worse,
  }: {
    label: string
    theo: number
    actual: number
    diff: number
    worse: boolean
  }) => (
    <div className="rounded-md border p-2">
      <div className="text-[11px] font-medium">{label}</div>
      <div className="mt-1 grid grid-cols-3 gap-2 tabular-nums">
        <div>
          <div className="text-[10px] text-muted-foreground">Backtest (theory)</div>
          <div>{fmtNum(theo, dp)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Live (actual)</div>
          <div>{fmtNum(actual, dp)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Slippage</div>
          <div className={worse ? "text-red-500" : "text-emerald-500"}>
            {diff >= 0 ? "+" : ""}
            {fmtNum(diff, dp)} ({fmtNum((diff / theo) * 100, 3)}%) {worse ? "worse" : "better"}
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">
        {live.side} · backtest entered {gap != null ? `${Math.round(gap / 60)} min ${live.ts <= bt.ts ? "after" : "before"} live` : "near live"} ·
        backtest closed via <b>{cleanCloseType(bt.closeType)}</b>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Leg label="Entry fill" theo={bt.entry} actual={live.entry} diff={entryDiff} worse={entryWorse} />
        <Leg label="Exit fill" theo={bt.exit} actual={live.exit} diff={exitDiff} worse={exitWorse} />
      </div>
      <div className="text-[11px]">
        Result: live <span className={pnlColor(live.netPnlQuote)}>{fmtUsd(live.netPnlQuote)}</span> vs
        backtest <span className={pnlColor(bt.netPnlQuote)}>{fmtUsd(bt.netPnlQuote)}</span> —{" "}
        {live.netPnlQuote >= bt.netPnlQuote
          ? "live did as well or better than the model here."
          : `live gave up ${fmtUsd(bt.netPnlQuote - live.netPnlQuote)} to slippage/exec vs the model.`}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-trade decision detail — recompute the channel this trade saw by running a
// scoped backtest over its window with the trade's own config, then overlay the
// actual entry/exit. Explains why it entered (breakout) and why it closed.
// ---------------------------------------------------------------------------

const CLOSE_REASON: Record<string, (c: Record<string, unknown>) => string> = {
  STOP_LOSS: (c) =>
    `Hit the stop loss${c.stop_loss ? ` (−${fmtNum(Number(c.stop_loss) * 100, 2)}%)` : ""} — price moved against the position.`,
  TAKE_PROFIT: (c) =>
    `Hit take profit${c.take_profit ? ` (+${fmtNum(Number(c.take_profit) * 100, 2)}%)` : ""}.`,
  TRAILING_STOP: () =>
    "Trailing stop triggered — price advanced then reversed past the trailing delta.",
  TIME_LIMIT: () => "Max holding time reached (time limit) — position closed flat.",
  EARLY_STOP: () => "Controller stopped the position early (signal flipped or bot stopped).",
  LIVE: () => "Exit reason isn't recorded in raw fills — inferred from the price move below.",
}

function TradeDetail({
  trade,
  config,
}: {
  trade: Trade
  config?: Record<string, unknown>
}) {
  const interval = String(config?.interval ?? "1m")
  const iv = intervalSecs(interval)
  const start = trade.ts - iv * 40
  const end = (trade.closeTs || trade.ts) + iv * 20
  const connector = String(config?.candles_connector ?? config?.connector_name ?? "hyperliquid_perpetual")
  const pair = String(config?.candles_trading_pair ?? config?.trading_pair ?? trade.tradingPair)

  // Draw the trade from raw candles + a locally-rebuilt channel — NO backtest,
  // so it isn't subject to the Hyperliquid backtest-candle throttle.
  const bt = useQuery({
    queryKey: ["tradeDetail", connector, pair, interval, start, end],
    queryFn: () => getHistoricalCandles(connector, pair, interval, start, end),
    enabled: !!config,
    staleTime: 5 * 60_000,
    retry: 2,
  })

  const processed = React.useMemo(
    () =>
      computeChannel(
        bt.data ?? [],
        Number(config?.range_lookback ?? 20),
        Number(config?.vol_lookback ?? 20),
        Number(config?.rel_volume_mult ?? 2),
      ),
    [bt.data, config],
  )
  const candles: Candle[] = processed.map((r) => ({
    time: r.timestamp,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }))
  const lines: OverlayLine[] = React.useMemo(() => {
    const res = processed.filter((r) => r.resistance != null).map((r) => ({ time: r.timestamp, value: r.resistance! }))
    const sup = processed.filter((r) => r.support != null).map((r) => ({ time: r.timestamp, value: r.support! }))
    const out: OverlayLine[] = []
    if (res.length) out.push({ key: "resistance", color: "#ef4444", data: res })
    if (sup.length) out.push({ key: "support", color: "#10b981", data: sup })
    return out
  }, [processed])

  // The candle nearest the entry — what the channel looked like at that moment.
  const entryRow = React.useMemo(() => {
    let best: (typeof processed)[number] | undefined
    let bestD = Infinity
    for (const r of processed) {
      const d = Math.abs(r.timestamp - trade.ts)
      if (d < bestD) {
        bestD = d
        best = r
      }
    }
    return best
  }, [processed, trade.ts])

  const markers: Array<SeriesMarker<Time>> = [
    {
      time: trade.ts as UTCTimestamp,
      position: trade.side === "LONG" ? "belowBar" : "aboveBar",
      color: trade.side === "LONG" ? "#10b981" : "#ef4444",
      shape: trade.side === "LONG" ? "arrowUp" : "arrowDown",
      text: `ENTER ${trade.side} @ ${fmtNum(trade.entry, 4)}`,
    },
    {
      time: (trade.closeTs || trade.ts) as UTCTimestamp,
      position: trade.side === "LONG" ? "aboveBar" : "belowBar",
      color: trade.netPnlQuote >= 0 ? "#10b981" : "#ef4444",
      shape: "circle",
      text: `EXIT ${cleanCloseType(trade.closeType)} @ ${fmtNum(trade.exit, 4)}`,
    },
  ]

  const whyEnter =
    trade.side === "LONG"
      ? `Price broke **above resistance** — a long breakout. ${entryRow?.resistance != null ? `Channel top was ${fmtNum(entryRow.resistance, 4)}; entry filled at ${fmtNum(trade.entry, 4)}.` : ""}`
      : `Price broke **below support** — a short breakout. ${entryRow?.support != null ? `Channel bottom was ${fmtNum(entryRow.support, 4)}; entry filled at ${fmtNum(trade.entry, 4)}.` : ""}`
  const relInfo =
    entryRow?.rel_vol != null && config?.rel_volume_mult != null
      ? `Relative volume ${fmtNum(entryRow.rel_vol, 2)}× vs the ${fmtNum(Number(config.rel_volume_mult), 1)}× required to arm the breakout.`
      : ""
  const reasonFn = CLOSE_REASON[trade.closeType] ?? CLOSE_REASON.LIVE
  const whyExit = `${reasonFn(config ?? {})} Exit ${fmtNum(trade.exit, 4)} = ${trade.netPnlPct >= 0 ? "+" : ""}${fmtNum(trade.netPnlPct * 100, 2)}% vs entry (${fmtUsd(trade.netPnlQuote)}).`

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Badge className={trade.side === "LONG" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}>
            {trade.side}
          </Badge>
          <span className="font-mono">{trade.tradingPair}</span>
          <span className="text-muted-foreground">
            {fmtTs(trade.ts)} → {fmtTs(trade.closeTs)}
          </span>
          <span className={`ml-auto tabular-nums ${pnlColor(trade.netPnlQuote)}`}>
            {fmtUsd(trade.netPnlQuote)} ({fmtNum(trade.netPnlPct * 100, 2)}%)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ParamGrid config={config} />

        {!config && (
          <p className="text-sm text-amber-500">
            No controller config available for this trade, so the channel can't be recomputed.
          </p>
        )}
        {config && bt.isPending && (
          <p className="text-sm text-muted-foreground">Loading candles + rebuilding the channel…</p>
        )}
        {config && bt.isError && (
          <p className="text-sm text-red-500">{(bt.error as Error).message}</p>
        )}
        {config && bt.data && candles.length === 0 && (
          <p className="text-sm text-amber-500">No candles returned for this window.</p>
        )}
        {candles.length > 0 && (
          <CandleChart candles={candles} lines={lines} markers={markers} height={360} />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Reason title="Why it entered" tone="enter">
            <Markdownish text={whyEnter} />
            {relInfo && <p className="mt-1 text-muted-foreground">{relInfo}</p>}
          </Reason>
          <Reason title="Why it closed" tone="exit">
            <Markdownish text={whyExit} />
          </Reason>
        </div>
      </CardContent>
    </Card>
  )
}

function ParamGrid({ config }: { config?: Record<string, unknown> }) {
  if (!config) return null
  const g = (k: string) => config[k]
  const pct = (k: string) => (g(k) != null ? `${fmtNum(Number(g(k)) * 100, 2)}%` : "—")
  const trailing = g("trailing_stop") as { activation_price?: number; trailing_delta?: number } | undefined
  const items: Array<[string, string]> = [
    ["Interval", String(g("interval") ?? "—")],
    ["Stop loss", pct("stop_loss")],
    ["Take profit", pct("take_profit")],
    [
      "Trailing",
      trailing
        ? `act ${fmtNum((trailing.activation_price ?? 0) * 100, 2)}% / Δ ${fmtNum((trailing.trailing_delta ?? 0) * 100, 2)}%`
        : "—",
    ],
    ["Rel vol ×", g("rel_volume_mult") != null ? `${fmtNum(Number(g("rel_volume_mult")), 2)}×` : "—"],
    ["Range lookback", String(g("range_lookback") ?? "—")],
    ["Vol lookback", String(g("vol_lookback") ?? "—")],
    ["Signal offset", String(g("signal_candle_offset") ?? "—")],
  ]
  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-4 lg:grid-cols-8">
      {items.map(([k, v]) => (
        <div key={k}>
          <div className="text-muted-foreground">{k}</div>
          <div className="font-mono tabular-nums">{v}</div>
        </div>
      ))}
    </div>
  )
}

function Reason({
  title,
  tone,
  children,
}: {
  title: string
  tone: "enter" | "exit"
  children: React.ReactNode
}) {
  return (
    <div
      className={`rounded-md border-l-2 p-3 text-xs ${
        tone === "enter" ? "border-emerald-500 bg-emerald-500/5" : "border-red-500 bg-red-500/5"
      }`}
    >
      <div className="mb-1 font-medium">{title}</div>
      {children}
    </div>
  )
}

/** Render **bold** spans without pulling in a markdown lib. */
function Markdownish({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <p>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <b key={i}>{p.slice(2, -2)}</b>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Backtest & Compare
// ---------------------------------------------------------------------------

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function BacktestTab() {
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })
  const { live: liveBots, archived: archivedBots } = useBotSources()

  const [configId, setConfigId] = React.useState("")
  const [start, setStart] = React.useState(isoDaysAgo(3))
  const [end, setEnd] = React.useState(isoDaysAgo(1))
  const [resolution, setResolution] = React.useState("1m")
  const [tradeCostPct, setTradeCostPct] = React.useState(0.06)
  const [comparePath, setComparePath] = React.useState("")

  const cfg: ControllerConfig | undefined = (configs.data ?? []).find((c) => c.id === configId)

  const bt = useMutation({
    mutationFn: async () => {
      if (!cfg) throw new Error("Pick a controller config first")
      const req = {
        start_time: Math.floor(new Date(`${start}T00:00:00`).getTime() / 1000),
        end_time: Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000),
        backtesting_resolution: resolution,
        trade_cost: tradeCostPct / 100,
        config: { ...cfg, id: cfg.id },
      }
      // Hyperliquid's backtest candle fetch alternates empty/full — retry a few
      // times until the sim actually has data instead of failing on a throttle.
      let last = await runBacktest(req)
      for (let i = 0; i < 3 && processedToRows(last?.processed_data).length === 0; i++) {
        last = await runBacktest(req)
      }
      return last
    },
  })

  const { trades: liveTrades } = useBotTrades(comparePath)

  const result = bt.data
  const winStart = Math.floor(new Date(`${start}T00:00:00`).getTime() / 1000)
  const winEnd = Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000)

  // Draw the chart from the RELIABLE historical-candles endpoint + a locally
  // rebuilt channel, instead of the backtest's throttle-prone processed_data.
  // The backtest is still the source of the simulated executors + results.
  const hist = useQuery({
    queryKey: ["btHist", cfg?.candles_connector ?? cfg?.connector_name, cfg?.candles_trading_pair ?? cfg?.trading_pair, cfg?.interval, winStart, winEnd],
    queryFn: () =>
      getHistoricalCandles(
        String(cfg?.candles_connector ?? cfg?.connector_name),
        String(cfg?.candles_trading_pair ?? cfg?.trading_pair),
        String(cfg?.interval ?? "1m"),
        winStart,
        winEnd,
      ),
    enabled: !!result && !!cfg,
    staleTime: 5 * 60_000,
    retry: 2,
  })

  const processedHist = React.useMemo(
    () =>
      computeChannel(
        hist.data ?? [],
        Number(cfg?.range_lookback ?? 20),
        Number(cfg?.vol_lookback ?? 20),
        Number(cfg?.rel_volume_mult ?? 2),
      ),
    [hist.data, cfg],
  )
  const processedBt = React.useMemo(() => processedToRows(result?.processed_data), [result])
  const processed = processedHist.length ? processedHist : processedBt

  const candles: Candle[] = processed.map((r) => ({
    time: r.timestamp,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }))

  const lines: OverlayLine[] = React.useMemo(() => {
    const res = processed.filter((r) => r.resistance != null).map((r) => ({ time: r.timestamp, value: r.resistance! }))
    const sup = processed.filter((r) => r.support != null).map((r) => ({ time: r.timestamp, value: r.support! }))
    const out: OverlayLine[] = []
    if (res.length) out.push({ key: "resistance", color: "#ef4444", data: res })
    if (sup.length) out.push({ key: "support", color: "#10b981", data: sup })
    return out
  }, [processed])

  const btTrades: Trade[] = React.useMemo(
    () => (result?.executors ?? []).map(normalizeExecutor).sort((a, b) => a.ts - b.ts),
    [result],
  )

  // Only overlay the actual trades that fall inside the backtested window, so the
  // comparison is apples-to-apples (e.g. "last 24h live vs backtest same 24h").
  const windowLive = React.useMemo(
    () => liveTrades.filter((t) => t.ts >= winStart && t.ts <= winEnd),
    [liveTrades, winStart, winEnd],
  )

  const markers = React.useMemo(
    () => [...tradesToMarkers(btTrades, "arrow"), ...tradesToMarkers(windowLive, "circle")].sort(
      (a, b) => (a.time as number) - (b.time as number),
    ),
    [btTrades, windowLive],
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 py-4 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Controller config" className="lg:col-span-2">
            <select
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={configId}
              onChange={(e) => setConfigId(e.target.value)}
            >
              <option value="">Select…</option>
              {(configs.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} ({c.trading_pair} {c.interval})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start">
            <input
              type="date"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="End">
            <input
              type="date"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
          <Field label="Resolution">
            <select
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              {["1s", "1m", "3m", "5m", "15m", "30m", "1h"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Trade cost %">
            <input
              type="number"
              step="0.01"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={tradeCostPct}
              onChange={(e) => setTradeCostPct(parseFloat(e.target.value) || 0)}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button size="sm" disabled={!cfg || bt.isPending} onClick={() => bt.mutate()}>
              {bt.isPending ? "Running…" : "Run backtest"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStart(isoDaysAgo(1))
                setEnd(isoToday())
              }}
            >
              Last 24h
            </Button>
          </div>
        </CardContent>
      </Card>

      {bt.isError && (
        <Card>
          <CardContent className="py-4 text-sm text-red-500">
            {(bt.error as Error).message}
          </CardContent>
        </Card>
      )}

      {result && (
        <>
          {processed.length === 0 ? (
            <Card>
              <CardContent className="py-4 text-sm text-muted-foreground">
                {hist.isPending
                  ? "Loading candles for the chart…"
                  : "No candles returned for this window — try a different date range."}
              </CardContent>
            </Card>
          ) : (
            <>
              <ResultsStrip results={result.results} />
              <TradeSummaryCards trades={btTrades} />

              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-sm">
                    Backtest chart{" "}
                    {comparePath &&
                      `· ${windowLive.length} actual trades in window${liveTrades.length > windowLive.length ? ` (of ${liveTrades.length} total)` : ""}`}
                  </CardTitle>
                  <select
                    className="rounded-md border bg-background px-2 py-1 text-xs"
                    value={comparePath}
                    onChange={(e) => setComparePath(e.target.value)}
                  >
                    <option value="">Overlay actual trades from…</option>
                    {liveBots.length > 0 && (
                      <optgroup label="● Live (running)">
                        {liveBots.map((s) => (
                          <option key={s.path} value={s.path}>
                            {s.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {archivedBots.length > 0 && (
                      <optgroup label="Archived">
                        {archivedBots.map((s) => (
                          <option key={s.path} value={s.path}>
                            {s.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </CardHeader>
                <CardContent>
                  <CandleChart candles={candles} lines={lines} markers={markers} height={460} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Arrows = backtest entries · circles = live entries · green = winner, red =
                    loser. Resistance (red) / support (green) are the breakout channel.
                  </p>
                </CardContent>
              </Card>

              {comparePath && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">
                      Actual trades in this window ({windowLive.length}) vs backtest (
                      {btTrades.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {windowLive.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No actual trades fell inside the backtested window. Use{" "}
                        <b>Last 24h</b> (or widen the dates) to line them up with recent live
                        activity.
                      </p>
                    ) : (
                      <>
                        <TradeSummaryCards trades={windowLive} />
                        <TradeRows trades={windowLive} />
                      </>
                    )}
                  </CardContent>
                </Card>
              )}

              <DivergenceNotes resolution={resolution} />
            </>
          )}
        </>
      )}
    </div>
  )
}

function ResultsStrip({ results }: { results?: Record<string, unknown> }) {
  if (!results) return null
  const g = (k: string) => {
    const v = results[k]
    return typeof v === "number" ? v : undefined
  }
  const items: Array<{ label: string; value: string; cls?: string }> = [
    { label: "Net PnL", value: fmtUsd(g("net_pnl_quote")), cls: pnlColor(g("net_pnl_quote")) },
    { label: "Accuracy", value: g("accuracy") != null ? `${fmtNum(g("accuracy")! * 100, 1)}%` : "—" },
    { label: "Profit factor", value: fmtNum(g("profit_factor"), 2) },
    { label: "Sharpe", value: fmtNum(g("sharpe_ratio"), 2) },
    { label: "Max DD", value: g("max_drawdown_pct") != null ? `${fmtNum(g("max_drawdown_pct")! * 100, 1)}%` : "—", cls: "text-red-500" },
    { label: "Positions", value: fmtNum(g("total_positions"), 0) },
  ]
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {items.map((it) => (
        <Card key={it.label}>
          <CardContent className="py-3">
            <div className="text-xs text-muted-foreground">{it.label}</div>
            <div className={`mt-0.5 text-base font-semibold tabular-nums ${it.cls ?? ""}`}>
              {it.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs ${className ?? ""}`}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function DivergenceNotes({ resolution }: { resolution: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Why live and backtest differ</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-xs text-muted-foreground">
        <p>
          • <b>Trailing stop invisible at coarse resolution.</b> The 0.3%/0.15% trailing stop
          rarely triggers at {resolution}; use 1m/1s to approximate live fills.
        </p>
        <p>
          • <b>Repaint.</b> Live uses the forming candle (signal_candle_offset 0) so it can enter
          intra-bar on fake-outs; the backtest is closed-bar. Set offset 1 to align them.
        </p>
        <p>
          • <b>Candle snapshot vs live feed.</b> Backtest runs over a cached Hyperliquid snapshot;
          live ticks on fresh data, so entries can differ even with identical logic.
        </p>
      </CardContent>
    </Card>
  )
}
