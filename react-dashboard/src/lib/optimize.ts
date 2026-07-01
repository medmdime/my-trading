// Client-side config optimizer. Runs the local breakout sim over walk-forward
// folds, scores each candidate by risk-adjusted return (PnL / max-drawdown), and
// keeps only configs that hold up across ALL folds (robust = worst fold), so a
// lucky single-period spike can't win. A least-squares quadratic response surface
// and a top-percentile centroid are added as regularized cross-checks — the
// surface smooths away overfit spikes, the centroid finds the good-region center.

import type { HistCandle } from "./api"
import { simulateBreakout, type Trade } from "./trades"

export interface ParamRange {
  key: string
  label: string
  min: number
  max: number
  int?: boolean
  /** nested under trailing_stop instead of top-level */
  trailing?: boolean
  /** show as a percent in the UI */
  pct?: boolean
}

export const DEFAULT_RANGES: ParamRange[] = [
  { key: "range_lookback", label: "Range lookback", min: 8, max: 40, int: true },
  { key: "vol_lookback", label: "Vol lookback", min: 8, max: 40, int: true },
  { key: "rel_volume_mult", label: "Rel-vol mult", min: 1.5, max: 5 },
  { key: "stop_loss", label: "Stop loss", min: 0.002, max: 0.02, pct: true },
  { key: "take_profit", label: "Take profit", min: 0.004, max: 0.05, pct: true },
  { key: "activation_price", label: "Trail activation", min: 0.003, max: 0.02, trailing: true, pct: true },
  { key: "trailing_delta", label: "Trail delta", min: 0.002, max: 0.015, trailing: true, pct: true },
]

type Cfg = Record<string, unknown>

export function applyParams(base: Cfg, ranges: ParamRange[], vals: number[]): Cfg {
  const c: Cfg = { ...base, signal_candle_offset: 1 }
  const trail: Record<string, unknown> = { ...((base.trailing_stop as object) ?? {}) }
  ranges.forEach((r, i) => {
    let v = vals[i]
    if (r.int) v = Math.round(v)
    if (r.trailing) trail[r.key] = v
    else c[r.key] = v
  })
  c.trailing_stop = trail
  return c
}

export interface FoldScore {
  netPnl: number
  maxDD: number
  rar: number
  trades: number
}

/** Risk-adjusted return = net PnL / max drawdown (Calmar-like), with a
 * too-few-trades penalty so a fold that barely traded can't look "safe". */
export function scoreTrades(trades: Trade[], sizeQuote: number, minTrades: number): FoldScore {
  let eq = 0
  let peak = 0
  let dd = 0
  let net = 0
  for (const t of trades) {
    net += t.netPnlQuote
    eq += t.netPnlQuote
    peak = Math.max(peak, eq)
    dd = Math.min(dd, eq - peak)
  }
  const floor = Math.max(sizeQuote * 0.01, 1e-9)
  let rar = net / Math.max(Math.abs(dd), floor)
  if (trades.length < minTrades) rar = Math.min(rar, -1) - (minTrades - trades.length)
  return { netPnl: net, maxDD: dd, rar, trades: trades.length }
}

export interface Candidate {
  config: Cfg
  vals: number[]
  folds: FoldScore[]
  robust: number // min rar across folds — the anti-overfit score
  totalPnl: number
  totalTrades: number
  overfitGap: number // spread of rar across folds; large = fragile
  origin: "search" | "surface" | "centroid"
}

export interface OptimizeOpts {
  samples: number
  folds: number
  minTradesPerFold: number
  sizeQuote: number
}

function makeFolds(candles: HistCandle[], k: number): HistCandle[][] {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp)
  const n = sorted.length
  const out: HistCandle[][] = []
  for (let i = 0; i < k; i++) out.push(sorted.slice(Math.floor((i * n) / k), Math.floor(((i + 1) * n) / k)))
  return out
}

function evalCandidate(
  base: Cfg,
  ranges: ParamRange[],
  vals: number[],
  folds: HistCandle[][],
  opts: OptimizeOpts,
  origin: Candidate["origin"],
): Candidate {
  const config = applyParams(base, ranges, vals)
  const fs = folds.map((f) => scoreTrades(simulateBreakout(f, config), opts.sizeQuote, opts.minTradesPerFold))
  const rars = fs.map((f) => f.rar)
  return {
    config,
    vals,
    folds: fs,
    robust: Math.min(...rars),
    totalPnl: fs.reduce((s, f) => s + f.netPnl, 0),
    totalTrades: fs.reduce((s, f) => s + f.trades, 0),
    overfitGap: Math.max(...rars) - Math.min(...rars),
    origin,
  }
}

