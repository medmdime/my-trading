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


def live_db_path(bot_name):
    """Path to a RUNNING bot's live sqlite (readable via the /archived-bots/{path}/* endpoints).
    list_databases() only lists archived bots, but the readers accept any path."""
    return f"bots/instances/{bot_name}/data/{bot_name}.sqlite"


def _f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def fills_to_positions(trades):
    """Pair OPEN/CLOSE fills (TradeFill rows) into round-trip positions, FIFO per pair.

    Live bots don't populate the Executors table (that flushes on archive), but
    every fill lands in TradeFill. We reconstruct closed positions from OPEN->CLOSE
    fills so live trades render in the same viz as archived/backtest executors.
    Returns dicts in the normalize_executor() shape. close_type is "LIVE" because
    the exit reason isn't recorded in fills (only in the archived Executors table).
    """
    from collections import defaultdict, deque
    by_pair = defaultdict(list)
    for t in trades:
        by_pair[t.get("trading_pair")].append(t)
    out = []
    for pair, fills in by_pair.items():
        fills = sorted(fills, key=lambda x: x.get("timestamp") or 0)
        open_q = deque()
        for f in fills:
            pos = (f.get("position") or "").upper()
            side = (f.get("trade_type") or "").upper()
            price, amt = _f(f.get("price")), _f(f.get("amount"))
            fee = _f(f.get("cum_fees_in_quote") or f.get("trade_fee_in_quote"))
            ts = (f.get("timestamp") or 0) / 1000.0  # ms -> s
            if pos == "CLOSE" and open_q:
                remaining, exit_fee = amt, fee
                while remaining > 1e-9 and open_q:
                    o = open_q[0]
                    use = min(remaining, o["amt"])
                    frac = use / amt if amt else 1.0
                    ofrac = use / o["amt0"] if o["amt0"] else 1.0
                    sign = 1 if o["side"] == "BUY" else -1  # long if opened with a BUY
                    pnl = sign * (price - o["price"]) * use - o["fee"] * ofrac - exit_fee * frac
                    out.append(_pos_dict(pair, o["side"], o["ts"], ts, o["price"], price, use, pnl))
                    o["amt"] -= use
                    remaining -= use
                    if o["amt"] <= 1e-9:
                        open_q.popleft()
            else:  # OPEN (or an unmatched fill we treat as a new leg)
                open_q.append({"ts": ts, "price": price, "amt": amt, "amt0": amt, "side": side, "fee": fee})
        for o in open_q:  # still-open positions: show with no exit yet
            out.append(_pos_dict(pair, o["side"], o["ts"], None, o["price"], o["price"], o["amt"], None,
                                 close_type="OPEN"))
    out.sort(key=lambda e: e["timestamp"])
    return out


def _pos_dict(pair, open_side, ts, close_ts, entry, exit_px, amount, pnl, close_type="LIVE"):
    notional = entry * amount if entry else 0.0
    return {
        "id": f"{pair}-{int(ts)}", "controller_id": pair, "trading_pair": pair,
        "side": "BUY" if open_side == "BUY" else "SELL",
        "timestamp": ts, "close_timestamp": close_ts, "close_type": close_type,
        "entry_price": entry, "exit_price": exit_px,
        "net_pnl_quote": pnl, "net_pnl_pct": (pnl / notional) if (pnl is not None and notional) else None,
        "filled_amount_quote": notional,
        "custom_info": {"current_position_average_price": entry, "close_price": exit_px},
        "config": {"side": open_side},
    }


def live_fills_table(trades):
    """Raw fills table (every OPEN/CLOSE order the running bot executed)."""
    rows = [{
        "Time": pd.to_datetime((t.get("timestamp") or 0) / 1000.0, unit="s"),
        "Pair": t.get("trading_pair"), "Side": t.get("trade_type"),
        "Pos": t.get("position"), "Type": t.get("order_type"),
        "Price": _f(t.get("price")), "Amount": _f(t.get("amount")),
        "Fee ($)": round(_f(t.get("cum_fees_in_quote") or t.get("trade_fee_in_quote")), 4),
    } for t in trades]
    return pd.DataFrame(rows).sort_values("Time") if rows else pd.DataFrame()


def controller_ids(executors):
    """Distinct controller_ids (strategies) present in a list of normalized executors."""
    return sorted({e.get("controller_id") for e in executors if e.get("controller_id")})


def filter_by_controller(executors, controller_id):
    if not controller_id or controller_id == "(all)":
        return executors
    return [e for e in executors if e.get("controller_id") == controller_id]


