"""PATCHED (my-trading): intrabar take-profit & trailing-stop simulation.

Why this overlay exists
-----------------------
The stock PositionExecutorSimulator evaluates STOP_LOSS against intrabar
high/low (realistic) but evaluates TAKE_PROFIT and TRAILING_STOP against the
candle *close* only (`net_pnl_pct` derived from close.pct_change()). Live, the
PositionExecutor fires those barriers the instant price *touches* the level
intrabar. The result: the backtest massively under-fires the trailing stop that
dominates live exits (measured: 13 trailing closes live vs 0 in backtest), so
backtests don't represent live behaviour even at 1m resolution.

What changed
------------
1. TP, SL and TRAILING are all detected against intrabar high/low (gross,
   price-based), mirroring the original SL logic.
2. The trade is realized at the BARRIER price (+tp / -sl / peak-delta), not at
   the triggering bar's close, so simulated fills match live stop/TP fills.
3. Barriers are scanned from the bar AFTER entry (we fill at the entry bar's
   close, so its own pre-fill wick can't trigger an instant exit).
4. Same-bar ties resolve conservatively SL > TRAILING > TP (OHLC can't recover
   true intra-bar ordering; run at 1m to minimise this).

Residual, unavoidable gaps vs live: intra-bar ordering ambiguity (above),
fees/slippage approximated via `trade_cost`, and perp funding is NOT modelled
(matters for multi-day holds such as the 48h widetrail time-limit).
"""
import pandas as pd

from hummingbot.core.data_type.common import TradeType
from hummingbot.strategy_v2.backtesting.executor_simulator_base import ExecutorSimulation, ExecutorSimulatorBase
from hummingbot.strategy_v2.executors.position_executor.data_types import PositionExecutorConfig
from hummingbot.strategy_v2.models.executors import CloseType


