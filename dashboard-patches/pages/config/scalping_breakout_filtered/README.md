# Scalping Breakout (Filtered)

The Scalping Breakout signal (20-bar Donchian channel break + volume spike) with
two **optional** confirmation filters layered on top. It is a separate controller
(`scalping_breakout_filtered`) — the original `scalping_breakout` is untouched.

## Filters (both OFF by default → identical to Scalping Breakout)

**Trend filter (Moving Average)** — a single MA gate:
- `trend_ma_type` (`ema`/`sma`) over `trend_ma_length` bars.
- LONG breakouts are kept only when `close > MA`; SHORT only when `close < MA`.
- Use it to only trade breakouts that go *with* the prevailing trend.

**Momentum filter (RSI)** — a band, defaulted to "avoid exhaustion":
- Wilder RSI over `rsi_length` (default 14).
- LONG kept only when `RSI < rsi_overbought` (default 70) — don't chase overbought breakouts.
- SHORT kept only when `RSI > rsi_oversold` (default 30) — don't chase oversold breakdowns.
- Tighten the thresholds (e.g. `rsi_overbought = 60`, `rsi_oversold = 40`) to be more
  selective. (Note: this is an upper bound on longs / lower bound on shorts — a
  "confirm momentum" style, which needs the opposite bounds, isn't supported by this
  controller.)

Filters are AND-combined with the breakout signal and with each other, so you can
run any of: off / trend-only / RSI-only / both.

## Notes
- `signal_candle_offset` behaves exactly as on Scalping Breakout (0 = live/forming
  candle, 1 = last closed candle = matches a closed-bar backtest).
- Exits (stop-loss / take-profit / trailing-stop / time-limit) are unchanged and
  handled by the PositionExecutor via the risk-management inputs.
- **Deploy ordering:** the API image (controller) must be rebuilt and live BEFORE
  saving any config for this controller — the controller forbids unknown keys, so
  a config with the new filter keys would be rejected by an older image.
