import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Database, Download, RefreshCw, Trash2 } from "lucide-react"

import {
  candleCacheCsvUrl,
  deleteCandleCache,
  fillCandleCache,
  getAllControllerConfigs,
  getCandleCache,
  type CacheEntry,
  type CacheFillResult,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"]

const fmtTs = (t: number | null | undefined) =>
  t == null ? "—" : new Date(t * 1000).toLocaleString()

const fmtSize = (b: number) =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`

/** ms epoch -> value usable by <input type="datetime-local"> in local time. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms)
  const pad = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Cache() {
  const qc = useQueryClient()
  const cache = useQuery({ queryKey: ["candleCache"], queryFn: getCandleCache })
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })

  const knownMarkets = React.useMemo(() => {
    const seen = new Map<string, { connector: string; pair: string; interval: string }>()
    for (const c of configs.data ?? []) {
      const connector = c.candles_connector || c.connector_name
      const pair = c.candles_trading_pair || c.trading_pair
      if (connector && pair && c.interval) {
        seen.set(`${connector}|${pair}|${c.interval}`, { connector, pair, interval: c.interval })
      }
    }
    return [...seen.values()]
  }, [configs.data])

  const routerMissing =
    cache.isError && (cache.error as { status?: number })?.status === 404

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data Cache</h1>
        <p className="text-sm text-muted-foreground">
          The server's candle database: one CSV per market + interval, stored in{" "}
          <code className="text-xs">bots/.candle_cache</code>. Backtests, the optimizer and charts
          all read it — only never-fetched gaps hit Hyperliquid. Pre-fill a range here so every run
          after is instant and throttle-free.
        </p>
      </div>

      {routerMissing && (
        <Card>
          <CardContent className="py-6 text-sm text-amber-500">
            The API doesn't have the /candles-cache routes yet — redeploy the API image (the router
            is baked in via api.Dockerfile) and reload this page.
          </CardContent>
        </Card>
      )}

      <FillForm
        knownMarkets={knownMarkets}
        onDone={() => qc.invalidateQueries({ queryKey: ["candleCache"] })}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="size-4" /> Cached markets
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => cache.refetch()} disabled={cache.isFetching}>
            <RefreshCw className={`size-3.5 ${cache.isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {(cache.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing cached yet — run a backtest or pre-fill a range above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-2 py-1.5 text-left font-medium">Market</th>
                    <th className="px-2 py-1.5 text-left font-medium">Interval</th>
                    <th className="px-2 py-1.5 text-right font-medium">Candles</th>
                    <th className="px-2 py-1.5 text-left font-medium">From</th>
                    <th className="px-2 py-1.5 text-left font-medium">To</th>
                    <th className="px-2 py-1.5 text-right font-medium">Spans</th>
                    <th className="px-2 py-1.5 text-right font-medium">Size</th>
                    <th className="px-2 py-1.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(cache.data ?? []).map((e) => (
                    <CacheRow
                      key={e.slug}
                      entry={e}
                      onDeleted={() => qc.invalidateQueries({ queryKey: ["candleCache"] })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CacheRow({ entry, onDeleted }: { entry: CacheEntry; onDeleted: () => void }) {
  const [confirming, setConfirming] = React.useState(false)
  const del = useMutation({
    mutationFn: () =>
      deleteCandleCache(entry.connector ?? "", entry.trading_pair ?? "", entry.interval ?? ""),
    onSuccess: onDeleted,
  })
  const canAct = entry.connector && entry.trading_pair && entry.interval
  return (
    <tr className="border-b last:border-0">
      <td className="px-2 py-1.5 font-mono">{entry.trading_pair ?? entry.slug}</td>
      <td className="px-2 py-1.5">{entry.interval ?? "—"}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{entry.rows.toLocaleString()}</td>
      <td className="px-2 py-1.5 tabular-nums">{fmtTs(entry.first_timestamp)}</td>
      <td className="px-2 py-1.5 tabular-nums">{fmtTs(entry.last_timestamp)}</td>
      <td className="px-2 py-1.5 text-right">
        <Badge variant="outline" className="text-[10px]">
          {entry.spans.length}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{fmtSize(entry.size_bytes)}</td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-1">
          {canAct && (
            <a
              href={candleCacheCsvUrl(entry.connector!, entry.trading_pair!, entry.interval!)}
              download
              className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted"
              title="Download CSV"
            >
              <Download className="size-3.5" />
            </a>
          )}
          {canAct &&
            (confirming ? (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={del.isPending}
                onClick={() => del.mutate()}
                onBlur={() => setConfirming(false)}
              >
                {del.isPending ? "…" : "sure?"}
              </Button>
            ) : (
              <button
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                title="Delete cached data"
                onClick={() => setConfirming(true)}
              >
                <Trash2 className="size-3.5" />
              </button>
            ))}
        </div>
      </td>
    </tr>
  )
}

function FillForm({
  knownMarkets,
  onDone,
}: {
  knownMarkets: Array<{ connector: string; pair: string; interval: string }>
  onDone: () => void
}) {
  const [connector, setConnector] = React.useState("hyperliquid_perpetual")
  const [pair, setPair] = React.useState("")
  const [interval, setInterval] = React.useState("15m")
  const [from, setFrom] = React.useState(() => toLocalInput(Date.now() - 30 * 86400_000))
  const [to, setTo] = React.useState(() => toLocalInput(Date.now()))

  const fill = useMutation({
    mutationFn: () =>
      fillCandleCache(
        connector,
        pair.trim(),
        interval,
        Math.floor(new Date(from).getTime() / 1000),
        Math.floor(new Date(to).getTime() / 1000),
      ),
    onSuccess: onDone,
  })
  const result: CacheFillResult | undefined = fill.data

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Pre-fill a range</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {knownMarkets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {knownMarkets.map((m) => (
              <button
                key={`${m.connector}|${m.pair}|${m.interval}`}
                className={`rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted ${
                  pair === m.pair && interval === m.interval ? "border-primary bg-muted" : ""
                }`}
                onClick={() => {
                  setConnector(m.connector)
                  setPair(m.pair)
                  setInterval(m.interval)
                }}
              >
                {m.pair} · {m.interval}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Connector</span>
            <input
              className="w-52 rounded-md border bg-background px-2 py-1"
              value={connector}
              onChange={(e) => setConnector(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Trading pair</span>
            <input
              className="w-44 rounded-md border bg-background px-2 py-1 font-mono"
              placeholder="ETH-USD"
              value={pair}
              onChange={(e) => setPair(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Interval</span>
            <select
              className="rounded-md border bg-background px-2 py-1"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              {INTERVALS.map((iv) => (
                <option key={iv} value={iv}>
                  {iv}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">From</span>
            <input
              type="datetime-local"
              className="rounded-md border bg-background px-2 py-1"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">To</span>
            <input
              type="datetime-local"
              className="rounded-md border bg-background px-2 py-1"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <Button
            onClick={() => fill.mutate()}
            disabled={fill.isPending || !pair.trim() || !connector.trim()}
          >
            {fill.isPending ? "Filling…" : "Fill cache"}
          </Button>
        </div>

        {fill.isError && (
          <p className="text-xs text-red-500">{(fill.error as Error).message}</p>
        )}
        {result && (
          <div className="rounded-md border p-2.5 text-xs">
            {result.from_cache ? (
              <span className="text-emerald-500">
                ✓ Range already fully cached ({result.rows.toLocaleString()} candles) — zero
                exchange requests.
              </span>
            ) : (
              <div className="space-y-1">
                <span className="text-emerald-500">
                  ✓ Filled {result.gaps_fetched.length} gap(s) — {result.rows.toLocaleString()}{" "}
                  candles now cover the range.
                </span>
                {result.gaps_fetched.map((g, i) => (
                  <div key={i} className="text-muted-foreground">
                    {fmtTs(g.start)} → {fmtTs(g.end)}:{" "}
                    {g.error ? (
                      <span className="text-amber-500">{g.error}</span>
                    ) : (
                      `${g.rows.toLocaleString()} candles fetched`
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
