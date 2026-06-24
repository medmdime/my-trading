"""Shared trade-analysis visualization (my-trading).

Reusable building blocks for inspecting executors (live, archived, or backtest):
per-pair summary with win-rate + color-coded PnL, a color-coded trade table, a
candlestick overview with entry->exit markers, and a per-trade zoom chart.

Used by:
  * pages/orchestration/monitor_bots/app.py  (live & archived bots)
  * pages/config/scalping_breakout/app.py    (backtest results)
"""
import json

import pandas as pd
import plotly.graph_objects as go
import requests
import streamlit as st
from plotly.subplots import make_subplots

# CloseType enum (hummingbot.strategy_v2.models.executors.CloseType)
CLOSE_TYPES = {
    1: "TIME_LIMIT", 2: "STOP_LOSS", 3: "TAKE_PROFIT", 4: "EXPIRED", 5: "EARLY_STOP",
    6: "TRAILING_STOP", 7: "INSUFFICIENT_BALANCE", 8: "FAILED", 9: "COMPLETED", 10: "POSITION_HOLD",
}


def close_type_name(ct):
    if isinstance(ct, str):
        return ct.replace("CloseType.", "")
    return CLOSE_TYPES.get(ct, str(ct))


def hl_coin(trading_pair):
    """Map a Hummingbot pair to its Hyperliquid coin name (incl. HIP-3)."""
    base = trading_pair.split("-")[0]
    if ":" in base:
        deployer, coin = base.split(":")
        return f"{deployer.lower()}:{coin}"
    return base


