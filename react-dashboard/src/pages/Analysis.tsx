import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { SeriesMarker, Time, UTCTimestamp } from "lightweight-charts"

import {
  getAllControllerConfigs,
  getArchivedBots,
  getArchivedExecutors,
  runBacktest,
  type ControllerConfig,
} from "@/lib/api"
import { fmtNum, fmtUsd, pnlColor } from "@/lib/format"
import { normalizeExecutor, processedToRows, type Trade } from "@/lib/trades"
import { CandleChart, type Candle, type OverlayLine } from "@/components/CandleChart"
import { TradeRows, TradeSummaryCards } from "@/components/TradeTable"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type Tab = "archived" | "backtest"

const botNameFromPath = (p: string) => p.split("/").slice(-1)[0]?.replace(/\.sqlite$/, "") ?? p

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
          Archived bots
        </Button>
        <Button
          variant={tab === "backtest" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("backtest")}
        >
          Backtest &amp; Compare
        </Button>
      </div>
      {tab === "archived" ? <ArchivedTab /> : <BacktestTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Archived bots
// ---------------------------------------------------------------------------

function ArchivedTab() {
  const [dbPath, setDbPath] = React.useState("")
  const archived = useQuery({ queryKey: ["archivedBots"], queryFn: getArchivedBots })
  const execs = useQuery({
    queryKey: ["archivedExecutors", dbPath],
    queryFn: () => getArchivedExecutors(dbPath),
    enabled: !!dbPath,
  })

  const trades: Trade[] = (execs.data?.executors ?? [])
    .map(normalizeExecutor)
    .sort((a, b) => a.ts - b.ts)

  return (
    <div className="space-y-4">
      <select
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={dbPath}
        onChange={(e) => setDbPath(e.target.value)}
      >
        <option value="">Select an archived bot…</option>
        {(archived.data ?? []).map((p) => (
          <option key={p} value={p}>
            {botNameFromPath(p)}
          </option>
        ))}
      </select>

      {!dbPath && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Pick an archived bot to see its closed trades.
          </CardContent>
        </Card>
      )}
      {dbPath && execs.isLoading && (
        <p className="text-sm text-muted-foreground">Loading executors…</p>
      )}
      {dbPath && execs.data && (
        <>
          <TradeSummaryCards trades={trades} />
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Closed trades ({trades.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {trades.length === 0 ? (
                <p className="text-sm text-muted-foreground">No executors in this archive.</p>
              ) : (
                <TradeRows trades={trades} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
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

function BacktestTab() {
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })
  const archived = useQuery({ queryKey: ["archivedBots"], queryFn: getArchivedBots })

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
      return runBacktest({
        start_time: Math.floor(new Date(`${start}T00:00:00`).getTime() / 1000),
        end_time: Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000),
        backtesting_resolution: resolution,
        trade_cost: tradeCostPct / 100,
        config: { ...cfg, id: cfg.id },
      })
    },
  })

  const compare = useQuery({
    queryKey: ["archivedExecutors", comparePath],
    queryFn: () => getArchivedExecutors(comparePath),
    enabled: !!comparePath,
  })

  // Parse backtest result. processed_data is column-oriented (dict of arrays).
  const result = bt.data
  const processed = React.useMemo(() => processedToRows(result?.processed_data), [result])

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
  const liveTrades: Trade[] = React.useMemo(
    () => (compare.data?.executors ?? []).map(normalizeExecutor).sort((a, b) => a.ts - b.ts),
    [compare.data],
  )

  const markers = React.useMemo(
    () => [...tradesToMarkers(btTrades, "arrow"), ...tradesToMarkers(liveTrades, "circle")].sort(
      (a, b) => (a.time as number) - (b.time as number),
    ),
    [btTrades, liveTrades],
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
          <div className="flex items-end">
            <Button size="sm" disabled={!cfg || bt.isPending} onClick={() => bt.mutate()}>
              {bt.isPending ? "Running…" : "Run backtest"}
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
              <CardContent className="py-4 text-sm text-amber-500">
                No candle data returned — Hyperliquid is likely throttling the public candle
                feed (transient, not "no trades"). Wait a few seconds and run again.
              </CardContent>
            </Card>
          ) : (
            <>
              <ResultsStrip results={result.results} />
              <TradeSummaryCards trades={btTrades} />

              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-sm">
                    Backtest chart {liveTrades.length > 0 && "· live overlay"}
                  </CardTitle>
                  <select
                    className="rounded-md border bg-background px-2 py-1 text-xs"
                    value={comparePath}
                    onChange={(e) => setComparePath(e.target.value)}
                  >
                    <option value="">Overlay live trades from…</option>
                    {(archived.data ?? []).map((p) => (
                      <option key={p} value={p}>
                        {botNameFromPath(p)}
                      </option>
                    ))}
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

              {liveTrades.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Live trades (overlay)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TradeSummaryCards trades={liveTrades} />
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
