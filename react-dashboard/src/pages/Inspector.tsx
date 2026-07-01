import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useParams } from "react-router-dom"

import {
  getAllBotsStatus,
  getBotControllerConfigs,
  getBotStatus,
  type ControllerConfig,
  type DecisionInfo,
} from "@/lib/api"
import { fmtNum, signalLabel } from "@/lib/format"
import { useLiveCandles } from "@/lib/useLiveCandles"
import { CandleChart, type OverlayLine } from "@/components/CandleChart"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** A recorded change in the bot's state (signal flip or new channel), wall-clock stamped. */
interface Change {
  wallTs: number
  kind: "signal" | "channel"
  signal: number
  close: number | null
  resistance: number | null
  support: number | null
}

const MAX_CHANGES = 60
const n = (v?: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : null)

function fmtDuration(secs?: number | null): string {
  const s = n(secs)
  if (s == null) return "—"
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}

export function Inspector() {
  const { botName } = useParams()
  const navigate = useNavigate()
  const [controllerId, setControllerId] = React.useState<string | null>(null)

  const bots = useQuery({
    queryKey: ["allBotsStatus"],
    queryFn: getAllBotsStatus,
    refetchInterval: 5_000,
  })
  const configs = useQuery({
    queryKey: ["botConfigs", botName],
    queryFn: () => getBotControllerConfigs(botName!),
    enabled: !!botName,
  })
  const status = useQuery({
    queryKey: ["botStatus", botName],
    queryFn: () => getBotStatus(botName!),
    enabled: !!botName,
    refetchInterval: 1_500,
  })

  const botNames = Object.keys(bots.data?.data ?? {})
  const configList = configs.data ?? []

  React.useEffect(() => {
    if (configList.length && !configList.some((c) => c.id === controllerId)) {
      setControllerId(configList[0].id)
    }
  }, [configList, controllerId])

  const cfg = configList.find((c) => c.id === controllerId) ?? null
  const info: DecisionInfo | undefined =
    controllerId != null
      ? status.data?.data?.performance?.[controllerId]?.custom_info
      : undefined

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Decision Inspector</h1>
        <p className="text-sm text-muted-foreground">
          Your controller's entry/exit rules, evaluated against the live price every 1.5s — so you
          can see exactly what would trigger a trade and where it would exit.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Bot</span>
          <select
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={botName ?? ""}
            onChange={(e) => {
              setControllerId(null)
              navigate(
                e.target.value ? `/inspector/${encodeURIComponent(e.target.value)}` : "/inspector",
              )
            }}
          >
            <option value="">Select…</option>
            {botNames.map((nm) => (
              <option key={nm} value={nm}>
                {nm}
              </option>
            ))}
          </select>
        </label>

        {configList.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Controller</span>
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={controllerId ?? ""}
              onChange={(e) => setControllerId(e.target.value)}
            >
              {configList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} ({c.candles_trading_pair} {c.interval})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!botName && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Pick a bot to watch its live decisions.
          </CardContent>
        </Card>
      )}

      {botName && cfg && (
        <ControllerInspector
          key={cfg.id}
          cfg={cfg}
          info={info}
          updatedAt={status.dataUpdatedAt}
          fetching={status.isFetching}
        />
      )}
    </div>
  )
}