class PositionExecutorSimulator(ExecutorSimulatorBase):
    def simulate(self, df: pd.DataFrame, config: PositionExecutorConfig, trade_cost: float) -> ExecutorSimulation:
        if config.triple_barrier_config.open_order_type.is_limit_type():
            entry_condition = (df['close'] <= config.entry_price) if config.side == TradeType.BUY else (df['close'] >= config.entry_price)
            start_timestamp = df[entry_condition]['timestamp'].min()
        else:
            start_timestamp = df['timestamp'].min()
        last_timestamp = df['timestamp'].max()

        # Set up barriers
        tp = float(config.triple_barrier_config.take_profit) if config.triple_barrier_config.take_profit else None
        sl = float(config.triple_barrier_config.stop_loss) if config.triple_barrier_config.stop_loss else None
        trailing_sl_trigger_pct = None
        trailing_sl_delta_pct = None
        if config.triple_barrier_config.trailing_stop:
            trailing_sl_trigger_pct = float(config.triple_barrier_config.trailing_stop.activation_price)
            trailing_sl_delta_pct = float(config.triple_barrier_config.trailing_stop.trailing_delta)
        tl = config.triple_barrier_config.time_limit if config.triple_barrier_config.time_limit else None
        tl_timestamp = config.timestamp + tl if tl else last_timestamp

        # Filter dataframe based on the conditions
        df_filtered = df[:tl_timestamp].copy()

        df_filtered['net_pnl_pct'] = 0.0
        df_filtered['net_pnl_quote'] = 0.0
        df_filtered['cum_fees_quote'] = 0.0
        df_filtered['filled_amount_quote'] = 0.0
        df_filtered["current_position_average_price"] = float(config.entry_price)

        if pd.isna(start_timestamp):
            return ExecutorSimulation(config=config, executor_simulation=df_filtered, close_type=CloseType.TIME_LIMIT)

        entry_price = df.loc[start_timestamp, 'close']
        side_multiplier = 1 if config.side == TradeType.BUY else -1

        # Close-based equity curve (for the pnl_timeseries), net of round-trip cost.
        returns_df = df_filtered[start_timestamp:]
        returns = returns_df['close'].pct_change().fillna(0)
        cumulative_returns = (((1 + returns).cumprod() - 1) * side_multiplier) - 2 * trade_cost
        df_filtered.loc[start_timestamp:, 'net_pnl_pct'] = cumulative_returns
        df_filtered.loc[start_timestamp:, 'filled_amount_quote'] = float(config.amount) * entry_price
        df_filtered['net_pnl_quote'] = df_filtered['net_pnl_pct'] * df_filtered['filled_amount_quote']
        df_filtered['cum_fees_quote'] = 2 * trade_cost * df_filtered['filled_amount_quote']

        # --- PATCH: intrabar barrier detection (gross, price-based) ---------------
        # Scan bars strictly AFTER the entry bar (we fill at the entry bar's close).
        scan = df_filtered.loc[start_timestamp:].iloc[1:]

        if len(scan) and config.side == TradeType.BUY:
            gross_fav = (scan['high'] - entry_price) / entry_price   # best-case intrabar PnL
            gross_adv = (scan['low'] - entry_price) / entry_price    # worst-case intrabar PnL
        elif len(scan):
            gross_fav = (entry_price - scan['low']) / entry_price
            gross_adv = (entry_price - scan['high']) / entry_price
        else:
            gross_fav = pd.Series(dtype=float)
            gross_adv = pd.Series(dtype=float)

        # TAKE PROFIT: intrabar high/low reaches +tp
        first_tp_timestamp = scan[gross_fav >= tp]['timestamp'].min() if (tp and len(scan)) else None

        # STOP LOSS: intrabar high/low reaches -sl
        first_sl_timestamp = scan[gross_adv <= -sl]['timestamp'].min() if (sl and len(scan)) else None

        # TRAILING STOP: peak of intrabar favorable excursion, retraced by delta
        first_trailing_sl_timestamp = None
        trail_levels = None
        if trailing_sl_trigger_pct is not None and trailing_sl_delta_pct is not None and len(scan):
            peak = gross_fav.cummax()
            active = peak >= trailing_sl_trigger_pct
            trail_levels = (peak - trailing_sl_delta_pct).where(active)
            trail_hit = active & (gross_adv <= trail_levels)
            first_trailing_sl_timestamp = scan[trail_hit]['timestamp'].min()

        # Earliest barrier wins; tie-break SL > TRAILING > TP (conservative).
        candidates = [t for t in [first_tp_timestamp, first_sl_timestamp, tl_timestamp, first_trailing_sl_timestamp]
                      if t is not None and not pd.isna(t)]
        close_timestamp = min(candidates)

        realized_gross = None  # None => realize at the close price (time-limit path value)
        if first_sl_timestamp is not None and not pd.isna(first_sl_timestamp) and close_timestamp == first_sl_timestamp:
            close_type = CloseType.STOP_LOSS
            realized_gross = -sl
        elif first_trailing_sl_timestamp is not None and not pd.isna(first_trailing_sl_timestamp) and close_timestamp == first_trailing_sl_timestamp:
            close_type = CloseType.TRAILING_STOP
            realized_gross = float(trail_levels.loc[close_timestamp])
        elif first_tp_timestamp is not None and not pd.isna(first_tp_timestamp) and close_timestamp == first_tp_timestamp:
            close_type = CloseType.TAKE_PROFIT
            realized_gross = tp
        else:
            close_type = CloseType.TIME_LIMIT
        # --- END PATCH -----------------------------------------------------------

        # Set the final state of the DataFrame
        df_filtered = df_filtered[:close_timestamp]
        last_idx = df_filtered.index[-1]
        # Override the realized PnL on the closing bar to the barrier price (not the bar close).
        if realized_gross is not None:
            net_realized = realized_gross - 2 * trade_cost
            single_filled = df_filtered.loc[last_idx, "filled_amount_quote"]
            df_filtered.loc[last_idx, 'net_pnl_pct'] = net_realized
            df_filtered.loc[last_idx, 'net_pnl_quote'] = net_realized * single_filled
        # Account for the exit leg in traded volume (original behaviour).
        df_filtered.loc[last_idx, "filled_amount_quote"] = df_filtered["filled_amount_quote"].iloc[-1] * 2

        # Construct and return ExecutorSimulation object
        simulation = ExecutorSimulation(
            config=config,
            executor_simulation=df_filtered,
            close_type=close_type
        )
        return simulation
