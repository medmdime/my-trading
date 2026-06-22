import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from frontend.components.backtesting import backtesting_section
from frontend.components.config_loader import get_default_config_loader
from frontend.components.save_config import render_save_config
from frontend.pages.config.scalping_breakout.user_inputs import user_inputs
from frontend.pages.config.utils import get_candles
from frontend.st_utils import get_backend_api_client, initialize_st_page
from frontend.visualization import theme
from frontend.visualization.backtesting import create_backtesting_figure
from frontend.visualization.backtesting_metrics import render_accuracy_metrics, render_backtesting_metrics, render_close_types
from frontend.visualization.candles import get_candlestick_trace
from frontend.visualization.indicators import get_volume_trace
from frontend.visualization.utils import add_traces_to_fig

# Initialize the Streamlit page
initialize_st_page(title="Scalping Breakout", icon="🚀", initial_sidebar_state="expanded")
backend_api_client = get_backend_api_client()

get_default_config_loader("scalping_breakout")

# Default this strategy to Hyperliquid perpetuals (only seed if the user hasn't set values yet).
_defaults = {
    "connector_name": "hyperliquid_perpetual",
    "trading_pair": "BTC-USD",
    "candles_connector_name": "hyperliquid_perpetual",
    "candles_trading_pair": "BTC-USD",
    "interval": "1m",
}
for _k, _v in _defaults.items():
    st.session_state["default_config"].setdefault(_k, _v)

# User inputs
inputs = user_inputs()
st.session_state["default_config"].update(inputs)

st.write("### Visualizing Breakout Channel")
days_to_visualize = st.number_input("Days to Visualize", min_value=1, max_value=365, value=7)
# Load candle data
candles = get_candles(connector_name=inputs["candles_connector"], trading_pair=inputs["candles_trading_pair"],
                      interval=inputs["interval"], days=days_to_visualize)

# Create a subplot with 2 rows: price (with breakout channel) + volume
fig = make_subplots(rows=2, cols=1, shared_xaxes=True,
                    vertical_spacing=0.02, subplot_titles=("Candles with Breakout Channel", "Volume"),
                    row_heights=[0.8, 0.2])
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

add_traces_to_fig(fig, [get_volume_trace(candles)], row=2, col=1)

layout_settings = theme.get_default_layout()
layout_settings["showlegend"] = False
fig.update_layout(**layout_settings)
st.plotly_chart(fig, use_container_width=True)

bt_results = backtesting_section(inputs, backend_api_client)
if bt_results:
    fig = create_backtesting_figure(
        df=bt_results["processed_data"],
        executors=bt_results["executors"],
        config=inputs)
    c1, c2 = st.columns([0.9, 0.1])
    with c1:
        render_backtesting_metrics(bt_results["results"])
        st.plotly_chart(fig, use_container_width=True)
    with c2:
        render_accuracy_metrics(bt_results["results"])
        st.write("---")
        render_close_types(bt_results["results"])
st.write("---")
render_save_config(st.session_state["default_config"]["id"], st.session_state["default_config"])
