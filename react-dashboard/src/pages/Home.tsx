import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { AlertTriangle, ArrowRight } from "lucide-react"

import {
  getAllBotsStatus,
  getControllerPerformanceLatest,
  getPortfolioState,
  type ControllerPerfSnapshot,
} from "@/lib/api"
import { cleanCloseType, fmtNum, fmtUsd, pnlColor } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls =
    s === "running"
      ? "bg-emerald-600 text-white"
      : s === "stopped"
        ? "bg-zinc-500 text-white"
        : "bg-amber-600 text-white"
  return <Badge className={cls}>{status}</Badge>
}

export function Home() {
  const portfolio = useQuery({
    queryKey: ["portfolio"],
    queryFn: getPortfolioState,
    refetchInterval: 10_000,
  })
  const bots = useQuery({
    queryKey: ["allBotsStatus"],
    queryFn: getAllBotsStatus,
    refetchInterval: 5_000,
  })
  const perf = useQuery({
    queryKey: ["controllerPerfLatest"],
    queryFn: getControllerPerformanceLatest,
    refetchInterval: 5_000,
  })

  const totalValue = portfolio.data
    ? Object.values(portfolio.data)
        .flatMap((conns) => Object.values(conns).flat())
        .reduce((acc, b) => acc + (b.value ?? 0), 0)
    : null

  const snapshots = perf.data?.data ?? []
  const totalPnl = snapshots.reduce((a, s) => a + (s.performance?.global_pnl_quote ?? 0), 0)
  const totalVolume = snapshots.reduce((a, s) => a + (s.performance?.volume_traded ?? 0), 0)

  const botEntries = Object.entries(bots.data?.data ?? {})
  const runningCount = botEntries.filter(([, b]) => b.status === "running").length

  // Group controller snapshots by bot.
  const byBot = new Map<string, ControllerPerfSnapshot[]>()
  for (const s of snapshots) {
    const arr = byBot.get(s.bot_name) ?? []
    arr.push(s)
    byBot.set(s.bot_name, arr)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Live account, bots, and per-controller performance.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Account value" value={fmtUsd(totalValue)} />
        <Metric
          label="Net PnL (live snapshot)"
          value={fmtUsd(totalPnl)}
          valueClass={pnlColor(totalPnl)}
        />
        <Metric label="Running bots" value={`${runningCount} / ${botEntries.length}`} />
        <Metric label="Volume traded" value={fmtUsd(totalVolume)} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Bots</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {botEntries.length === 0 && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                {bots.isLoading ? "Loading bots…" : "No bots found."}
              </CardContent>
            </Card>
          )}
          {botEntries.map(([name, b]) => {
            const controllers = byBot.get(name) ?? []
            const errorCount = b.error_logs?.length ?? 0
            return (
              <Card key={name}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="min-w-0 truncate text-sm" title={name}>
                    {name}
                  </CardTitle>
                  <div className="flex shrink-0 items-center gap-2">
                    {errorCount > 0 && (
                      <span
                        className="flex items-center gap-1 text-xs text-amber-500"
                        title={`${errorCount} recent error log(s)`}
                      >
                        <AlertTriangle className="size-3.5" />
                        {errorCount}
                      </span>
                    )}
                    <StatusBadge status={b.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {controllers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No controller performance snapshot yet.
                    </p>
                  ) : (
                    controllers.map((c) => (
                      <div
                        key={c.controller_id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="min-w-0 truncate font-mono" title={c.controller_id}>
                          {c.controller_id}
                        </span>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className={pnlColor(c.performance?.global_pnl_quote)}>
                            {fmtUsd(c.performance?.global_pnl_quote)}
                          </span>
                          <span className="text-muted-foreground">
                            vol {fmtNum(c.performance?.volume_traded, 0)}
                          </span>
                          <CloseTypes counts={c.performance?.close_type_counts} />
                        </div>
                      </div>
                    ))
                  )}
                  <Link
                    to={`/inspector/${encodeURIComponent(name)}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Inspect decisions <ArrowRight className="size-3" />
                  </Link>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass ?? ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

function CloseTypes({ counts }: { counts?: Record<string, number> }) {
  if (!counts || Object.keys(counts).length === 0) return null
  return (
    <span className="hidden gap-1 sm:flex">
      {Object.entries(counts).map(([k, v]) => (
        <span
          key={k}
          className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
          title={cleanCloseType(k)}
        >
          {cleanCloseType(k).slice(0, 2)}:{v}
        </span>
      ))}
    </span>
  )
}
