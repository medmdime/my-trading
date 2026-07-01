import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  getAllControllerConfigs,
  runBacktest,
  saveControllerConfig,
  type ControllerConfig,
} from "@/lib/api"
import { fmtNum, fmtUsd, pnlColor } from "@/lib/format"
import { normalizeExecutor, processedToRows, type Trade } from "@/lib/trades"
import { DEFAULT_RANGES, runOptimize, type Candidate } from "@/lib/optimize"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const originBadge: Record<Candidate["origin"], { label: string; cls: string }> = {
  search: { label: "search", cls: "bg-muted text-muted-foreground" },
  refine: { label: "refined", cls: "bg-emerald-700 text-white" },
  surface: { label: "least-squares", cls: "bg-violet-600 text-white" },
  centroid: { label: "region center", cls: "bg-sky-600 text-white" },
}

/** One config → one REAL engine run over the full window (retrying past the
 * Hyperliquid candle throttle). Returns its trades, or null if the engine
 * failed repeatedly (the candidate is then skipped, never mis-scored). */
async function engineTrades(
  config: Record<string, unknown>,
  start: number,
  end: number,
): Promise<Trade[] | null> {
  const req = {
    start_time: start,
    end_time: end,
    backtesting_resolution: String(config.interval ?? "15m"),
    trade_cost: 0.0006,
    config: { ...config, id: String(config.id ?? "opt") },
  }
  for (let i = 0; i < 8; i++) {
    try {
      const bt = await runBacktest(req)
      if (processedToRows(bt?.processed_data).length > 0) {
        return (bt.executors ?? []).map(normalizeExecutor)
      }
    } catch {
      /* retry */
    }
    // Empty = HL candle throttle; back off with jitter so parallel runs desync.
    await new Promise((r) => setTimeout(r, 500 + 500 * i + Math.random() * 500))
  }
  return null
}

export function Optimize() {
  const qc = useQueryClient()
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })

  const [baseId, setBaseId] = React.useState("")
  const [days, setDays] = React.useState(21)
  const [folds, setFolds] = React.useState(3)
  const [samples, setSamples] = React.useState(150)
  const [minTrades, setMinTrades] = React.useState(2)

  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<{ done: number; total: number }>({ done: 0, total: 1 })
  const [results, setResults] = React.useState<Candidate[] | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<number | null>(null)

  const cfg: ControllerConfig | undefined = (configs.data ?? []).find((c) => c.id === baseId)

  async function run() {
    if (!cfg) return
    setRunning(true)
    setErr(null)
    setResults(null)
    setSelected(null)
    setProgress({ done: 0, total: samples + 2 })
    try {
      const now = Math.floor(Date.now() / 1000)
      const start = now - days * 86400
      // Warm the server's candle cache with one solo run before fanning out —
      // parallel first-hits all fetching candles at once is what trips the throttle.
      await engineTrades(cfg as Record<string, unknown>, start, now)
      const res = await runOptimize(
        cfg as Record<string, unknown>,
        DEFAULT_RANGES,
        { startTs: start, endTs: now },
        {
          samples,
          folds,
          minTradesPerFold: minTrades,
          sizeQuote: Number(cfg.total_amount_quote ?? 30),
          concurrency: 2,
        },
        (c) => engineTrades(c, start, now),
        (done, total) => setProgress({ done, total }),
      )
      if (!res.length) throw new Error("Every engine run failed — the backtest API may be down.")
      setResults(res)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const top = (results ?? []).slice(0, 10)
  const pctDone = Math.round((progress.done / Math.max(1, progress.total)) * 100)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Config Optimizer</h1>
        <p className="text-sm text-muted-foreground">
          Every candidate runs through the <b>real backtest engine</b> — the same one Hummingbot
          uses — scored by <b>risk-adjusted return</b> across <b>walk-forward folds</b>, with the
          most recent 25% held out as an unseen final exam. Risk/reward is constrained (TP ≥ SL,
          trailing must be able to arm), so no nonsense configs. Slower than a local sim, but every
          number is the engine's.
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
          <Field label="Engine runs (samples)">
            <NumInput value={samples} onChange={(v) => setSamples(Math.max(20, v))} />
          </Field>
          <Field label="Min trades / fold">
            <NumInput value={minTrades} onChange={(v) => setMinTrades(Math.max(0, v))} />
          </Field>
          <div className="flex items-end lg:col-span-6">
            <Button size="sm" disabled={!cfg || running} onClick={run}>
              {running ? `Optimizing… ${progress.done}/${progress.total} runs` : "Run optimizer"}
            </Button>
            {cfg && !running && (
              <span className="ml-3 text-xs text-muted-foreground">
                {samples} real engine runs (2 in parallel, roughly{" "}
                {Math.max(2, Math.round((samples * 4) / 2 / 60))}–
                {Math.max(4, Math.round((samples * 10) / 2 / 60))} min) on {cfg.trading_pair}{" "}
                {cfg.interval}, last {days}d · offset forced to 1
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {running && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${pctDone}%` }} />
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
              Top configs by robust (worst-fold) risk-adjusted return — all engine numbers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-auto rounded-md border text-xs">
              <table className="w-full">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">#</th>
                    <th className="px-2 py-1.5 text-left font-medium">Origin</th>
                    <th className="px-2 py-1.5 text-left font-medium">RL/VL · mult · SL/TP · trail · cd/tl</th>
                    <th className="px-2 py-1.5 text-right font-medium">Robust RAR</th>
                    <th className="px-2 py-1.5 text-right font-medium">Fold PnL</th>
                    <th className="px-2 py-1.5 text-right font-medium">Total PnL</th>
                    <th className="px-2 py-1.5 text-right font-medium">Trades</th>
                    <th className="px-2 py-1.5 text-right font-medium">Holdout</th>
                    <th className="px-2 py-1.5 text-right font-medium">Overfit gap</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((c, i) => {
                    const g = c.config
                    const ts = g.trailing_stop as { activation_price?: number; trailing_delta?: number } | undefined
                    const ob = originBadge[c.origin]
                    const fragile = c.overfitGap > Math.abs(c.robust) * 2 + 1
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
                          {String(g.range_lookback)}/{String(g.vol_lookback)} ·{" "}
                          {fmtNum(Number(g.rel_volume_mult), 2)}× · {pct(g.stop_loss)}/{pct(g.take_profit)} ·{" "}
                          {ts?.activation_price != null
                            ? `${pct(ts.activation_price)}→${pct(ts.trailing_delta)}`
                            : "—"}{" "}
                          · {String(g.cooldown_time)}s/{String(g.time_limit)}s
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
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.totalTrades}</td>
                        <td
                          className={`px-2 py-1.5 text-right tabular-nums ${pnlColor(c.holdout.netPnl)}`}
                          title="PnL on the most-recent window the search never optimized against"
                        >
                          {fmtUsd(c.holdout.netPnl)} ({c.holdout.trades}t)
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${fragile ? "text-red-500" : "text-muted-foreground"}`}>
                          {fmtNum(c.overfitGap, 2)}
                          {fragile ? " ⚠" : ""}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              <b>Robust RAR</b> = worst fold's PnL ÷ drawdown — a config must earn it in every
              sub-period. <b>Holdout</b> = engine PnL on the most-recent unseen slice: positive
              robust with a negative holdout means it memorized the past — reject it. Every number
              here comes from the real backtest engine.
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
