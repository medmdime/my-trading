# Scalping — Breakout

Range-consolidation breakout on high volume (directional controller).

It tracks a rolling resistance/support channel and fires when price breaks out of it on
above-average volume. Exits are handled by the PositionExecutor (stop-loss / take-profit /
trailing-stop / time-limit from the Risk Management section).

**Signal (latest closed candle):**

- `resistance` = highest high of the last `range_lookback` bars (excluding the current bar)
- `support` = lowest low of the last `range_lookback` bars (excluding the current bar)
- **LONG** when `close > resistance` AND `volume > rel_volume_mult × average volume`
- **SHORT** when `close < support` AND `volume > rel_volume_mult × average volume`
- else **FLAT**

This page defaults the connector to **`hyperliquid_perpetual`** so you can test the strategy
on Hyperliquid. If Hyperliquid candles are unavailable for backtesting, set the **Candles
Connector** to another venue (e.g. `binance_perpetual`) while keeping the trading **Connector**
as `hyperliquid_perpetual`.
