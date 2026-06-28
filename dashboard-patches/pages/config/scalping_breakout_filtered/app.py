import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from frontend.components.backtesting import backtesting_section
from frontend.components.config_loader import get_default_config_loader
from frontend.components.trade_viz import render_executor_analysis
from frontend.components.save_config import render_save_config
from frontend.pages.config.scalping_breakout_filtered.user_inputs import user_inputs
from frontend.pages.config.utils import get_candles
from frontend.st_utils import get_backend_api_client, initialize_st_page
from frontend.visualization import theme
from frontend.visualization.backtesting import create_backtesting_figure
from frontend.visualization.backtesting_metrics import render_accuracy_metrics, render_backtesting_metrics, render_close_types
from frontend.visualization.candles import get_candlestick_trace
from frontend.visualization.indicators import get_volume_trace
from frontend.visualization.utils import add_traces_to_fig

# Initialize the Streamlit page
initialize_st_page(title="Scalping Breakout (Filtered)", icon="🎯", initial_sidebar_state="expanded")
backend_api_client = get_backend_api_client()

get_default_config_loader("scalping_breakout_filtered")

# Default this strategy to Hyperliquid perpetuals (only seed if the user hasn't set values yet).
_defaults = {
    "connector_name": "hyperliquid_perpetual",
    "trading_pair": "BTC-USD",
    "candles_connector": "hyperliquid_perpetual",
    "candles_trading_pair": "BTC-USD",
    "interval": "1m",
}
for _k, _v in _defaults.items():
    st.session_state["default_config"].setdefault(_k, _v)

# User inputs
inputs = user_inputs()
st.session_state["default_config"].update(inputs)


def _rsi(close, length):
    """Wilder's RSI (mirrors the controller)."""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    rs = avg_gain / avg_loss
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return rsi.where(avg_loss != 0, 100.0)


st.write("### Visualizing Breakout Channel + Filters")
days_to_visualize = st.number_input("Days to Visualize", min_value=1, max_value=365, value=7)
# Load candle data
candles = get_candles(connector_name=inputs["candles_connector"], trading_pair=inputs["candles_trading_pair"],
                      interval=inputs["interval"], days=days_to_visualize)

# Rows: price (+ channel + trend MA) / volume / optional RSI.
show_rsi = bool(inputs["rsi_filter_enabled"])
rows = 3 if show_rsi else 2
row_heights = [0.62, 0.18, 0.20] if show_rsi else [0.8, 0.2]
titles = ["Candles with Breakout Channel", "Volume"] + (["RSI"] if show_rsi else [])
fig = make_subplots(rows=rows, cols=1, shared_xaxes=True, vertical_spacing=0.03,
                    subplot_titles=titles, row_heights=row_heights)
add_traces_to_fig(fig, [get_candlestick_trace(candles)], row=1, col=1)

if not candles.empty:
    # Mirror the controller: resistance/support are the rolling high/low of the prior `range_lookback` bars.
    resistance = candles["high"].rolling(inputs["range_lookback"]).max().shift(1)
    support = candles["low"].rolling(inputs["range_lookback"]).min().shift(1)
    add_traces_to_fig(fig, [
        go.Scatter(x=candles.index, y=resistance, mode="lines", name="Resistance",
                   line=dict(color="#26a69a", width=1)),
        go.Scatter(x=candles.index, y=support, mode="lines", name="Support",
                   line=dict(color="#ef5350", width=1)),
    ], row=1, col=1)

    if inputs["trend_filter_enabled"]:
        if str(inputs["trend_ma_type"]).lower() == "sma":
            trend_ma = candles["close"].rolling(int(inputs["trend_ma_length"])).mean()
        else:
            trend_ma = candles["close"].ewm(span=int(inputs["trend_ma_length"]), adjust=False).mean()
        add_traces_to_fig(fig, [
            go.Scatter(x=candles.index, y=trend_ma, mode="lines",
                       name=f"{inputs['trend_ma_type'].upper()}{inputs['trend_ma_length']}",
                       line=dict(color="#f5b041", width=1.5)),
        ], row=1, col=1)

    add_traces_to_fig(fig, [get_volume_trace(candles)], row=2, col=1)

    if show_rsi:
        rsi = _rsi(candles["close"], int(inputs["rsi_length"]))
        add_traces_to_fig(fig, [
            go.Scatter(x=candles.index, y=rsi, mode="lines", name="RSI", line=dict(color="#9b59b6", width=1)),
        ], row=3, col=1)
        fig.add_hline(y=inputs["rsi_overbought"], line=dict(color="#ef5350", width=1, dash="dot"), row=3, col=1)
        fig.add_hline(y=inputs["rsi_oversold"], line=dict(color="#26a69a", width=1, dash="dot"), row=3, col=1)
else:
    add_traces_to_fig(fig, [get_volume_trace(candles)], row=2, col=1)

layout_settings = theme.get_default_layout()
layout_settings["showlegend"] = False
fig.update_layout(**layout_settings)
st.plotly_chart(fig, use_container_width=True)

# Persist the backtest in session_state so interacting with the trade-by-trade
# widgets (selecting a trade, changing the chart interval) doesn't wipe the result.
new_results = backtesting_section(inputs, backend_api_client)
if new_results:
    st.session_state["scalpf_bt_results"] = new_results
    st.session_state["scalpf_bt_config"] = dict(inputs)
bt_results = st.session_state.get("scalpf_bt_results")
bt_config = st.session_state.get("scalpf_bt_config", inputs)
if bt_results:
    fig = create_backtesting_figure(
        df=bt_results["processed_data"],
        executors=bt_results["executors"],
        config=bt_config)
    c1, c2 = st.columns([0.9, 0.1])
    with c1:
        render_backtesting_metrics(bt_results["results"])
        st.plotly_chart(fig, use_container_width=True)
    with c2:
        render_accuracy_metrics(bt_results["results"])
        st.write("---")
        render_close_types(bt_results["results"])

    st.write("---")
    st.write("## 🔍 Trade-by-trade analysis")
    render_executor_analysis(bt_results["executors"], bt_results.get("processed_data"), key_prefix="scalpf_bt")
st.write("---")
render_save_config(st.session_state["default_config"]["id"], st.session_state["default_config"])