def match_trades(live, bt, tol_s):
    """Greedy nearest-entry-time matching of live<->backtest executors.

    Returns a list of (live_exec | None, bt_exec | None) pairs, sorted by entry
    time. Each backtest trade is used at most once. Live trades with no backtest
    counterpart within tol_s (and vice-versa) appear as half-empty rows so you
    can see 'live took a trade the backtest didn't' and the reverse.
    """
    live = sorted([e for e in live if e.get("timestamp")], key=lambda e: e["timestamp"])
    bt = sorted([e for e in bt if e.get("timestamp")], key=lambda e: e["timestamp"])
    used = set()
    pairs = []
    for L in live:
        best_j, best_d = None, None
        for j, B in enumerate(bt):
            if j in used:
                continue
            d = abs(B["timestamp"] - L["timestamp"])
            if tol_s is not None and d > tol_s:
                continue
            if best_d is None or d < best_d:
                best_j, best_d = j, d
        if best_j is not None:
            used.add(best_j)
            pairs.append((L, bt[best_j]))
        else:
            pairs.append((L, None))
    for j, B in enumerate(bt):
        if j not in used:
            pairs.append((None, B))
    pairs.sort(key=lambda p: (p[0] or p[1])["timestamp"])
    return pairs


def _fmt_ts(ts):
    return pd.to_datetime(ts, unit="s") if ts else None


def comparison_table(live, bt, tol_s):
    """Time-aligned live-vs-backtest table (one row per matched/unmatched trade)."""
    rows = []
    for L, B in match_trades(live, bt, tol_s):
        dt = None
        if L and B:
            dt = round(B["timestamp"] - L["timestamp"], 1)
        rows.append({
            "Live time": _fmt_ts(L["timestamp"]) if L else None,
            "BT time": _fmt_ts(B["timestamp"]) if B else None,
            "Δt (s)": dt,
            "Match": "✅ both" if (L and B) else ("🔴 live only" if L else "🔵 bt only"),
            "Side L": L["side"] if L else None,
            "Side BT": B["side"] if B else None,
            "Entry L": L["entry_price"] if L else None,
            "Entry BT": B["entry_price"] if B else None,
            "Exit L": L["exit_price"] if L else None,
            "Exit BT": B["exit_price"] if B else None,
            "Close L": L["close_type"] if L else None,
            "Close BT": B["close_type"] if B else None,
            "PnL$ L": round(L["net_pnl_quote"] or 0, 4) if L else None,
            "PnL$ BT": round(B["net_pnl_quote"] or 0, 4) if B else None,
        })
    return pd.DataFrame(rows)


def overlay_chart(live, bt, candles_df, title="Live vs Backtest"):
    """One chart: price candles + live entry→exit markers (solid) + backtest (dashed)."""
    if candles_df is None or candles_df.empty:
        return None
    fig = make_subplots(rows=1, cols=1)
    fig.add_trace(go.Candlestick(x=candles_df.index, open=candles_df["open"], high=candles_df["high"],
                                 low=candles_df["low"], close=candles_df["close"], name="Price",
                                 increasing_line_color="#2ECC71", decreasing_line_color="#E74C3C",
                                 opacity=0.55))
    for e in live:
        et, xt = _fmt_ts(e["timestamp"]), _fmt_ts(e["close_timestamp"] or e["timestamp"])
        fig.add_trace(go.Scatter(x=[et, xt], y=[e["entry_price"], e["exit_price"]], mode="lines+markers",
                                 line=dict(color="#1f77b4", width=3), marker=dict(size=8, symbol="circle"),
                                 legendgroup="live", name="LIVE", showlegend=False,
                                 hovertext=f"LIVE {e['side']} {e['close_type']} PnL {e['net_pnl_quote']:.4f}"))
    for e in bt:
        et, xt = _fmt_ts(e["timestamp"]), _fmt_ts(e["close_timestamp"] or e["timestamp"])
        fig.add_trace(go.Scatter(x=[et, xt], y=[e["entry_price"], e["exit_price"]], mode="lines+markers",
                                 line=dict(color="#ff7f0e", width=3, dash="dash"), marker=dict(size=8, symbol="x"),
                                 legendgroup="bt", name="BACKTEST", showlegend=False,
                                 hovertext=f"BT {e['side']} {e['close_type']} PnL {e['net_pnl_quote']:.4f}"))
    # one legend entry per group
    fig.add_trace(go.Scatter(x=[None], y=[None], mode="lines", line=dict(color="#1f77b4", width=3), name="LIVE"))
    fig.add_trace(go.Scatter(x=[None], y=[None], mode="lines", line=dict(color="#ff7f0e", width=3, dash="dash"),
                             name="BACKTEST"))
    fig.update_layout(height=600, xaxis_rangeslider_visible=False, showlegend=True, title=title,
                      legend=dict(orientation="h", yanchor="bottom", y=1.02))
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
