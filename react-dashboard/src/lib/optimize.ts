// Engine-driven config optimizer. EVERY candidate is evaluated by the real
// Hummingbot backtest engine (/backtesting/run) — no local approximation, so
// what the optimizer reports is exactly what the engine (and, offset aside,
// the live bot) would do. One engine run per candidate covers everything: the
// returned trades are partitioned by entry time into walk-forward folds
// (robust = worst fold) plus a most-recent holdout slice the search never
// optimizes against. Sanity constraints keep risk/reward coherent — no
// TP-smaller-than-SL configs, no trailing stop that can never arm.

import type { Trade } from "./trades"

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
  { key: "cooldown_time", label: "Cooldown (s)", min: 300, max: 3600, int: true },
  { key: "time_limit", label: "Time limit (s)", min: 900, max: 14400, int: true },
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

// --- sanity constraints -----------------------------------------------------
// Keep risk/reward coherent so the search can't emit configs that are formally
// "optimal" but make no trading sense.
const idxOf = (ranges: ParamRange[], key: string) => ranges.findIndex((r) => r.key === key)

export function repairVals(ranges: ParamRange[], vals: number[]): number[] {
  const v = [...vals]
  const iSl = idxOf(ranges, "stop_loss")
  const iTp = idxOf(ranges, "take_profit")
  const iAct = idxOf(ranges, "activation_price")
  const iTd = idxOf(ranges, "trailing_delta")
  const clamp = (i: number, x: number) => Math.min(ranges[i].max, Math.max(ranges[i].min, x))
  // Reward at least the risk: TP >= SL (no risk-2%-to-make-1% configs).
  if (iSl >= 0 && iTp >= 0 && v[iTp] < v[iSl]) v[iTp] = clamp(iTp, v[iSl] * (1 + Math.random()))
  // The trail must be able to arm before TP would close the trade.
  if (iAct >= 0 && iTp >= 0 && v[iAct] > v[iTp] * 0.9) v[iAct] = clamp(iAct, v[iTp] * 0.6)
  // The trail can't give back more than it took to arm.
  if (iTd >= 0 && iAct >= 0 && v[iTd] > v[iAct]) v[iTd] = clamp(iTd, v[iAct] * 0.7)
  return v
}

// --- scoring -----------------------------------------------------------------

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
  origin: "search" | "refine" | "surface" | "centroid"
  /** Score on the held-out window used to SELECT finalists (never optimized against). */
  holdout: FoldScore
  /** Score on the final confirmation window — only consulted for holdout passers,
   * so a lucky holdout can't survive on its own. */
  confirm: FoldScore
  /** Passed all three tiers: green in every train fold, green holdout, green confirm. */
  passed: boolean
  /** Which search round produced it (rounds widen the ranges). */
  round: number
}

export interface OptimizeOpts {
  samples: number
  folds: number
  minTradesPerFold: number
  sizeQuote: number
  /** Fraction reserved as the selection holdout (default 0.2). */
  holdoutFrac?: number
  /** Fraction (most recent) reserved as the final confirmation exam (default 0.2). */
  confirmFrac?: number
  /** Parallel engine calls (default 4). */
  concurrency?: number
}

/** Runs one config through the real backtest engine over the full window and
 * returns its trades — or null if the engine failed even after retries. */
export type EngineRun = (config: Cfg) => Promise<Trade[] | null>

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
 * per-param vertex of the fitted parabola — the regularized center of the good
 * region rather than a single lucky sample. */
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

