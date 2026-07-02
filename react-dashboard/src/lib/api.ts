// Thin typed client over the Hummingbot API. In dev all calls go to the Vite
// proxy (/api -> API_TARGET) which injects Basic auth, so no creds live here.
// Shapes below are hand-modelled from real responses; api-types.ts holds the
// full generated OpenAPI types for anything more exotic.

import { API_BASE } from "./env"

export class ApiError extends Error {
  status: number
  url: string
  body: string
  constructor(status: number, url: string, body: string) {
    super(`${status} ${url}: ${body.slice(0, 200)}`)
    this.name = "ApiError"
    this.status = status
    this.url = url
    this.body = body
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new ApiError(res.status, path, text)
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export const apiGet = <T>(path: string) => request<T>("GET", path)
export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>("POST", path, body)
export const apiDelete = <T>(path: string) => request<T>("DELETE", path)

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ControllerPerformance {
  realized_pnl_quote: number
  unrealized_pnl_quote: number
  unrealized_pnl_pct: number
  realized_pnl_pct: number
  global_pnl_quote: number
  global_pnl_pct: number
  volume_traded: number
  positions_summary: unknown[]
  close_type_counts: Record<string, number>
}

/** What our controller get_custom_info() override emits (all optional until bots restart). */
export interface DecisionInfo {
  signal?: number // 1 long / -1 short / 0 flat
  close?: number
  resistance?: number
  support?: number
  rel_vol?: number
  rel_volume_mult?: number
  signal_candle_offset?: number
  ts?: number
  // filtered controller extras
  base_signal?: number // unfiltered breakout direction
  trend_ma?: number
  rsi?: number
  blocked_by?: string | null
}

export interface ErrorLog {
  level_name: string
  msg: string
  timestamp: number
  level_no: number
  logger_name?: string
}

// ---------------------------------------------------------------------------
// Bot orchestration
// ---------------------------------------------------------------------------

export interface AllBotsStatus {
  status: string
  data: Record<
    string,
    { status: string; performance: Record<string, unknown>; error_logs: ErrorLog[] }
  >
}

export interface SingleBotStatus {
  status: string
  data: {
    status: string
    performance: Record<
      string,
      { status: string; performance: ControllerPerformance; custom_info: DecisionInfo }
    >
    error_logs: ErrorLog[]
  }
}

export interface ControllerPerfSnapshot {
  timestamp: string
  bot_name: string
  controller_id: string
  status: string
  performance: ControllerPerformance
  custom_info: DecisionInfo
}

export const getAllBotsStatus = () =>
  apiGet<AllBotsStatus>("/bot-orchestration/status")

export const getBotStatus = (botName: string) =>
  apiGet<SingleBotStatus>(`/bot-orchestration/${encodeURIComponent(botName)}/status`)

export const getControllerPerformanceLatest = () =>
  apiGet<{ status: string; data: ControllerPerfSnapshot[] }>(
    "/bot-orchestration/controller-performance-latest",
  )

export const stopAndArchiveBot = (botName: string) =>
  apiPost(`/bot-orchestration/stop-and-archive-bot/${encodeURIComponent(botName)}`)

export interface DeployRequest {
  instance_name: string
  credentials_profile: string
  controllers_config: string[]
  image?: string
  max_global_drawdown_quote?: number | null
  max_controller_drawdown_quote?: number | null
}

export interface DeployResult {
  success?: boolean
  message?: string
  unique_instance_name?: string
  controllers_deployed?: string[]
  script_config_generated?: string
  detail?: unknown
}

/** Create + start a bot from one or more saved controller configs (by name). */
export const deployV2Controllers = (req: DeployRequest) =>
  apiPost<DeployResult>("/bot-orchestration/deploy-v2-controllers", {
    image: "hummingbot/hummingbot:latest",
    max_global_drawdown_quote: null,
    max_controller_drawdown_quote: null,
    ...req,
  })

export const stopBot = (botName: string, skipOrderCancellation = false) =>
  apiPost("/bot-orchestration/stop-bot", {
    bot_name: botName,
    skip_order_cancellation: skipOrderCancellation,
  })

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

export interface DockerContainer {
  id: string
  name: string
  status: string
  image: string
}

export const getActiveContainers = () =>
  apiGet<DockerContainer[]>("/docker/active-containers")

export const getExitedContainers = () =>
  apiGet<DockerContainer[]>("/docker/exited-containers")

// NOTE: the correct endpoints — the old dashboard SDK hit /docker/container/{name}/stop (404).
export const stopContainer = (name: string) =>
  apiPost(`/docker/stop-container/${encodeURIComponent(name)}`)

export const removeContainer = (name: string) =>
  apiPost(`/docker/remove-container/${encodeURIComponent(name)}`)

export const startContainer = (name: string) =>
  apiPost(`/docker/start-container/${encodeURIComponent(name)}`)

// ---------------------------------------------------------------------------
// Accounts & credentials
// ---------------------------------------------------------------------------

export const getAccounts = () => apiGet<string[]>("/accounts/")

export const getAccountCredentials = (accountName: string) =>
  apiGet<string[]>(`/accounts/${encodeURIComponent(accountName)}/credentials`)

/** Creates the account folder + copies master_account's template files into it. */
export const addAccount = (accountName: string) =>
  apiPost(`/accounts/add-account?account_name=${encodeURIComponent(accountName)}`)

/** The API itself rejects deleting "master_account" (400). */
export const deleteAccount = (accountName: string) =>
  apiPost(`/accounts/delete-account?account_name=${encodeURIComponent(accountName)}`)

export const addCredential = (
  accountName: string,
  connectorName: string,
  credentials: Record<string, string>,
) =>
  apiPost(
    `/accounts/add-credential/${encodeURIComponent(accountName)}/${encodeURIComponent(connectorName)}`,
    credentials,
  )

export const deleteCredential = (accountName: string, connectorName: string) =>
  apiPost(
    `/accounts/delete-credential/${encodeURIComponent(accountName)}/${encodeURIComponent(connectorName)}`,
  )

export const getAvailableConnectors = () => apiGet<string[]>("/connectors/")

export interface ConnectorConfigField {
  type: string
  required: boolean
  allowed_values?: unknown[]
}

/** One entry per credential field the connector needs (e.g. api_key, api_secret). */
export const getConnectorConfigMap = (connectorName: string) =>
  apiGet<Record<string, ConnectorConfigField>>(
    `/connectors/${encodeURIComponent(connectorName)}/config-map`,
  )

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export interface Balance {
  token: string
  units: number
  price: number
  value: number
  available_units: number
}

/** { accountName: { connectorName: Balance[] } } */
export type PortfolioState = Record<string, Record<string, Balance[]>>

export const getPortfolioState = () =>
  apiPost<PortfolioState>("/portfolio/state", {})

// ---------------------------------------------------------------------------
// Archived bots
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Controller configs
// ---------------------------------------------------------------------------

export interface ControllerConfig {
  id: string
  controller_name: string
  controller_type: string
  connector_name: string
  trading_pair: string
  candles_connector: string
  candles_trading_pair: string
  interval: string
  range_lookback?: number
  vol_lookback?: number
  rel_volume_mult?: number
  signal_candle_offset?: number
  stop_loss?: number
  take_profit?: number
  time_limit?: number
  leverage?: number
  total_amount_quote?: number
  cooldown_time?: number
  trailing_stop?: { activation_price: number; trailing_delta: number }
  [k: string]: unknown
}

export const getBotControllerConfigs = (botName: string) =>
  apiGet<ControllerConfig[]>(
    `/controllers/bots/${encodeURIComponent(botName)}/configs`,
  )

export const getAllControllerConfigs = () =>
  apiGet<ControllerConfig[]>("/controllers/configs/")

/** Create or update a controller config (body is the full config object). */
export const saveControllerConfig = (id: string, config: Record<string, unknown>) =>
  apiPost(`/controllers/configs/${encodeURIComponent(id)}`, config)

export const deleteControllerConfig = (id: string) =>
  apiDelete(`/controllers/configs/${encodeURIComponent(id)}`)

/** Validate a config against a controller's pydantic model before saving. */
export const validateControllerConfig = (
  controllerType: string,
  controllerName: string,
  config: Record<string, unknown>,
) =>
  apiPost<{ valid?: boolean; errors?: unknown; detail?: unknown }>(
    `/controllers/${encodeURIComponent(controllerType)}/${encodeURIComponent(controllerName)}/config/validate`,
    config,
  )

/** Available controllers grouped by type, e.g. { directional_trading: [...] }. */
export const getAvailableControllers = () =>
  apiGet<Record<string, string[]>>("/controllers/")

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

export interface BacktestRequest {
  start_time: number // unix seconds
  end_time: number // unix seconds
  backtesting_resolution: string // "1m" | "1s" | ...
  trade_cost: number // fraction, e.g. 0.0006
  config: Record<string, unknown>
}

export interface BacktestResponse {
  processed_data: Record<string, unknown>[]
  executors: Record<string, unknown>[]
  results?: Record<string, unknown>
  error?: string
}

export const runBacktest = (req: BacktestRequest) =>
  apiPost<BacktestResponse>("/backtesting/run", req)

// ---------------------------------------------------------------------------
// Market data — historical candles (reliable; NOT throttled like backtest)
// ---------------------------------------------------------------------------

export interface HistCandle {
  timestamp: number // seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Raw OHLCV over an arbitrary window. Unlike /backtesting/run this returns
 * candles reliably (server-side cached), so we use it to draw charts + rebuild
 * the channel locally instead of paying the backtest candle-throttle tax.
 */
export const getHistoricalCandles = (
  connector: string,
  tradingPair: string,
  interval: string,
  startTime: number,
  endTime: number,
) =>
  apiPost<HistCandle[]>("/market-data/historical-candles", {
    connector_name: connector,
    trading_pair: tradingPair,
    interval,
    start_time: startTime,
    end_time: endTime,
  })

/** Live ticker prices straight from the connector (moves every poll, unlike the
 * signal candle which only updates when a candle closes). */
export const getPrices = (connector: string, tradingPairs: string[]) =>
  apiPost<{ connector: string; prices: Record<string, number>; timestamp: number }>(
    "/market-data/prices",
    { connector_name: connector, trading_pairs: tradingPairs },
  )

// ---------------------------------------------------------------------------
// Archived bots
// ---------------------------------------------------------------------------

export const getArchivedBots = () => apiGet<string[]>("/archived-bots/")

/**
 * The on-disk sqlite path for a *running* bot. The archived-bots reader accepts
 * any db path (FastAPI :path param), so we can read a live bot's fills the same
 * way — executors aren't written until archive, but the raw fills table is.
 */
export const liveDbPath = (botName: string) =>
  `bots/instances/${botName}/data/${botName}.sqlite`

/** True for a running-bot instance path vs an archived one. */
export const isLiveDbPath = (dbPath: string) => dbPath.startsWith("bots/instances/")

export const getArchivedTrades = (dbPath: string) =>
  apiGet<{ db_path: string; trades: Record<string, unknown>[] }>(
    `/archived-bots/${dbPath}/trades`,
  )

export const getArchivedExecutors = (dbPath: string) =>
  apiGet<{ db_path: string; executors: Record<string, unknown>[] }>(
    `/archived-bots/${dbPath}/executors`,
  )

export const deleteArchivedBot = (dbPath: string) =>
  apiDelete(`/archived-bots/${dbPath}`)

/** Sum a running bot's controllers into bot-level live metrics. */
export function aggregateBotPerformance(status?: SingleBotStatus): {
  netPnl: number
  volume: number
  closeTypeCounts: Record<string, number>
  controllers: number
} {
  const perf = status?.data?.performance ?? {}
  let netPnl = 0
  let volume = 0
  const closeTypeCounts: Record<string, number> = {}
  const entries = Object.values(perf)
  for (const c of entries) {
    netPnl += c.performance?.global_pnl_quote ?? 0
    volume += c.performance?.volume_traded ?? 0
    for (const [k, v] of Object.entries(c.performance?.close_type_counts ?? {})) {
      closeTypeCounts[k] = (closeTypeCounts[k] ?? 0) + v
    }
  }
  return { netPnl, volume, closeTypeCounts, controllers: entries.length }
}
