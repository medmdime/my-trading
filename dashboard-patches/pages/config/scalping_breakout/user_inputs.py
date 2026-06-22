import streamlit as st

from frontend.components.directional_trading_general_inputs import get_directional_trading_general_inputs
from frontend.components.risk_management import get_risk_management_inputs


def user_inputs():
    default_config = st.session_state.get("default_config", {})
    range_lookback = default_config.get("range_lookback", 20)
    vol_lookback = default_config.get("vol_lookback", 20)
    rel_volume_mult = default_config.get("rel_volume_mult", 2.0)

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

    return {
        "controller_name": "scalping_breakout",
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
        "stop_loss": sl,
        "take_profit": tp,
        "time_limit": time_limit,
        "trailing_stop": {
            "activation_price": ts_ap,
            "trailing_delta": ts_delta
        },
        "take_profit_order_type": take_profit_order_type.value
    }
