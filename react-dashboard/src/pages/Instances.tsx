import { useQueries, useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { AlertTriangle } from "lucide-react"

import {
  aggregateBotPerformance,
  deleteArchivedBot,
  getActiveContainers,
  getAllBotsStatus,
  getArchivedBots,
  getArchivedExecutors,
  getBotStatus,
  removeContainer,
  stopAndArchiveBot,
  stopBot,
  type DockerContainer,
} from "@/lib/api"
import { BOT_IMAGE_HINT, cleanCloseType, fmtNum, fmtUsd, pnlColor } from "@/lib/format"
import { normalizeExecutor, summarize } from "@/lib/trades"
import { useBotActions } from "@/lib/useBotActions"
import { ConfirmButton } from "@/components/ConfirmButton"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const isBotContainer = (c: DockerContainer) => c.image.startsWith(BOT_IMAGE_HINT)
const botNameFromPath = (p: string) =>
  p.split("/").slice(-1)[0]?.replace(/\.sqlite$/, "") ?? p

export function Instances() {
  const { act, isPending } = useBotActions()
  const active = useQuery({
    queryKey: ["activeContainers"],
    queryFn: getActiveContainers,
    refetchInterval: 5_000,
  })
  const allStatus = useQuery({
    queryKey: ["allBotsStatus"],
    queryFn: getAllBotsStatus,
    refetchInterval: 5_000,
  })
  const archived = useQuery({ queryKey: ["archivedBots"], queryFn: getArchivedBots })

  const botContainers = (active.data ?? []).filter(isBotContainer)

  // Strategy-level status (running / stopped / error) — NOT the docker container state.
  // A container can be "running" while its strategy has stopped or crashed.
  const strategyStatus = (name: string): string =>
    allStatus.data?.data?.[name]?.status ?? "unknown"
  const errorCount = (name: string): number =>
    allStatus.data?.data?.[name]?.error_logs?.length ?? 0

  const running = botContainers.filter((c) => strategyStatus(c.name) === "running")
  const stopped = botContainers.filter((c) => strategyStatus(c.name) !== "running")

  // Live per-bot performance for the running bots (fresh, parallel).
  const statuses = useQueries({
    queries: running.map((c) => ({
      queryKey: ["botStatus", c.name],
      queryFn: () => getBotStatus(c.name),
      refetchInterval: 8_000,
    })),
  })
  const statusByName = new Map(running.map((c, i) => [c.name, statuses[i]?.data]))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Instances</h1>
        <p className="text-sm text-muted-foreground">
          Bots grouped by <b>strategy</b> status (not container state). Stop &amp; Archive uses the
          correct <code className="text-xs">stop-and-archive-bot</code> endpoint (no 404).
        </p>
      </div>

      {/* Running */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Running ({running.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {active.isLoading && running.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {!active.isLoading && running.length === 0 && (
            <p className="text-sm text-muted-foreground">No running bots.</p>
          )}
          {running.map((c) => {
            const perf = aggregateBotPerformance(statusByName.get(c.name))
            return (
              <BotRow
                key={c.id}
                name={c.name}
                left={<Badge className="bg-emerald-600 text-white">running</Badge>}
                metrics={
                  <>
                    <Metric label="Net PnL" value={fmtUsd(perf.netPnl)} cls={pnlColor(perf.netPnl)} />
                    <Metric label="Volume" value={fmtUsd(perf.volume)} />
                    <Metric label="Ctrls" value={String(perf.controllers)} />
                    <CloseTypes counts={perf.closeTypeCounts} />
                  </>
                }
                actions={
                  <>
                    <Link
                      to={`/inspector/${encodeURIComponent(c.name)}`}
                      className="text-xs text-primary hover:underline"
                    >
                      Inspect
                    </Link>
                    <ConfirmButton
                      label="Stop"
                      title="Stop this bot?"
                      name={c.name}
                      description="Gracefully stops the strategy (cancels open orders). The container stays so you can restart or archive it."
                      confirmLabel="Stop bot"
                      disabled={isPending}
                      onConfirm={() => act(`Stop ${c.name}`, () => stopBot(c.name))}
                    />
                    <ConfirmButton
                      label="Stop & Archive"
                      title="Stop & archive this bot?"
                      name={c.name}
                      description="Stops the bot and moves its database to archived storage. Its trade history stays in Trade Analysis."
                      confirmLabel="Stop & archive"
                      disabled={isPending}
                      onConfirm={() => act(`Archive ${c.name}`, () => stopAndArchiveBot(c.name))}
                    />
                  </>
                }
              />
            )
          })}
        </CardContent>
      </Card>

      {/* Stopped (container up but strategy not running) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stopped / not running ({stopped.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {stopped.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No stopped containers — every bot's strategy is running.
            </p>
          )}
          {stopped.map((c) => {
            const errs = errorCount(c.name)
            return (
              <BotRow
                key={c.id}
                name={c.name}
                left={<Badge className="bg-amber-600 text-white">{strategyStatus(c.name)}</Badge>}
                metrics={
                  errs > 0 ? (
                    <span
                      className="flex items-center gap-1 text-xs text-amber-500"
                      title={`${errs} recent error log(s)`}
                    >
                      <AlertTriangle className="size-3.5" />
                      {errs} errors
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">container up, strategy idle</span>
                  )
                }
                actions={
                  <>
                    <ConfirmButton
                      label="Archive"
                      title="Archive this bot?"
                      name={c.name}
                      description="Archives this bot's database so its trades stay in Trade Analysis, then you can remove it."
                      confirmLabel="Archive"
                      disabled={isPending}
                      onConfirm={() => act(`Archive ${c.name}`, () => stopAndArchiveBot(c.name))}
                    />
                    <ConfirmButton
                      label="Remove"
                      title="Remove this container?"
                      name={c.name}
                      description="Deletes the container. Archive first if you want to keep its trade history."
                      confirmLabel="Remove"
                      disabled={isPending}
                      onConfirm={() => act(`Remove ${c.name}`, () => removeContainer(c.name))}
                    />
                  </>
                }
              />
            )
          })}
        </CardContent>
      </Card>

      {/* Archived */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Archived ({archived.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {archived.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {(archived.data ?? []).map((path) => (
            <ArchivedRow
              key={path}
              path={path}
              disabled={isPending}
              onDelete={() => act(`Delete ${botNameFromPath(path)}`, () => deleteArchivedBot(path))}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function ArchivedRow({
  path,
  onDelete,
  disabled,
}: {
  path: string
  onDelete: () => void
  disabled: boolean
}) {
  const name = botNameFromPath(path)
  const execs = useQuery({
    queryKey: ["archivedExecutors", path],
    queryFn: () => getArchivedExecutors(path),
    staleTime: 5 * 60_000,
  })
  const trades = (execs.data?.executors ?? []).map(normalizeExecutor)
  const s = summarize(trades)

  return (
    <BotRow
      name={name}
      left={<Badge variant="secondary">archived</Badge>}
      metrics={
        execs.isLoading ? (
          <span className="text-xs text-muted-foreground">loading…</span>
        ) : (
          <>
            <Metric label="Net PnL" value={fmtUsd(s.netPnl)} cls={pnlColor(s.netPnl)} />
            <Metric label="Trades" value={String(s.count)} />
            <Metric label="Win%" value={`${fmtNum(s.winRate, 0)}%`} />
            <CloseTypes counts={s.closeTypeCounts} />
          </>
        )
      }
      actions={
        <>
          <Link to="/analysis" className="text-xs text-primary hover:underline">
            Analyze
          </Link>
          <ConfirmButton
            label="Delete"
            title="Delete this archive?"
            name={name}
            description="Permanently removes this archived bot's database and records. This cannot be undone."
            confirmLabel="Delete"
            alwaysConfirm
            disabled={disabled}
            onConfirm={onDelete}
          />
        </>
      }
    />
  )
}

function BotRow({
  name,
  left,
  metrics,
  actions,
}: {
  name: string
  left: React.ReactNode
  metrics: React.ReactNode
  actions: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border p-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {left}
        <span className="min-w-0 truncate font-mono text-xs" title={name}>
          {name}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{metrics}</div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  )
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
    </div>
  )
}

function CloseTypes({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts)
  if (entries.length === 0) return null
  return (
    <div className="hidden flex-wrap gap-1 lg:flex">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
          title={cleanCloseType(k)}
        >
          {cleanCloseType(k).slice(0, 2)}:{v}
        </span>
      ))}
    </div>
  )
}
