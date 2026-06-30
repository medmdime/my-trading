import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useParams } from "react-router-dom"
import type { SeriesMarker, Time, UTCTimestamp } from "lightweight-charts"
import { Info } from "lucide-react"

import {
  getAllBotsStatus,
  getBotControllerConfigs,
  getBotStatus,
  type ControllerConfig,
  type DecisionInfo,
} from "@/lib/api"
import { fmtNum, fmtTs, signalLabel } from "@/lib/format"
import { useLiveCandles } from "@/lib/useLiveCandles"
import { CandleChart, type OverlayLine } from "@/components/CandleChart"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface DecisionPoint {
  ts: number
  resistance: number | null
  support: number | null
  signal: number
}

const MAX_HISTORY = 1000

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

  // Default the controller selection to the first config of the bot.
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
          What the bot sees each tick — breakout signal, channel levels, relative volume —
          on the live candle feed.
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
            {botNames.map((n) => (
              <option key={n} value={n}>
                {n}
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
        <ControllerInspector key={cfg.id} cfg={cfg} info={info} />
      )}
    </div>
  )
}

function ControllerInspector({
  cfg,
  info,
}: {
  cfg: ControllerConfig
  info: DecisionInfo | undefined
}) {
  const { candles, status: wsStatus } = useLiveCandles(
    cfg.candles_connector,
    cfg.candles_trading_pair,
    cfg.interval,
  )

  // Accumulate the channel + signal over time from each custom_info tick.
  const [history, setHistory] = React.useState<DecisionPoint[]>([])
  React.useEffect(() => {
    setHistory([])
  }, [cfg.id])

  React.useEffect(() => {
    if (!info || info.signal === undefined || !info.ts) return
    setHistory((prev) => {
      const ts = Math.floor(info.ts as number)
      const last = prev[prev.length - 1]
      const point: DecisionPoint = {
        ts,
        resistance: info.resistance ?? null,
        support: info.support ?? null,
        signal: info.signal ?? 0,
      }
      if (last && last.ts === ts) {
        const copy = prev.slice(0, -1)
        copy.push(point)
        return copy
      }
      const next = [...prev, point]
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
    })
  }, [info?.ts, info?.signal, info?.resistance, info?.support, info])

  const lines = React.useMemo<OverlayLine[]>(() => {
    const res = history.filter((h) => h.resistance != null).map((h) => ({ time: h.ts, value: h.resistance! }))
    const sup = history.filter((h) => h.support != null).map((h) => ({ time: h.ts, value: h.support! }))
    const out: OverlayLine[] = []
    if (res.length) out.push({ key: "resistance", color: "#ef4444", data: res })
    if (sup.length) out.push({ key: "support", color: "#10b981", data: sup })
    return out
  }, [history])

  // Entry markers at signal transitions into LONG / SHORT.
  const markers = React.useMemo<Array<SeriesMarker<Time>>>(() => {
    const out: Array<SeriesMarker<Time>> = []
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1].signal
      const cur = history[i].signal
      if (cur !== prev && cur !== 0) {
        out.push({
          time: history[i].ts as UTCTimestamp,
          position: cur === 1 ? "belowBar" : "aboveBar",
          color: cur === 1 ? "#10b981" : "#ef4444",
          shape: cur === 1 ? "arrowUp" : "arrowDown",
          text: cur === 1 ? "LONG" : "SHORT",
        })
      }
    }
    return out
  }, [history])

  const hasDecision = info && info.signal !== undefined
  const sig = signalLabel(info?.signal)
  const wantsButBlocked = info?.base_signal !== undefined && info.base_signal !== 0 && info.signal === 0

  // Signal-change log (most recent first).
  const log = React.useMemo(() => {
    const rows: Array<{ ts: number; signal: number }> = []
    for (let i = 0; i < history.length; i++) {
      if (i === 0 || history[i].signal !== history[i - 1].signal) {
        rows.push({ ts: history[i].ts, signal: history[i].signal })
      }
    }
    return rows.reverse().slice(0, 25)
  }, [history])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="font-mono text-sm">
            {cfg.id} · {cfg.candles_trading_pair} · {cfg.interval}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              ws: {wsStatus}
            </Badge>
            {hasDecision && <Badge className={sig.className}>{sig.text}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!hasDecision && (
            <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              <span>
                Candles are live, but no decision data yet. The controller needs the{" "}
                <code className="text-xs">get_custom_info()</code> instrumentation and the bot
                must be restarted on the rebuilt API image. Levels and signal will then appear here.
              </span>
            </div>
          )}
          {hasDecision && (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-6">
              <Stat label="Close" value={fmtNum(info!.close, 4)} />
              <Stat label="Resistance" value={fmtNum(info!.resistance, 4)} />
              <Stat label="Support" value={fmtNum(info!.support, 4)} />
              <Stat
                label="Rel vol"
                value={`${fmtNum(info!.rel_vol, 2)}× / ${fmtNum(info!.rel_volume_mult, 1)}×`}
              />
              {info!.trend_ma != null && <Stat label="Trend MA" value={fmtNum(info!.trend_ma, 4)} />}
              {info!.rsi != null && <Stat label="RSI" value={fmtNum(info!.rsi, 1)} />}
            </div>
          )}
          {wantsButBlocked && (
            <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Breakout fired ({signalLabel(info!.base_signal).text}) but was vetoed by filter:{" "}
              <span className="font-medium">{info!.blocked_by ?? "filter"}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          {candles.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Waiting for live candles…
            </div>
          ) : (
            <CandleChart candles={candles} lines={lines} markers={markers} height={460} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Decision log</CardTitle>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Signal transitions will appear here as they happen.
            </p>
          ) : (
            <div className="space-y-1">
              {log.map((r, i) => {
                const s = signalLabel(r.signal)
                return (
                  <div key={`${r.ts}-${i}`} className="flex items-center gap-3 text-xs">
                    <span className="text-muted-foreground tabular-nums">{fmtTs(r.ts)}</span>
                    <Badge className={s.className}>{s.text}</Badge>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono tabular-nums">{value}</div>
    </div>
  )
}
