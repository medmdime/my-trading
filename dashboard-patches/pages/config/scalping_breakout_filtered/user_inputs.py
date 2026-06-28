import streamlit as st

from frontend.components.directional_trading_general_inputs import get_directional_trading_general_inputs
from frontend.components.risk_management import get_risk_management_inputs


def user_inputs():
    default_config = st.session_state.get("default_config", {})
    range_lookback = default_config.get("range_lookback", 20)
    vol_lookback = default_config.get("vol_lookback", 20)
    rel_volume_mult = default_config.get("rel_volume_mult", 2.0)
    signal_candle_offset = default_config.get("signal_candle_offset", 0)
    # trend filter defaults
    trend_filter_enabled = default_config.get("trend_filter_enabled", False)
    trend_ma_type = default_config.get("trend_ma_type", "ema")
    trend_ma_length = default_config.get("trend_ma_length", 50)
    # rsi filter defaults
    rsi_filter_enabled = default_config.get("rsi_filter_enabled", False)
    rsi_length = default_config.get("rsi_length", 14)
    rsi_overbought = default_config.get("rsi_overbought", 70.0)
    rsi_oversold = default_config.get("rsi_oversold", 30.0)

    connector_name, trading_pair, leverage, total_amount_quote, max_executors_per_side, cooldown_time, position_mode, \
        candles_connector_name, candles_trading_pair, interval = get_directional_trading_general_inputs()
    sl, tp, time_limit, ts_ap, ts_delta, take_profit_order_type = get_risk_management_inputs()

    with st.expander("Breakout Configuration", expanded=True):
        c1, c2, c3 = st.columns(3)
        with c1:
            range_lookback = st.number_input(
                "Range Lookback (bars)", min_value=2, max_value=500, value=int(range_lookback),
                help="Bars used to define the resistance/support channel (excludes the current bar).")
        with c2:
            vol_lookback = st.number_input(
                "Volume Lookback (bars)", min_value=2, max_value=500, value=int(vol_lookback),
                help="Bars used to compute the average volume baseline.")
        with c3:
            rel_volume_mult = st.number_input(
                "Relative Volume Multiple", min_value=0.0, value=float(rel_volume_mult), step=0.1,
                help="Require volume > this multiple of the average (2.0 = 200%).")
        signal_candle_offset = st.number_input(
            "Signal Candle Offset", min_value=0, max_value=20, value=int(signal_candle_offset),
            help="0 = live/forming candle (most responsive, repaints vs backtest). "
                 "1 = last CLOSED candle (matches a closed-bar backtest, no repaint).")

    with st.expander("Trend Filter (Moving Average)", expanded=bool(trend_filter_enabled)):
        trend_filter_enabled = st.checkbox(
            "Enable trend filter", value=bool(trend_filter_enabled),
            help="Only take LONG breakouts when price is above the MA, and SHORT breakouts "
                 "when price is below it (trade with the trend).")
        t1, t2 = st.columns(2)
        with t1:
            trend_ma_type = st.selectbox(
                "MA Type", options=["ema", "sma"],
                index=0 if str(trend_ma_type).lower() != "sma" else 1,
                disabled=not trend_filter_enabled)
        with t2:
            trend_ma_length = st.number_input(
                "MA Length (bars)", min_value=1, max_value=1000, value=int(trend_ma_length),
                disabled=not trend_filter_enabled,
                help="Longer = stricter trend; e.g. 50 or 200.")

    with st.expander("Momentum Filter (RSI)", expanded=bool(rsi_filter_enabled)):
        rsi_filter_enabled = st.checkbox(
            "Enable RSI filter", value=bool(rsi_filter_enabled),
            help="'Avoid exhaustion': skip LONGs when RSI is overbought and SHORTs "
                 "when RSI is oversold. Tighten the thresholds (e.g. 60 / 40) to be "
                 "more selective.")
        r1, r2, r3 = st.columns(3)
        with r1:
            rsi_length = st.number_input(
                "RSI Length", min_value=1, max_value=200, value=int(rsi_length),
                disabled=not rsi_filter_enabled)
        with r2:
            rsi_overbought = st.number_input(
                "Block LONGs when RSI ≥", min_value=0.0, max_value=100.0, value=float(rsi_overbought),
                step=1.0, disabled=not rsi_filter_enabled,
                help="LONG breakouts are skipped when RSI is at/above this (overbought).")
        with r3:
            rsi_oversold = st.number_input(
                "Block SHORTs when RSI ≤", min_value=0.0, max_value=100.0, value=float(rsi_oversold),
                step=1.0, disabled=not rsi_filter_enabled,
                help="SHORT breakouts are skipped when RSI is at/below this (oversold).")

    return {
        "controller_name": "scalping_breakout_filtered",
        "controller_type": "directional_trading",
        "connector_name": connector_name,
        "trading_pair": trading_pair,
        "leverage": leverage,
        "total_amount_quote": total_amount_quote,
        "max_executors_per_side": max_executors_per_side,
        "cooldown_time": cooldown_time,
        "position_mode": position_mode,
        "candles_connector": candles_connector_name,
        "candles_trading_pair": candles_trading_pair,
        "interval": interval,
        "range_lookback": range_lookback,
        "vol_lookback": vol_lookback,
        "rel_volume_mult": rel_volume_mult,
        "signal_candle_offset": signal_candle_offset,
        "trend_filter_enabled": trend_filter_enabled,
        "trend_ma_type": trend_ma_type,
        "trend_ma_length": trend_ma_length,
        "rsi_filter_enabled": rsi_filter_enabled,
        "rsi_length": rsi_length,
        "rsi_overbought": rsi_overbought,
        "rsi_oversold": rsi_oversold,
        "stop_loss": sl,
        "take_profit": tp,
        "time_limit": time_limit,
        "trailing_stop": {
            "activation_price": ts_ap,
            "trailing_delta": ts_delta
        },
        "take_profit_order_type": take_profit_order_type.value
    }
