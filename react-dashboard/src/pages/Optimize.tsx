import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  getAllControllerConfigs,
  getHistoricalCandles,
  runBacktest,
  saveControllerConfig,
  type ControllerConfig,
} from "@/lib/api"
import { fmtNum, fmtUsd, pnlColor } from "@/lib/format"
import { normalizeExecutor, processedToRows, summarize } from "@/lib/trades"
import { DEFAULT_RANGES, runOptimize, type Candidate } from "@/lib/optimize"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

interface EngineResult {
  net: number
  trades: number
  win: number
  maxDD: number
  rar: number
}

const originBadge: Record<Candidate["origin"], { label: string; cls: string }> = {
  search: { label: "search", cls: "bg-muted text-muted-foreground" },
  surface: { label: "least-squares", cls: "bg-violet-600 text-white" },
  centroid: { label: "region center", cls: "bg-sky-600 text-white" },
}

export function Optimize() {
  const qc = useQueryClient()
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })

  const [baseId, setBaseId] = React.useState("")
  const [days, setDays] = React.useState(14)
  const [folds, setFolds] = React.useState(3)
  const [samples, setSamples] = React.useState(300)
  const [minTrades, setMinTrades] = React.useState(2)

  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [results, setResults] = React.useState<Candidate[] | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<number | null>(null)

  // Engine-verified numbers for the top finalists (real /backtesting/run).
  const [verifying, setVerifying] = React.useState(false)
  const [verified, setVerified] = React.useState<Record<number, EngineResult>>({})

  const cfg: ControllerConfig | undefined = (configs.data ?? []).find((c) => c.id === baseId)

  async function verifyTop(cands: Candidate[], interval: string, days: number) {
    setVerifying(true)
    setVerified({})
    const now = Math.floor(Date.now() / 1000)
    const start = now - days * 86400
    for (let idx = 0; idx < cands.length; idx++) {
      try {
        const req = {
          start_time: start,
          end_time: now,
          backtesting_resolution: interval,
          trade_cost: 0.0006,
          config: { ...cands[idx].config, id: String(cands[idx].config.id ?? "opt") },
        }
        let bt = await runBacktest(req)
        for (let r = 0; r < 3 && processedToRows(bt?.processed_data).length === 0; r++) bt = await runBacktest(req)
        const trades = (bt?.executors ?? []).map(normalizeExecutor)
        const s = summarize(trades)
        let eq = 0
        let peak = 0
        let dd = 0
        for (const t of trades) {
          eq += t.netPnlQuote
          peak = Math.max(peak, eq)
          dd = Math.min(dd, eq - peak)
        }
        const rar = dd < 0 ? s.netPnl / Math.abs(dd) : s.netPnl > 0 ? Infinity : 0
        setVerified((v) => ({ ...v, [idx]: { net: s.netPnl, trades: s.count, win: s.winRate, maxDD: dd, rar } }))
      } catch {
        setVerified((v) => ({ ...v, [idx]: { net: NaN, trades: 0, win: 0, maxDD: 0, rar: NaN } }))
      }
    }
    setVerifying(false)
  }

  async function run() {
    if (!cfg) return
    setRunning(true)
    setErr(null)
    setResults(null)
    setSelected(null)
    setProgress(0)
    try {
      const connector = String(cfg.candles_connector ?? cfg.connector_name ?? "hyperliquid_perpetual")
      const pair = String(cfg.candles_trading_pair ?? cfg.trading_pair)
      const interval = String(cfg.interval ?? "15m")
      const now = Math.floor(Date.now() / 1000)
      const candles = await getHistoricalCandles(connector, pair, interval, now - days * 86400, now)
      if (candles.length < 60) throw new Error(`Only ${candles.length} candles — widen the window or pick a finer interval.`)
      const res = await runOptimize(
        candles,
        cfg as Record<string, unknown>,
        DEFAULT_RANGES,
        { samples, folds, minTradesPerFold: minTrades, sizeQuote: Number(cfg.total_amount_quote ?? 30) },
        setProgress,
      )
      setResults(res)
      setRunning(false)
      // Confirm the sim's top finalists against the real backtest engine.
      await verifyTop(res.slice(0, 6), interval, days)
    } catch (e) {
      setErr((e as Error).message)
      setRunning(false)
    }
  }

  const top = (results ?? []).slice(0, 10)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Config Optimizer</h1>
        <p className="text-sm text-muted-foreground">
          Searches parameters on the local sim, scores each by <b>risk-adjusted return</b> across{" "}
          <b>walk-forward folds</b>, and keeps only configs robust in every fold. A least-squares
          response surface + region-centroid are added as regularized cross-checks — the goal is a
          config that generalizes, not one that overfits one lucky day.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 py-4 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Base config (pair / sizing / interval)" className="lg:col-span-2">
            <select
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={baseId}
              onChange={(e) => setBaseId(e.target.value)}
            >
              <option value="">Select…</option>
              {(configs.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} ({c.trading_pair} {c.interval})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Window (days)">
            <NumInput value={days} onChange={setDays} />
          </Field>
          <Field label="Walk-forward folds">
            <NumInput value={folds} onChange={(v) => setFolds(Math.max(2, v))} />
          </Field>
          <Field label="Samples">
            <NumInput value={samples} onChange={(v) => setSamples(Math.max(50, v))} />
          </Field>
          <Field label="Min trades / fold">
            <NumInput value={minTrades} onChange={(v) => setMinTrades(Math.max(0, v))} />
          </Field>
          <div className="flex items-end lg:col-span-6">
            <Button size="sm" disabled={!cfg || running} onClick={run}>
              {running ? `Optimizing… ${Math.round(progress * 100)}%` : "Run optimizer"}
            </Button>
            {cfg && (
              <span className="ml-3 text-xs text-muted-foreground">
                {samples} configs × {folds} folds on {cfg.trading_pair} {cfg.interval}, last {days}d ·
                offset forced to 1
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {running && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {err && (
        <Card>
          <CardContent className="py-4 text-sm text-red-500">{err}</CardContent>
        </Card>
      )}

      {results && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Top configs by robust (worst-fold) risk-adjusted return
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <VerifyBanner verified={verified} verifying={verifying} top={top} />
            <div className="overflow-auto rounded-md border text-xs">
              <table className="w-full">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">#</th>
                    <th className="px-2 py-1.5 text-left font-medium">Origin</th>
                    <th className="px-2 py-1.5 text-left font-medium">RL/VL · mult · SL/TP · trail</th>
                    <th className="px-2 py-1.5 text-right font-medium">Robust RAR</th>
                    <th className="px-2 py-1.5 text-right font-medium">Fold PnL</th>
                    <th className="px-2 py-1.5 text-right font-medium">Sim PnL</th>
                    <th className="px-2 py-1.5 text-right font-medium">Overfit gap</th>
                    <th className="px-2 py-1.5 text-right font-medium text-primary">✓ Engine PnL</th>
                    <th className="px-2 py-1.5 text-right font-medium text-primary">✓ Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((c, i) => {
                    const g = c.config
                    const ts = g.trailing_stop as { activation_price?: number; trailing_delta?: number } | undefined
                    const ob = originBadge[c.origin]
                    const fragile = c.overfitGap > Math.abs(c.robust) * 2 + 1
                    const ver = verified[i]
                    return (
                      <tr
                        key={i}
                        className={`cursor-pointer border-t hover:bg-muted/50 ${selected === i ? "bg-muted/60" : ""}`}
                        onClick={() => setSelected(selected === i ? null : i)}
                      >
                        <td className="px-2 py-1.5">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <Badge className={`text-[10px] ${ob.cls}`}>{ob.label}</Badge>
                        </td>
                        <td className="px-2 py-1.5 font-mono tabular-nums">
                          {String(g.range_lookback)}/{String(g.vol_lookback)} · {fmtNum(Number(g.rel_volume_mult), 2)}× ·{" "}
                          {pct(g.stop_loss)}/{pct(g.take_profit)} ·{" "}
                          {ts?.activation_price != null ? `${pct(ts.activation_price)}→${pct(ts.trailing_delta)}` : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(c.robust, 2)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {c.folds.map((f, k) => (
                            <span key={k} className={pnlColor(f.netPnl)}>
                              {k > 0 ? " · " : ""}
                              {fmtNum(f.netPnl, 1)}
                            </span>
                          ))}
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${pnlColor(c.totalPnl)}`}>
                          {fmtUsd(c.totalPnl)}
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${fragile ? "text-red-500" : "text-muted-foreground"}`}>
                          {fmtNum(c.overfitGap, 2)}
                          {fragile ? " ⚠" : ""}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${ver ? pnlColor(ver.net) : ""}`}>
                          {ver ? fmtUsd(ver.net) : i < 6 ? (verifying ? "…" : "—") : ""}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {ver ? ver.trades : i < 6 ? (verifying ? "…" : "—") : ""}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              <b>Robust RAR</b> = worst fold's PnL ÷ drawdown — a config must earn it in every
              sub-period. <b>Fold PnL</b> shows each fold; if they're wildly different (high{" "}
              <b>overfit gap ⚠</b>) the config is fragile, not good. Prefer even fold PnLs +
              enough trades over a big total.
            </p>

            {selected != null && top[selected] && (
              <SaveCandidate cand={top[selected]} onSaved={() => qc.invalidateQueries({ queryKey: ["allConfigs"] })} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function VerifyBanner({
  verified,
  verifying,
  top,
}: {
  verified: Record<number, EngineResult>
  verifying: boolean
  top: Candidate[]
}) {
  const entries = Object.entries(verified).map(([i, v]) => ({ i: Number(i), v }))
  const done = entries.filter((e) => Number.isFinite(e.v.net))
  const best = done.length ? done.reduce((a, b) => (b.v.net > a.v.net ? b : a)) : null
  const anyPositive = done.some((e) => e.v.net > 0)
  return (
    <div className="rounded-md border-l-2 border-primary/50 bg-primary/5 p-3 text-xs">
      <div className="font-medium">
        {verifying
          ? `Verifying finalists against the real backtest engine… (${done.length}/${Math.min(6, top.length)})`
          : done.length
            ? `Engine-verified ${done.length} finalists.`
            : "Finalists will be re-checked with the real engine."}
      </div>
      {best && (
        <div className="mt-1 text-muted-foreground">
          Best by the <b>real engine</b>: config #{best.i + 1} → {fmtUsd(best.v.net)} over {best.v.trades}{" "}
          trades ({fmtNum(best.v.win, 0)}% win).{" "}
          {!anyPositive && (
            <span className="text-amber-600 dark:text-amber-400">
              None are profitable on this pair/window — try another pair, a different window, or
              wider ranges.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function SaveCandidate({ cand, onSaved }: { cand: Candidate; onSaved: () => void }) {
  const [id, setId] = React.useState(`${String(cand.config.id ?? "opt")}_opt`)
  const save = useMutation({
    mutationFn: () => saveControllerConfig(id.trim(), { ...cand.config, id: id.trim() }),
    onSuccess: () => {
      toast.success(`Saved config ${id}`)
      onSaved()
    },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-primary/30 p-3">
      <div className="flex-1">
        <div className="mb-1 text-xs font-medium">Save this config</div>
        <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-tight">
          {JSON.stringify(cand.config, null, 1)}
        </pre>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">New config ID</span>
        <Input className="h-8 w-56 font-mono" value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      <Button size="sm" disabled={!id.trim() || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save as config"}
      </Button>
    </div>
  )
}

const pct = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—"

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

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Input
      type="number"
      className="h-8 tabular-nums"
      value={String(value)}
      onChange={(e) => onChange(e.target.value === "" ? 0 : parseInt(e.target.value, 10))}
    />
  )
}
