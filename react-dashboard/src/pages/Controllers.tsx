import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Copy, Pencil, Plus } from "lucide-react"
import { toast } from "sonner"

import type { SeriesMarker, Time, UTCTimestamp } from "lightweight-charts"

import {
  deleteControllerConfig,
  getAllControllerConfigs,
  getAvailableControllers,
  runBacktest,
  saveControllerConfig,
  validateControllerConfig,
  type ControllerConfig,
} from "@/lib/api"
import { cleanCloseType, fmtNum, fmtUsd, pnlColor } from "@/lib/format"
import { normalizeExecutor, processedToRows, summarize } from "@/lib/trades"
import { CandleChart, type Candle, type OverlayLine } from "@/components/CandleChart"
import { ConfirmButton } from "@/components/ConfirmButton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// A sensible starting point for brand-new configs (mirrors a live HL breakout).
const DEFAULT_CONFIG: Record<string, unknown> = {
  controller_name: "scalping_breakout",
  controller_type: "directional_trading",
  connector_name: "hyperliquid_perpetual",
  trading_pair: "BTC-USD",
  candles_connector: "hyperliquid_perpetual",
  candles_trading_pair: "BTC-USD",
  interval: "15m",
  total_amount_quote: 30,
  leverage: 2,
  max_executors_per_side: 1,
  cooldown_time: 900,
  time_limit: 7200,
  position_mode: "ONEWAY",
  range_lookback: 17,
  vol_lookback: 17,
  rel_volume_mult: 2.5,
  signal_candle_offset: 1,
  stop_loss: 0.0046,
  take_profit: 0.01,
  take_profit_order_type: 1,
  manual_kill_switch: false,
  trailing_stop: { activation_price: 0.005, trailing_delta: 0.004 },
}

type Mode = { kind: "new" } | { kind: "edit"; cfg: ControllerConfig } | { kind: "clone"; cfg: ControllerConfig }