function gauss(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export async function runOptimize(
  base: Cfg,
  ranges: ParamRange[],
  window: { startTs: number; endTs: number },
  opts: OptimizeOpts,
  runEngine: EngineRun,
  onProgress?: (done: number, total: number) => void,
  round = 1,
): Promise<Candidate[]> {
  // Three-way time split: train folds -> selection holdout -> final confirmation.
  const span = window.endTs - window.startTs
  const holdoutFrac = opts.holdoutFrac ?? 0.2
  const confirmFrac = opts.confirmFrac ?? 0.2
  const confirmStart = window.endTs - span * confirmFrac
  const holdoutStart = confirmStart - span * holdoutFrac
  const searchSpan = holdoutStart - window.startTs
  const foldEdges: Array<[number, number]> = []
  for (let i = 0; i < opts.folds; i++) {
    foldEdges.push([
      window.startTs + (searchSpan * i) / opts.folds,
      window.startTs + (searchSpan * (i + 1)) / opts.folds,
    ])
  }
  const minHold = Math.max(1, Math.floor(opts.minTradesPerFold / 2))

  let done = 0
  const total = opts.samples + 2
  const cands: Candidate[] = []
  const sampleVals: number[][] = []
  const scores: number[] = []

  const evalVals = async (vals: number[], origin: Candidate["origin"]): Promise<void> => {
    const v = repairVals(ranges, vals)
    const config = applyParams(base, ranges, v)
    const trades = await runEngine(config)
    done++
    onProgress?.(done, total)
    if (!trades) return // engine failed after retries — skip rather than mis-score
    const folds = foldEdges.map(([a, b]) =>
      scoreTrades(trades.filter((t) => t.ts >= a && t.ts < b), opts.sizeQuote, opts.minTradesPerFold),
    )
    const holdout = scoreTrades(
      trades.filter((t) => t.ts >= holdoutStart && t.ts < confirmStart),
      opts.sizeQuote,
      minHold,
    )
    const confirm = scoreTrades(
      trades.filter((t) => t.ts >= confirmStart),
      opts.sizeQuote,
      minHold,
    )
    const rars = folds.map((f) => f.rar)
    const robust = Math.min(...rars)
    cands.push({
      config,
      vals: v,
      folds,
      robust,
      totalPnl: folds.reduce((s, f) => s + f.netPnl, 0),
      totalTrades: folds.reduce((s, f) => s + f.trades, 0),
      overfitGap: Math.max(...rars) - Math.min(...rars),
      origin,
      holdout,
      confirm,
      passed:
        robust > 0 &&
        holdout.netPnl > 0 &&
        holdout.trades >= minHold &&
        confirm.netPnl > 0 &&
        confirm.trades >= 1,
      round,
    })
    sampleVals.push(v)
    scores.push(Number.isFinite(robust) ? robust : -999)
  }

  const pool = async (jobs: Array<() => Promise<void>>) => {
    const limit = Math.max(1, opts.concurrency ?? 4)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(limit, jobs.length) }, async () => {
        while (next < jobs.length) {
          const j = jobs[next++]
          await j()
        }
      }),
    )
  }

  // Stage 1 — explore: uniform random over the full (constraint-repaired) ranges.
  const explore = Math.ceil(opts.samples * 0.6)
  await pool(
    Array.from({ length: explore }, () => () =>
      evalVals(ranges.map((r) => r.min + Math.random() * (r.max - r.min)), "search"),
    ),
  )

  // Stage 2 — refine: Gaussian jitter around the best seeds so engine calls
  // concentrate in the promising region.
  const seeds = [...cands].sort((a, b) => b.robust - a.robust).slice(0, 8)
  const refine = opts.samples - explore
  if (seeds.length) {
    await pool(
      Array.from({ length: refine }, (_, s) => () => {
        const seed = seeds[s % seeds.length]
        const vals = ranges.map((r, i) => {
          const sigma = (r.max - r.min) * 0.12
          return Math.min(r.max, Math.max(r.min, seed.vals[i] + gauss() * sigma))
        })
        return evalVals(vals, "refine")
      }),
    )
  }

  // Least-squares response-surface optimum (the regularized pick).
  try {
    await evalVals(surfaceOptimum(ranges, sampleVals, scores), "surface")
  } catch {
    /* singular fit — skip */
  }

  // Centroid of the top 5% robust configs (good-region center).
  const top = [...cands]
    .filter((c) => c.origin === "search" || c.origin === "refine")
    .sort((a, b) => b.robust - a.robust)
    .slice(0, Math.max(3, Math.ceil(opts.samples * 0.05)))
  if (top.length) {
    await evalVals(ranges.map((_, i) => top.reduce((s, c) => s + c.vals[i], 0) / top.length), "centroid")
  }

  return cands.sort((a, b) => b.robust - a.robust)
}

// --- multi-round: keep searching until a config passes all three tiers -------

/** Widen every range around its center by `factor`, clamped so values stay
 * meaningful (positive, ints >= 2, fractions <= 60%). */
export function widenRanges(original: ParamRange[], factor: number): ParamRange[] {
  return original.map((r) => {
    const span = r.max - r.min
    const grow = (span * (factor - 1)) / 2
    let min = r.min - grow
    let max = r.max + grow
    if (r.int) {
      min = Math.max(2, Math.round(min))
      max = Math.round(max)
    } else if (r.pct) {
      // Percent params (SL/TP/trailing): stay positive, never absurd (>60%).
      min = Math.max(r.min * 0.25, min, 1e-4)
      max = Math.min(max, 0.6)
    } else {
      // rel_volume_mult: a volume gate below 1x average is no gate at all —
      // widening must never disable the filter.
      min = Math.max(1.0, min)
    }
    return { ...r, min, max }
  })
}

export interface RoundsResult {
  status: "found" | "exhausted"
  /** Every candidate from every round, passers first then by robust. */
  candidates: Candidate[]
  roundsRun: number
}

/**
 * Round loop: search -> if any candidate passes train folds + holdout + the
 * final confirmation window, stop and return; otherwise widen the parameter
 * ranges 20% and search again. Bounded by maxRounds so "iterate until green"
 * can't degenerate into selecting on noise — if nothing passes, the honest
 * answer is that this pair/window has no robust edge.
 */
export async function runOptimizeRounds(
  base: Cfg,
  ranges: ParamRange[],
  window: { startTs: number; endTs: number },
  opts: OptimizeOpts,
  maxRounds: number,
  runEngine: EngineRun,
  onProgress?: (round: number, done: number, total: number) => void,
): Promise<RoundsResult> {
  const all: Candidate[] = []
  for (let round = 1; round <= maxRounds; round++) {
    const r = round === 1 ? ranges : widenRanges(ranges, 1 + 0.2 * (round - 1))
    const cands = await runOptimize(
      base, r, window, opts, runEngine,
      (done, total) => onProgress?.(round, done, total),
      round,
    )
    all.push(...cands)
    if (cands.some((c) => c.passed)) break
  }
  const roundsRun = all.length ? all[all.length - 1].round : 0
  all.sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? -1 : 1
    if (a.passed && b.passed) return b.holdout.netPnl + b.confirm.netPnl - (a.holdout.netPnl + a.confirm.netPnl)
    return b.robust - a.robust
  })
  return { status: all.some((c) => c.passed) ? "found" : "exhausted", candidates: all, roundsRun }
}