def _as_dict(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return {}
    return v or {}


def normalize_executor(e):
    """Coerce an executor record (archived OR backtest) into a common shape."""
    ci = _as_dict(e.get("custom_info"))
    cfg = _as_dict(e.get("config"))
    side = cfg.get("side", e.get("side"))
    side = {1: "BUY", 2: "SELL"}.get(side, side)
    entry = ci.get("current_position_average_price") or cfg.get("entry_price")
    exit_px = ci.get("close_price", entry)
    pair = cfg.get("trading_pair") or ci.get("trading_pair") or e.get("trading_pair")
    try:
        entry = float(entry) if entry is not None else None
        exit_px = float(exit_px) if exit_px is not None else entry
    except (TypeError, ValueError):
        entry, exit_px = None, None
    return {
        "id": e.get("id"), "controller_id": e.get("controller_id"), "trading_pair": pair, "side": side,
        "timestamp": e.get("timestamp"), "close_timestamp": e.get("close_timestamp"),
        "close_type": close_type_name(e.get("close_type")),
        "entry_price": entry, "exit_price": exit_px,
        "net_pnl_pct": e.get("net_pnl_pct"), "net_pnl_quote": e.get("net_pnl_quote"),
        "filled_amount_quote": e.get("filled_amount_quote"),
        "custom_info": {"current_position_average_price": entry or 0.0,
                        "close_price": exit_px if exit_px is not None else (entry or 0.0)},
        "config": {"side": side},
    }


def color_pnl(col):
    return ["color: #2ECC71" if (v is not None and v > 0)
            else ("color: #E74C3C" if (v is not None and v < 0) else "")
            for v in col]


def summary_table(executors):
    rows = {}
    for e in executors:
        key = (e["controller_id"], e["trading_pair"])
        r = rows.setdefault(key, {"Controller": e["controller_id"], "Pair": e["trading_pair"],
                                  "Trades": 0, "Wins": 0, "PnL ($)": 0.0, "_ct": {}})
        r["Trades"] += 1
        pnl = e["net_pnl_quote"] or 0
        r["PnL ($)"] += pnl
        if pnl > 0:
            r["Wins"] += 1
        r["_ct"][e["close_type"]] = r["_ct"].get(e["close_type"], 0) + 1
    out = []
    for r in rows.values():
        wr = 100.0 * r["Wins"] / r["Trades"] if r["Trades"] else 0
        ct = " | ".join(f"{k.replace('_', ' ').title()[:4]}:{v}" for k, v in sorted(r["_ct"].items()))
        out.append({"Controller": r["Controller"], "Pair": r["Pair"], "Trades": r["Trades"],
                    "WR %": round(wr, 1), "PnL ($)": round(r["PnL ($)"], 4), "Close Types": ct})
    return pd.DataFrame(out)


@st.cache_data(ttl=60)
def fetch_hl_candles(trading_pair, interval, start_s, end_s):
    """OHLC from Hyperliquid's public API (same source the bots trade on)."""
    body = {"type": "candleSnapshot", "req": {
        "coin": hl_coin(trading_pair), "interval": interval,
        "startTime": int(start_s) * 1000, "endTime": int(end_s) * 1000}}
    r = requests.post("https://api.hyperliquid.xyz/info", json=body, timeout=30)
    r.raise_for_status()
    rows = r.json() or []
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame([{"timestamp": x["t"] // 1000, "open": float(x["o"]), "high": float(x["h"]),
                        "low": float(x["l"]), "close": float(x["c"]), "volume": float(x["v"])} for x in rows])
    df.index = pd.to_datetime(df["timestamp"], unit="s")
    return df


def processed_to_df(processed_data):
    """Backtest processed_data (dict of arrays) -> OHLC DataFrame indexed by datetime."""
    if not processed_data:
        return pd.DataFrame()
    df = pd.DataFrame(processed_data)
    cols = {c: c for c in ("timestamp", "open", "high", "low", "close", "volume") if c in df.columns}
    if "timestamp" not in cols:
        return pd.DataFrame()
    df = df[[*cols]].copy()
    df.index = pd.to_datetime(df["timestamp"], unit="s")
    return df


def _candles_for_window(executor, candles_df, interval):
    ts, cts = executor["timestamp"], executor["close_timestamp"] or executor["timestamp"]
    pad = max(int((cts - ts) * 0.5), 1800)
    if candles_df is not None and not candles_df.empty:
        return candles_df[(candles_df["timestamp"] >= ts - pad) & (candles_df["timestamp"] <= cts + pad)]
    return fetch_hl_candles(executor["trading_pair"], interval, ts - pad, cts + pad)


def trade_chart(executor, candles_df=None, interval="1m"):
    df = _candles_for_window(executor, candles_df, interval)
    if df is None or df.empty:
        return None
    fig = make_subplots(rows=1, cols=1)
    fig.add_trace(go.Candlestick(x=df.index, open=df["open"], high=df["high"], low=df["low"],
                                 close=df["close"], name="Price",
                                 increasing_line_color="#2ECC71", decreasing_line_color="#E74C3C"))
    et = pd.to_datetime(executor["timestamp"], unit="s")
    xt = pd.to_datetime(executor["close_timestamp"] or executor["timestamp"], unit="s")
    color = "#2ECC71" if (executor["net_pnl_quote"] or 0) > 0 else "#E74C3C"
    fig.add_trace(go.Scatter(x=[et, xt], y=[executor["entry_price"], executor["exit_price"]],
                             mode="lines+markers", line=dict(color=color, width=3),
                             name=f"{executor['side']} ({executor['close_type']})"))
    fig.add_hline(y=executor["entry_price"], line=dict(color="grey", width=1, dash="dot"))
    fig.update_layout(height=500, xaxis_rangeslider_visible=False,
                      title=f"{executor['trading_pair']} — {executor['side']} — {executor['close_type']} — "
                            f"PnL {executor['net_pnl_quote']:.4f} ({(executor['net_pnl_pct'] or 0) * 100:.2f}%)")
    return fig


def overview_chart(executors, candles_df, processed_data=None):
    """Candlestick of the whole window with every executor's entry->exit marker (color-coded)."""
    if candles_df is None or candles_df.empty:
        return None
    fig = make_subplots(rows=1, cols=1)
    fig.add_trace(go.Candlestick(x=candles_df.index, open=candles_df["open"], high=candles_df["high"],
                                 low=candles_df["low"], close=candles_df["close"], name="Price",
                                 increasing_line_color="#2ECC71", decreasing_line_color="#E74C3C"))
    if processed_data and "resistance" in processed_data:
        pd_df = pd.DataFrame(processed_data)
        idx = pd.to_datetime(pd_df["timestamp"], unit="s")
        fig.add_trace(go.Scatter(x=idx, y=pd_df["resistance"], mode="lines", name="Resistance",
                                 line=dict(color="#26a69a", width=1)))
        fig.add_trace(go.Scatter(x=idx, y=pd_df["support"], mode="lines", name="Support",
                                 line=dict(color="#ef5350", width=1)))
    for e in executors:
        et = pd.to_datetime(e["timestamp"], unit="s")
        xt = pd.to_datetime(e["close_timestamp"] or e["timestamp"], unit="s")
        color = "#2ECC71" if (e["net_pnl_quote"] or 0) > 0 else "#E74C3C"
        fig.add_trace(go.Scatter(x=[et, xt], y=[e["entry_price"], e["exit_price"]], mode="lines+markers",
                                 line=dict(color=color, width=2), showlegend=False,
                                 hovertext=f"{e['side']} {e['close_type']} PnL {e['net_pnl_quote']:.4f}"))
    fig.update_layout(height=560, xaxis_rangeslider_visible=False, showlegend=False,
                      title="Backtest trades on price")
    return fig


def render_executor_analysis(raw_executors, processed_data=None, key_prefix="", show_summary=True):
    """Full trade-analysis block: summary table, trade table, overview chart, per-trade zoom.

    raw_executors: list of executor dicts (archived/live/backtest shapes all accepted).
    processed_data: optional backtest processed_data (dict of OHLC arrays) for candlesticks.
    """
    executors = [normalize_executor(e) for e in raw_executors if e.get("close_timestamp")]
    if not executors:
        st.info("No closed trades to analyze.")
        return executors

    candles_df = processed_to_df(processed_data)

    if show_summary:
        st.subheader("Per-pair performance")
        sdf = summary_table(executors)
        st.dataframe(sdf.style.apply(color_pnl, subset=["PnL ($)"])
                     .apply(lambda c: ["color:#2ECC71" if v >= 50 else "color:#E74C3C" for v in c], subset=["WR %"]),
                     use_container_width=True, hide_index=True)

    st.subheader("Trades")
    tdf = pd.DataFrame([{
        "#": i, "Pair": e["trading_pair"], "Side": e["side"], "Entry": e["entry_price"], "Exit": e["exit_price"],
        "Close": e["close_type"], "PnL %": round((e["net_pnl_pct"] or 0) * 100, 3),
        "PnL ($)": round(e["net_pnl_quote"] or 0, 4),
        "Opened": pd.to_datetime(e["timestamp"], unit="s"), "Closed": pd.to_datetime(e["close_timestamp"], unit="s"),
    } for i, e in enumerate(executors)])
    st.dataframe(tdf.style.apply(color_pnl, subset=["PnL ($)", "PnL %"]),
                 use_container_width=True, hide_index=True)

    if not candles_df.empty:
        fig = overview_chart(executors, candles_df, processed_data)
        if fig is not None:
            st.plotly_chart(fig, use_container_width=True, key=f"{key_prefix}_overview")

    st.subheader("Inspect a single trade")
    labels = [f"#{i} {e['side']} {e['trading_pair']} {e['entry_price']}→{e['exit_price']} "
              f"[{e['close_type']}] {e['net_pnl_quote']:.4f}" for i, e in enumerate(executors)]
    idx = st.selectbox("Select a trade", range(len(executors)), format_func=lambda i: labels[i],
                       key=f"{key_prefix}_trade_select")
    interval = st.select_slider("Chart interval", ["1m", "5m", "15m", "1h"], value="1m",
                                key=f"{key_prefix}_interval")
    fig = trade_chart(executors[idx], candles_df if not candles_df.empty else None, interval)
    if fig is not None:
        st.plotly_chart(fig, use_container_width=True, key=f"{key_prefix}_trade")
    else:
        st.warning("Could not fetch candles for this trade window.")
    return executors