export function Controllers() {
  const navigate = useNavigate()
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })
  const qc = useQueryClient()
  const [editing, setEditing] = React.useState<Mode | null>(null)

  const del = useMutation({
    mutationFn: (id: string) => deleteControllerConfig(id),
    onSuccess: (_d, id) => {
      toast.success(`Deleted config ${id}`)
      qc.invalidateQueries({ queryKey: ["allConfigs"] })
    },
    onError: (e) => toast.error(`Delete failed: ${(e as Error).message}`),
  })

  const list = (configs.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Controllers</h1>
          <p className="text-sm text-muted-foreground">
            Your strategy configurations. Create, edit, clone, or delete configs — these are what
            you deploy as bots and backtest.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ kind: "new" })}>
          <Plus className="size-4" /> New config
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Configs ({list.length})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {configs.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No controller configs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Controller</TableHead>
                  <TableHead>Pair</TableHead>
                  <TableHead>Interval</TableHead>
                  <TableHead className="text-right">Lev</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">SL / TP</TableHead>
                  <TableHead className="text-right">Trail</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((c) => {
                  const ts = c.trailing_stop as
                    | { activation_price?: number; trailing_delta?: number }
                    | undefined
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="max-w-[220px] truncate font-mono text-xs" title={c.id}>
                        {c.id}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          {c.controller_name?.replace("scalping_breakout", "breakout")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{c.trading_pair}</TableCell>
                      <TableCell className="text-xs">{c.interval}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {(c.leverage as number) ?? "—"}×
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${fmtNum(c.total_amount_quote as number, 0)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {pct(c.stop_loss)} / {pct(c.take_profit)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {ts?.activation_price != null
                          ? `${pct(ts.activation_price)}→${pct(ts.trailing_delta)}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <IconBtn title="Edit" onClick={() => setEditing({ kind: "edit", cfg: c })}>
                            <Pencil className="size-3.5" />
                          </IconBtn>
                          <IconBtn title="Clone" onClick={() => setEditing({ kind: "clone", cfg: c })}>
                            <Copy className="size-3.5" />
                          </IconBtn>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => navigate("/analysis")}
                            title="Backtest in Trade Analysis"
                          >
                            Backtest
                          </Button>
                          <ConfirmButton
                            label="Delete"
                            title="Delete this config?"
                            name={c.id}
                            description="Permanently removes this controller config. Running bots already using it are unaffected; you just can't deploy or backtest it again."
                            confirmLabel="Delete"
                            alwaysConfirm
                            size="sm"
                            onConfirm={() => del.mutate(c.id)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing && (
        <ConfigDialog
          mode={editing}
          existingIds={list.map((c) => c.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

const pct = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—"

function IconBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
}) {
  return (
    <Button variant="ghost" size="icon" className="size-7" title={title} onClick={onClick}>
      {children}
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------

const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "4h"]
const POSITION_MODES = ["ONEWAY", "HEDGE"]
const TP_ORDER_TYPES = [
  { value: 1, label: "LIMIT" },
  { value: 2, label: "MARKET" },
]

function ConfigDialog({
  mode,
  existingIds,
  onClose,
}: {
  mode: Mode
  existingIds: string[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const controllers = useQuery({
    queryKey: ["availableControllers"],
    queryFn: getAvailableControllers,
  })

  const base: Record<string, unknown> =
    mode.kind === "new"
      ? { ...DEFAULT_CONFIG, id: "" }
      : mode.kind === "clone"
        ? { ...(mode.cfg as Record<string, unknown>), id: `${mode.cfg.id}_copy` }
        : { ...(mode.cfg as Record<string, unknown>) }

  const [form, setForm] = React.useState<Record<string, unknown>>(base)
  const [showJson, setShowJson] = React.useState(false)
  const [jsonText, setJsonText] = React.useState("")
  const [jsonError, setJsonError] = React.useState<string | null>(null)

  const idLocked = mode.kind === "edit"
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  const ts = (form.trailing_stop as { activation_price?: number; trailing_delta?: number } | null) ?? null
  const setTs = (patch: Partial<{ activation_price: number; trailing_delta: number }>) =>
    setForm((f) => ({
      ...f,
      trailing_stop: { ...(f.trailing_stop as object), ...patch },
    }))

  const controllerNames = controllers.data?.[String(form.controller_type ?? "directional_trading")] ?? [
    "scalping_breakout",
    "scalping_breakout_filtered",
  ]

  // Sync the raw-JSON editor when opening it.
  const openJson = () => {
    setJsonText(JSON.stringify(form, null, 2))
    setJsonError(null)
    setShowJson(true)
  }
  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText)
      setForm(parsed)
      setJsonError(null)
      setShowJson(false)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const id = String(form.id ?? "").trim()
      if (!id) throw new Error("Config ID is required")
      if (!idLocked && existingIds.includes(id))
        throw new Error(`A config named "${id}" already exists`)
      const payload = { ...form, id }
      // Best-effort server-side validation; don't block save if the endpoint 500s.
      try {
        const v = await validateControllerConfig(
          String(form.controller_type ?? "directional_trading"),
          String(form.controller_name ?? "scalping_breakout"),
          payload,
        )
        if (v && v.valid === false) {
          throw new Error(`Validation failed: ${JSON.stringify(v.errors ?? v.detail ?? v)}`)
        }
      } catch (e) {
        // A failed validation we raised ourselves should surface; a network/route
        // error on the optional validate endpoint should not block saving.
        if ((e as Error).message?.startsWith("Validation failed")) throw e
      }
      return saveControllerConfig(id, payload)
    },
    onSuccess: () => {
      toast.success(`Saved config ${form.id}`)
      qc.invalidateQueries({ queryKey: ["allConfigs"] })
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const title =
    mode.kind === "new" ? "New config" : mode.kind === "clone" ? "Clone config" : "Edit config"

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode.kind === "edit"
              ? "Editing overwrites the existing config. Redeploy the bot for changes to take effect."
              : "Saved configs appear in Trade Analysis (backtest) and can be deployed as bots."}
          </DialogDescription>
        </DialogHeader>

        {showJson ? (
          <div className="space-y-2">
            <textarea
              className="h-[50vh] w-full rounded-md border bg-background p-2 font-mono text-xs"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
            />
            {jsonError && <p className="text-xs text-red-500">{jsonError}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={applyJson}>
                Apply JSON
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowJson(false)}>
                Back to form
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Section title="Identity">
              <FieldText
                label="Config ID"
                value={String(form.id ?? "")}
                onChange={(v) => set("id", v)}
                disabled={idLocked}
                mono
              />
              <FieldSelect
                label="Controller"
                value={String(form.controller_name ?? "")}
                options={controllerNames.map((n) => ({ value: n, label: n }))}
                onChange={(v) => set("controller_name", v)}
              />
            </Section>

            <Section title="Market">
              <FieldText
                label="Connector"
                value={String(form.connector_name ?? "")}
                onChange={(v) => set("connector_name", v)}
              />
              <FieldText
                label="Trading pair"
                value={String(form.trading_pair ?? "")}
                onChange={(v) => set("trading_pair", v)}
              />
              <FieldText
                label="Candles connector"
                value={String(form.candles_connector ?? "")}
                onChange={(v) => set("candles_connector", v)}
              />
              <FieldText
                label="Candles pair"
                value={String(form.candles_trading_pair ?? "")}
                onChange={(v) => set("candles_trading_pair", v)}
              />
              <FieldSelect
                label="Interval"
                value={String(form.interval ?? "15m")}
                options={INTERVALS.map((i) => ({ value: i, label: i }))}
                onChange={(v) => set("interval", v)}
              />
              <FieldSelect
                label="Position mode"
                value={String(form.position_mode ?? "ONEWAY")}
                options={POSITION_MODES.map((i) => ({ value: i, label: i }))}
                onChange={(v) => set("position_mode", v)}
              />
            </Section>

            <Section title="Sizing">
              <FieldNum
                label="Amount (quote)"
                value={form.total_amount_quote}
                onChange={(v) => set("total_amount_quote", v)}
              />
              <FieldNum label="Leverage" value={form.leverage} onChange={(v) => set("leverage", v)} step={1} />
              <FieldNum
                label="Max executors/side"
                value={form.max_executors_per_side}
                onChange={(v) => set("max_executors_per_side", v)}
                step={1}
              />
              <FieldNum
                label="Cooldown (s)"
                value={form.cooldown_time}
                onChange={(v) => set("cooldown_time", v)}
                step={1}
              />
              <FieldNum
                label="Time limit (s)"
                value={form.time_limit}
                onChange={(v) => set("time_limit", v)}
                step={1}
              />
            </Section>

            <Section title="Signal (breakout channel)">
              <FieldNum
                label="Range lookback"
                value={form.range_lookback}
                onChange={(v) => set("range_lookback", v)}
                step={1}
              />
              <FieldNum
                label="Vol lookback"
                value={form.vol_lookback}
                onChange={(v) => set("vol_lookback", v)}
                step={1}
              />
              <FieldNum
                label="Rel volume mult"
                value={form.rel_volume_mult}
                onChange={(v) => set("rel_volume_mult", v)}
                step={0.1}
              />
              <FieldNum
                label="Signal candle offset"
                value={form.signal_candle_offset}
                onChange={(v) => set("signal_candle_offset", v)}
                step={1}
                hint="0 = forming (live), 1 = closed (backtest-aligned)"
              />
            </Section>

            <Section title="Risk">
              <FieldNum
                label="Stop loss (frac)"
                value={form.stop_loss}
                onChange={(v) => set("stop_loss", v)}
                step={0.0001}
                hint={pct(form.stop_loss)}
              />
              <FieldNum
                label="Take profit (frac)"
                value={form.take_profit}
                onChange={(v) => set("take_profit", v)}
                step={0.0001}
                hint={pct(form.take_profit)}
              />
              <FieldSelect
                label="TP order type"
                value={String(form.take_profit_order_type ?? 1)}
                options={TP_ORDER_TYPES.map((t) => ({ value: String(t.value), label: t.label }))}
                onChange={(v) => set("take_profit_order_type", Number(v))}
              />
            </Section>

            <Section title="Trailing stop">
              <label className="col-span-full flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!form.trailing_stop}
                  onChange={(e) =>
                    set(
                      "trailing_stop",
                      e.target.checked ? { activation_price: 0.005, trailing_delta: 0.004 } : null,
                    )
                  }
                />
                Enable trailing stop
              </label>
              {form.trailing_stop ? (
                <>
                  <FieldNum
                    label="Activation (frac)"
                    value={ts?.activation_price}
                    onChange={(v) => setTs({ activation_price: v })}
                    step={0.0001}
                    hint={pct(ts?.activation_price)}
                  />
                  <FieldNum
                    label="Trailing delta (frac)"
                    value={ts?.trailing_delta}
                    onChange={(v) => setTs({ trailing_delta: v })}
                    step={0.0001}
                    hint={pct(ts?.trailing_delta)}
                  />
                </>
              ) : null}
            </Section>

            <BacktestInline form={form} />
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={showJson ? () => setShowJson(false) : openJson}>
            {showJson ? "Hide JSON" : "Edit raw JSON"}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save config"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Inline backtest — run the CURRENT form values on recent candles (local sim,
// no throttle, matches the engine) so you can judge a config before saving.
// ---------------------------------------------------------------------------

function BacktestInline({ form }: { form: Record<string, unknown> }) {
  const [days, setDays] = React.useState(7)
  const [run, setRun] = React.useState(0)
  const snap = React.useRef<Record<string, unknown> | null>(null)

  const pair = String(form.candles_trading_pair ?? form.trading_pair ?? "")
  const interval = String(form.interval ?? "15m")

  // Uses the REAL /backtesting/run engine (retrying past the HL throttle) so these
  // numbers are exactly what the engine reports — what you'll be judged against.
  const q = useQuery({
    queryKey: ["cfgBacktest", run],
    queryFn: async () => {
      const c = snap.current!
      const now = Math.floor(Date.now() / 1000)
      const req = {
        start_time: now - days * 86400,
        end_time: now,
        backtesting_resolution: String(c.interval ?? "15m"),
        trade_cost: 0.0006,
        config: { ...c, id: String(c.id ?? "check") },
      }
      let bt = await runBacktest(req)
      for (let i = 0; i < 4 && processedToRows(bt?.processed_data).length === 0; i++) {
        bt = await runBacktest(req)
      }
      return bt
    },
    enabled: run > 0,
    staleTime: 60_000,
  })

  const bt = q.data
  const rows = React.useMemo(() => processedToRows(bt?.processed_data), [bt])
  const trades = React.useMemo(
    () => (bt?.executors ?? []).map(normalizeExecutor).sort((a, b) => a.ts - b.ts),
    [bt],
  )
  const s = summarize(trades)

  const { pf, maxDD } = React.useMemo(() => {
    let gw = 0
    let gl = 0
    let eq = 0
    let peak = 0
    let dd = 0
    for (const t of trades) {
      if (t.netPnlQuote >= 0) gw += t.netPnlQuote
      else gl += -t.netPnlQuote
      eq += t.netPnlQuote
      peak = Math.max(peak, eq)
      dd = Math.min(dd, eq - peak)
    }
    return { pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, maxDD: dd }
  }, [trades])

  const chartCandles: Candle[] = rows.map((r) => ({ time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close }))
  const lines: OverlayLine[] = React.useMemo(() => {
    const res = rows.filter((r) => r.resistance != null).map((r) => ({ time: r.timestamp, value: r.resistance! }))
    const sup = rows.filter((r) => r.support != null).map((r) => ({ time: r.timestamp, value: r.support! }))
    const out: OverlayLine[] = []
    if (res.length) out.push({ key: "resistance", color: "#ef4444", data: res })
    if (sup.length) out.push({ key: "support", color: "#10b981", data: sup })
    return out
  }, [rows])
  const markers: Array<SeriesMarker<Time>> = trades.map((t) => ({
    time: t.ts as UTCTimestamp,
    position: t.side === "LONG" ? "belowBar" : "aboveBar",
    color: t.netPnlQuote > 0 ? "#10b981" : "#ef4444",
    shape: t.side === "LONG" ? "arrowUp" : "arrowDown",
    text: cleanCloseType(t.closeType),
  }))

  const start = () => {
    snap.current = { ...form }
    setRun((n) => n + 1)
  }

  return (
    <div className="rounded-md border border-primary/30 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Backtest — check before saving
        </span>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          Days
          <select
            className="h-7 rounded-md border bg-background px-1 text-xs"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="outline" onClick={start} disabled={!pair || q.isFetching}>
          {q.isFetching ? "Running…" : "Backtest"}
        </Button>
      </div>
      {run === 0 ? (
        <p className="text-xs text-muted-foreground">
          Runs your current form values through the real backtest engine on the last {days} days of{" "}
          {interval} candles — no save needed. (The backtest is offset-agnostic.)
        </p>
      ) : q.isError ? (
        <p className="text-xs text-red-500">{(q.error as Error).message}</p>
      ) : q.isFetching ? (
        <p className="text-xs text-muted-foreground">Running the backtest engine…</p>
      ) : chartCandles.length === 0 ? (
        <p className="text-xs text-amber-500">
          Engine returned no candles (Hyperliquid throttled) — click Backtest again.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <BtMetric label="Trades" value={String(s.count)} />
            <BtMetric label="Win%" value={`${fmtNum(s.winRate, 0)}%`} />
            <BtMetric label="Net PnL" value={fmtUsd(s.netPnl)} cls={pnlColor(s.netPnl)} />
            <BtMetric label="Profit factor" value={Number.isFinite(pf) ? fmtNum(pf, 2) : "∞"} />
            <BtMetric label="Max DD" value={fmtUsd(maxDD)} cls="text-red-500" />
            <BtMetric label="Fees" value={fmtUsd(s.fees)} />
          </div>
          <CandleChart candles={chartCandles} lines={lines} markers={markers} height={260} />
          <p className="text-[11px] text-muted-foreground">
            {s.count === 0
              ? "No trades fired in this window — loosen the volume gate / widen the range, or try more days."
              : "Green ▲/▼ = winners, red = losers. Numbers are from the real backtest engine."}
          </p>
        </div>
      )}
    </div>
  )
}

function BtMetric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>
    </div>
  )
}

function FieldText({
  label,
  value,
  onChange,
  disabled,
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  mono?: boolean
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        className={`h-8 ${mono ? "font-mono" : ""}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function FieldNum({
  label,
  value,
  onChange,
  step = 0.01,
  hint,
}: {
  label: string
  value: unknown
  onChange: (v: number) => void
  step?: number
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="flex items-center justify-between text-muted-foreground">
        <span>{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </span>
      <Input
        type="number"
        step={step}
        className="h-8 tabular-nums"
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? 0 : parseFloat(e.target.value))}
      />
    </label>
  )
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