/** Ticking "now" so the "updated Xs ago" readout counts up between polls. */
function useNow(intervalMs = 1_000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function ControllerInspector({
  cfg,
  info,
  updatedAt,
  fetching,
}: {
  cfg: ControllerConfig
  info: DecisionInfo | undefined
  updatedAt: number
  fetching: boolean
}) {
  const { candles, status: wsStatus } = useLiveCandles(
    cfg.candles_connector,
    cfg.candles_trading_pair,
    cfg.interval,
  )
  const now = useNow()

  const close = n(info?.close)
  const res = n(info?.resistance)
  const sup = n(info?.support)
  const rv = n(info?.rel_vol)
  const mult = n(info?.rel_volume_mult) ?? n(cfg.rel_volume_mult)
  const signal = info?.signal ?? 0
  const hasDecision = info && info.signal !== undefined

  // --- Evaluate the controller's rules against the live values -------------
  const longBreak = close != null && res != null ? close > res : null
  const shortBreak = close != null && sup != null ? close < sup : null
  const volOk = rv != null && mult != null ? rv > mult : null
  const toRes = close != null && res != null && close ? ((res - close) / close) * 100 : null
  const toSup = close != null && sup != null && close ? ((close - sup) / close) * 100 : null

  let verdict: { text: string; tone: "long" | "short" | "blocked" | "flat"; detail: string }
  if (signal === 1) {
    verdict = { tone: "long", text: "LONG — breakout up on volume", detail: "Close is above resistance and volume cleared the gate." }
  } else if (signal === -1) {
    verdict = { tone: "short", text: "SHORT — breakout down on volume", detail: "Close is below support and volume cleared the gate." }
  } else if (longBreak && volOk === false) {
    verdict = {
      tone: "blocked",
      text: "Would go LONG — blocked by volume",
      detail: `Price is above resistance, but rel-vol ${fmtNum(rv, 2)}× hasn't reached the required ${fmtNum(mult, 2)}×.`,
    }
  } else if (shortBreak && volOk === false) {
    verdict = {
      tone: "blocked",
      text: "Would go SHORT — blocked by volume",
      detail: `Price is below support, but rel-vol ${fmtNum(rv, 2)}× hasn't reached the required ${fmtNum(mult, 2)}×.`,
    }
  } else {
    verdict = {
      tone: "flat",
      text: "FLAT — waiting for a breakout",
      detail: "Price is inside the channel. No entry until it closes beyond a band on volume.",
    }
  }

  // Concrete "why" for each rule, with the real numbers (not just a %).
  const longWhy =
    close == null || res == null
      ? "Waiting for price data…"
      : longBreak
        ? `Close ${fmtNum(close, 4)} is ${fmtNum(close - res, 4)} ABOVE resistance ${fmtNum(res, 4)} → breakout up is live.`
        : `Close ${fmtNum(close, 4)} is ${fmtNum(res - close, 4)} below resistance ${fmtNum(res, 4)} → must reach ${fmtNum(res, 4)} (+${fmtNum(toRes, 2)}%) to fire.`
  const shortWhy =
    close == null || sup == null
      ? "Waiting for price data…"
      : shortBreak
        ? `Close ${fmtNum(close, 4)} is ${fmtNum(sup - close, 4)} BELOW support ${fmtNum(sup, 4)} → breakout down is live.`
        : `Close ${fmtNum(close, 4)} is ${fmtNum(close - sup, 4)} above support ${fmtNum(sup, 4)} → must reach ${fmtNum(sup, 4)} (−${fmtNum(toSup, 2)}%) to fire.`
  const volWhy =
    rv == null || mult == null
      ? "Waiting for volume data…"
      : volOk
        ? `Rel-vol ${fmtNum(rv, 2)}× is above the ${fmtNum(mult, 2)}× gate → volume confirms a breakout.`
        : `Rel-vol ${fmtNum(rv, 2)}× is below the ${fmtNum(mult, 2)}× gate → needs ${fmtNum(mult - rv, 2)}× more volume; blocks any breakout.`

  // --- Transitions log: record only meaningful changes (signal / new channel).
  const [changes, setChanges] = React.useState<Change[]>([])
  const lastRef = React.useRef<{ signal: number; res: number | null; sup: number | null; at: number } | null>(null)
  React.useEffect(() => {
    setChanges([])
    lastRef.current = null
  }, [cfg.id])
  React.useEffect(() => {
    if (!hasDecision || !updatedAt || updatedAt === lastRef.current?.at) return
    const prev = lastRef.current
    const sigChanged = !prev || prev.signal !== signal
    const chanChanged = !prev || prev.res !== res || prev.sup !== sup
    lastRef.current = { signal, res, sup, at: updatedAt }
    if (prev && !sigChanged && !chanChanged) return // no-op tick — don't spam
    setChanges((p) => {
      const c: Change = {
        wallTs: updatedAt,
        kind: sigChanged ? "signal" : "channel",
        signal,
        close,
        resistance: res,
        support: sup,
      }
      const next = [c, ...p]
      return next.length > MAX_CHANGES ? next.slice(0, MAX_CHANGES) : next
    })
  }, [updatedAt, signal, res, sup, close, hasDecision])

  // --- Chart channel lines at the current levels ---------------------------
  const lines = React.useMemo<OverlayLine[]>(() => {
    if (!candles.length || res == null || sup == null) return []
    const t0 = candles[0].time
    const t1 = candles[candles.length - 1].time
    return [
      { key: "resistance", color: "#ef4444", data: [{ time: t0, value: res }, { time: t1, value: res }] },
      { key: "support", color: "#10b981", data: [{ time: t0, value: sup }, { time: t1, value: sup }] },
    ]
  }, [candles, res, sup])

  const secsAgo = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null
  const fresh = secsAgo != null && secsAgo <= 4
  const sig = signalLabel(signal)

  return (
    <div className="space-y-4">
      {/* Header: freshness + live signal */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="font-mono text-sm">
            {cfg.id} · {cfg.candles_trading_pair} · {cfg.interval}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`size-2 rounded-full ${fresh ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`} />
              {secsAgo == null ? "waiting…" : fetching ? "updating…" : `live · ${secsAgo}s ago`}
            </span>
            <Badge variant="outline" className="text-xs">ws: {wsStatus}</Badge>
            {hasDecision && <Badge className={sig.className}>{sig.text}</Badge>}
          </div>
        </CardHeader>
        <CardContent>
          {!hasDecision ? (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No decision data yet — the bot must be restarted on the instrumented API image.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-5">
              <Stat label="Live price" value={fmtNum(close, 4)} live />
              <Stat label="Resistance" value={fmtNum(res, 4)} sub={toRes != null ? `${toRes >= 0 ? "+" : ""}${fmtNum(toRes, 2)}% away` : undefined} accent="red" />
              <Stat label="Support" value={fmtNum(sup, 4)} sub={toSup != null ? `${fmtNum(toSup, 2)}% away` : undefined} accent="green" />
              <Stat label="Rel volume" value={`${fmtNum(rv, 2)}×`} sub={`gate ${fmtNum(mult, 2)}×`} live />
              <Stat label="Leverage" value={cfg.leverage != null ? `${cfg.leverage}×` : "—"} sub={cfg.total_amount_quote != null ? `$${fmtNum(cfg.total_amount_quote, 0)}` : undefined} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* THE decision panel — rules in plain terms, evaluated live */}
      {hasDecision && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Entry rules — will it open a trade?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ConditionRow
                label="Long breakout"
                pass={longBreak}
                left={`close ${fmtNum(close, 4)}`}
                op=">"
                right={`resistance ${fmtNum(res, 4)}`}
                why={longWhy}
              />
              <ConditionRow
                label="Short breakout"
                pass={shortBreak}
                left={`close ${fmtNum(close, 4)}`}
                op="<"
                right={`support ${fmtNum(sup, 4)}`}
                why={shortWhy}
              />
              <ConditionRow
                label="Volume gate"
                pass={volOk}
                left={`rel-vol ${fmtNum(rv, 2)}×`}
                op=">"
                right={`gate ${fmtNum(mult, 2)}×`}
                why={volWhy}
              />
              <div
                className={`mt-2 rounded-md border-l-2 p-3 text-sm ${
                  verdict.tone === "long"
                    ? "border-emerald-500 bg-emerald-500/5"
                    : verdict.tone === "short"
                      ? "border-red-500 bg-red-500/5"
                      : verdict.tone === "blocked"
                        ? "border-amber-500 bg-amber-500/5"
                        : "border-muted-foreground/40 bg-muted/40"
                }`}
              >
                <div className="font-medium">{verdict.text}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{verdict.detail}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Exit plan — if it entered now at {fmtNum(close, 4)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ExitLadder cfg={cfg} entry={close} />
              <p className="mt-2 text-xs text-muted-foreground">
                Computed from your config off the current price. Whichever level is hit first closes
                the position. Trailing only arms after price reaches the activation, then follows by
                the delta.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Live candles with the channel drawn on */}
      <Card>
        <CardContent className="pt-4">
          {candles.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Waiting for live candles…</div>
          ) : (
            <CandleChart candles={candles} lines={lines} height={420} />
          )}
        </CardContent>
      </Card>

      {/* Only meaningful changes — no per-tick spam */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Changes (signal flips &amp; new channels)</CardTitle>
        </CardHeader>
        <CardContent>
          {changes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing yet — a row appears when the signal changes or a new candle recomputes the
              resistance/support channel.
            </p>
          ) : (
            <div className="space-y-1">
              {changes.map((c) => {
                const s = signalLabel(c.signal)
                return (
                  <div key={c.wallTs} className="flex items-center gap-3 text-xs">
                    <span className="tabular-nums text-muted-foreground">
                      {new Date(c.wallTs).toLocaleTimeString()}
                    </span>
                    {c.kind === "signal" ? (
                      <>
                        <span className="text-muted-foreground">signal →</span>
                        <Badge className={`${s.className} text-[10px]`}>{s.text}</Badge>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        new channel · R{" "}
                        <span className="text-red-500">{fmtNum(c.resistance, 4)}</span> / S{" "}
                        <span className="text-emerald-500">{fmtNum(c.support, 4)}</span>
                      </span>
                    )}
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      close {fmtNum(c.close, 4)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ConditionRow({
  label,
  pass,
  left,
  op,
  right,
  why,
}: {
  label: string
  pass: boolean | null
  left: string
  op: string
  right: string
  why: string
}) {
  const badge =
    pass == null
      ? { t: "—", c: "bg-muted text-muted-foreground" }
      : pass
        ? { t: "✓ met", c: "bg-emerald-600 text-white" }
        : { t: "✗ no", c: "bg-muted text-muted-foreground" }
  return (
    <div className={`rounded-md border p-2.5 ${pass ? "border-emerald-500/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={`${badge.c} shrink-0 text-[10px]`}>{badge.t}</Badge>
        <span className="text-sm font-medium">{label}</span>
        <span className="ml-auto font-mono text-xs tabular-nums">
          {left} <span className="text-muted-foreground">{op}</span> {right}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{why}</div>
    </div>
  )
}

function ExitLadder({ cfg, entry }: { cfg: ControllerConfig; entry: number | null }) {
  const sl = n(cfg.stop_loss)
  const tp = n(cfg.take_profit)
  const trail = cfg.trailing_stop
  const act = n(trail?.activation_price)
  const delta = n(trail?.trailing_delta)
  const e = entry

  const lvl = (frac: number | null, dir: 1 | -1) =>
    e != null && frac != null ? fmtNum(e * (1 + dir * frac), 4) : "—"
  const pct = (frac: number | null, sign: string) =>
    frac != null ? `${sign}${fmtNum(frac * 100, 2)}%` : "—"

  const rows: Array<{ k: string; pctL: string; longP: string; pctS: string; shortP: string }> = [
    { k: "Stop loss", pctL: pct(sl, "−"), longP: lvl(sl, -1), pctS: pct(sl, "+"), shortP: lvl(sl, 1) },
    { k: "Take profit", pctL: pct(tp, "+"), longP: lvl(tp, 1), pctS: pct(tp, "−"), shortP: lvl(tp, -1) },
    { k: "Trailing arms", pctL: pct(act, "+"), longP: lvl(act, 1), pctS: pct(act, "−"), shortP: lvl(act, -1) },
  ]

  return (
    <div className="overflow-hidden rounded-md border text-xs">
      <table className="w-full">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Level</th>
            <th className="px-2 py-1.5 text-right font-medium text-emerald-500">If LONG</th>
            <th className="px-2 py-1.5 text-right font-medium text-red-500">If SHORT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className="border-t">
              <td className="px-2 py-1.5">{r.k}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {r.longP} <span className="text-muted-foreground">({r.pctL})</span>
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {r.shortP} <span className="text-muted-foreground">({r.pctS})</span>
              </td>
            </tr>
          ))}
          <tr className="border-t">
            <td className="px-2 py-1.5">Trailing delta</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground" colSpan={2}>
              follows by {delta != null ? `${fmtNum(delta * 100, 2)}%` : "—"} once armed
            </td>
          </tr>
          <tr className="border-t">
            <td className="px-2 py-1.5">Time limit</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground" colSpan={2}>
              {fmtDuration(cfg.time_limit)} then close flat
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  live,
  accent,
}: {
  label: string
  value: string
  sub?: string
  live?: boolean
  accent?: "red" | "green"
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {live && <span className="size-1.5 rounded-full bg-emerald-500/70" />}
      </div>
      <div
        className={`font-mono tabular-nums ${
          accent === "red" ? "text-red-500" : accent === "green" ? "text-emerald-500" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
