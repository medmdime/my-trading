import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2 } from "lucide-react"

import {
  deployV2Controllers,
  getAllBotsStatus,
  getAllControllerConfigs,
  type ControllerConfig,
  type DeployResult,
} from "@/lib/api"
import { fmtNum } from "@/lib/format"
import { ConfirmButton } from "@/components/ConfirmButton"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—")
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "bot"

export function Deploy() {
  const qc = useQueryClient()
  const configs = useQuery({ queryKey: ["allConfigs"], queryFn: getAllControllerConfigs })
  const bots = useQuery({ queryKey: ["allBotsStatus"], queryFn: getAllBotsStatus, refetchInterval: 5_000 })

  const [configId, setConfigId] = React.useState("")
  const [instanceName, setInstanceName] = React.useState("")
  const [credentials, setCredentials] = React.useState("master_account")
  const [image, setImage] = React.useState("hummingbot/hummingbot:latest")
  const [result, setResult] = React.useState<DeployResult | null>(null)

  const cfg: ControllerConfig | undefined = (configs.data ?? []).find((c) => c.id === configId)

  // Default the instance name from the chosen config.
  React.useEffect(() => {
    if (cfg) setInstanceName(sanitize(cfg.id))
  }, [cfg])

  const offset = cfg ? Number(cfg.signal_candle_offset ?? 1) : 1
  const offsetOk = offset === 1

  const deploy = useMutation({
    mutationFn: () =>
      deployV2Controllers({
        instance_name: sanitize(instanceName),
        credentials_profile: credentials.trim() || "master_account",
        controllers_config: [configId],
        image: image.trim() || "hummingbot/hummingbot:latest",
      }),
    onSuccess: (r) => {
      if (r.success === false) {
        toast.error(`Deploy failed: ${r.message ?? JSON.stringify(r.detail)}`)
        setResult(r)
        return
      }
      setResult(r)
      toast.success(`Deployed ${r.unique_instance_name ?? instanceName}`)
      setTimeout(() => qc.invalidateQueries({ queryKey: ["allBotsStatus"] }), 3_000)
      setTimeout(() => qc.invalidateQueries({ queryKey: ["activeContainers"] }), 3_000)
    },
    onError: (e) => toast.error(`Deploy failed: ${(e as Error).message}`),
  })

  const running = Object.entries(bots.data?.data ?? {}).filter(([, v]) => v.status === "running")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deploy a bot</h1>
        <p className="text-sm text-muted-foreground">
          Turn a saved controller config into a live bot. This starts real trading on{" "}
          {cfg ? <b>{cfg.trading_pair}</b> : "the selected market"} with real funds.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Controller config">
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={configId}
              onChange={(e) => {
                setConfigId(e.target.value)
                setResult(null)
              }}
            >
              <option value="">Select a config to deploy…</option>
              {(configs.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} ({c.trading_pair} {c.interval})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Instance name (a timestamp is appended for uniqueness)">
            <Input
              className="h-9 font-mono"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
            />
          </Field>
          <Field label="Credentials profile">
            <Input className="h-9" value={credentials} onChange={(e) => setCredentials(e.target.value)} />
          </Field>
          <Field label="Image">
            <Input className="h-9 font-mono" value={image} onChange={(e) => setImage(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      {cfg && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Review — {cfg.id}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-6">
              <Info label="Pair" value={String(cfg.trading_pair)} />
              <Info label="Interval" value={String(cfg.interval)} />
              <Info label="Amount" value={`$${fmtNum(cfg.total_amount_quote as number, 0)}`} />
              <Info label="Leverage" value={`${cfg.leverage ?? "—"}×`} />
              <Info label="SL / TP" value={`${pct(cfg.stop_loss)} / ${pct(cfg.take_profit)}`} />
              <Info label="Offset" value={String(offset)} accent={offsetOk ? "ok" : "warn"} />
            </div>

            {!offsetOk && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  This config uses <b>signal_candle_offset {offset}</b>. Offset 0 enters on the
                  forming candle (intrabar fake-outs) and will NOT match your backtest. Set it to{" "}
                  <b>1</b> in Controllers before deploying for backtest-aligned behavior.
                </span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <ConfirmButton
                label="Deploy bot"
                title="Deploy this bot to live trading?"
                name={`${sanitize(instanceName)} · ${cfg.trading_pair} · $${fmtNum(cfg.total_amount_quote as number, 0)}`}
                description="This creates and starts a live bot that trades real funds immediately. Make sure the config, pair, and sizing are correct."
                confirmLabel="Deploy live bot"
                variant="default"
                loading={deploy.isPending}
                onConfirm={() => deploy.mutate()}
              />
              {deploy.isPending && <span className="text-sm text-muted-foreground">Deploying…</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {result && result.success !== false && (
        <Card className="border-emerald-500/40">
          <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm">
            <CheckCircle2 className="size-5 text-emerald-500" />
            <div className="flex-1">
              <div className="font-medium">Deployed</div>
              <div className="font-mono text-xs text-muted-foreground">{result.unique_instance_name}</div>
            </div>
            <Link
              to={`/inspector/${encodeURIComponent(result.unique_instance_name ?? "")}`}
              className="text-xs text-primary hover:underline"
            >
              Watch decisions →
            </Link>
            <Link to="/instances" className="text-xs text-primary hover:underline">
              Instances →
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Currently running ({running.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {running.length === 0 ? (
            <p className="text-sm text-muted-foreground">No running bots.</p>
          ) : (
            running.map(([name, v]) => (
              <div key={name} className="flex items-center gap-2 rounded-md border p-2 text-xs">
                <Badge className="bg-emerald-600 text-white">running</Badge>
                <span className="min-w-0 flex-1 truncate font-mono" title={name}>
                  {name}
                </span>
                <span className="text-muted-foreground">{Object.keys(v.performance ?? {}).join(", ")}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function Info({ label, value, accent }: { label: string; value: string; accent?: "ok" | "warn" }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-mono tabular-nums ${
          accent === "warn" ? "text-amber-500" : accent === "ok" ? "text-emerald-500" : ""
        }`}
      >
        {value}
      </div>
    </div>
  )
}