// --- least squares: solve (XᵀX + ridge) b = Xᵀy via Gauss-Jordan -----------
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    const tmp = M[col]
    M[col] = M[piv]
    M[piv] = tmp
    const pv = M[col][col] || 1e-12
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / pv
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k]
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-12))
}

/** Fit score ≈ intercept + Σ(aᵢ·xᵢ + bᵢ·xᵢ²) on normalized params, then take the
 * per-param vertex of the fitted parabola (concave → interior max; else best
 * endpoint). This regularizes: it targets the center of a good region, not a
 * single noisy sample. */
function surfaceOptimum(ranges: ParamRange[], X: number[][], y: number[]): number[] {
  const D = ranges.length
  const norm = (v: number[]) => v.map((x, i) => (x - ranges[i].min) / (ranges[i].max - ranges[i].min || 1))
  const feat = (v: number[]) => {
    const n = norm(v)
    return [1, ...n, ...n.map((z) => z * z)]
  }
  const F = X.map(feat)
  const m = 1 + 2 * D
  const XtX = Array.from({ length: m }, () => new Array(m).fill(0))
  const Xty = new Array(m).fill(0)
  for (let r = 0; r < F.length; r++) {
    for (let i = 0; i < m; i++) {
      Xty[i] += F[r][i] * y[r]
      for (let j = 0; j < m; j++) XtX[i][j] += F[r][i] * F[r][j]
    }
  }
  for (let i = 0; i < m; i++) XtX[i][i] += 1e-4 // ridge
  const b = solveLinear(XtX, Xty)
  const out = ranges.map((r, i) => {
    const lin = b[1 + i]
    const sq = b[1 + D + i]
    let xn: number
    if (sq < -1e-9) xn = -lin / (2 * sq)
    else xn = lin * 1 + sq * 1 > 0 ? 1 : 0
    if (!Number.isFinite(xn)) xn = 0.5
    xn = Math.max(0, Math.min(1, xn))
    let v = r.min + xn * (r.max - r.min)
    if (r.int) v = Math.round(v)
    return v
  })
  if (out.some((v) => !Number.isFinite(v))) throw new Error("singular surface")
  return out
}

export async function runOptimize(
  candles: HistCandle[],
  base: Cfg,
  ranges: ParamRange[],
  opts: OptimizeOpts,
  onProgress?: (frac: number) => void,
): Promise<Candidate[]> {
  const folds = makeFolds(candles, opts.folds)
  const cands: Candidate[] = []
  const sampleVals: number[][] = []
  const scores: number[] = []

  for (let s = 0; s < opts.samples; s++) {
    const vals = ranges.map((r) => r.min + Math.random() * (r.max - r.min))
    const cand = evalCandidate(base, ranges, vals, folds, opts, "search")
    cands.push(cand)
    sampleVals.push(vals)
    scores.push(Number.isFinite(cand.robust) ? cand.robust : -999)
    if (s % 25 === 0) {
      onProgress?.(s / opts.samples)
      await new Promise((r) => setTimeout(r, 0)) // yield so the UI stays live
    }
  }

  // Least-squares response-surface optimum (the regularized pick).
  try {
    const surf = surfaceOptimum(ranges, sampleVals, scores)
    cands.push(evalCandidate(base, ranges, surf, folds, opts, "surface"))
  } catch {
    /* singular fit — skip */
  }

  // Centroid of the top 5% robust configs (good-region center).
  const top = [...cands]
    .filter((c) => c.origin === "search")
    .sort((a, b) => b.robust - a.robust)
    .slice(0, Math.max(3, Math.ceil(opts.samples * 0.05)))
  if (top.length) {
    const cVals = ranges.map((_, i) => top.reduce((s, c) => s + c.vals[i], 0) / top.length)
    cands.push(evalCandidate(base, ranges, cVals, folds, opts, "centroid"))
  }

  onProgress?.(1)
  return cands.sort((a, b) => b.robust - a.robust)
}
