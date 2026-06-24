"""Monitor Bots — per-trade analysis & live-vs-backtest debugging.

Why this page exists
--------------------
The stock dashboard has no usable surface to inspect individual trades: you
can't see per-bot/per-pair win rate, color-coded PnL, each trade's
entry/exit/close-type, or a trade plotted on a chart. That makes diagnosing
live-vs-backtest divergence guesswork. This page provides:
  * per-bot, per-pair summary (WR%, trades, PnL, close-type breakdown) with
    green/red color coding,
  * a selectable trade list and a candlestick chart per trade, and
  * a live-vs-backtest overlay to localize where the two diverge.

The reusable visualization lives in frontend/components/trade_viz.py (shared
with the Scalping Breakout config page). Data sources (verified): archived bots
expose full executor history via the API; running bots only expose
per-controller performance (the live Executors table isn't populated until the
bot is archived), so live bots show the summary and you get full per-trade
analysis once a bot is archived.
"""
import pandas as pd
import requests
import streamlit as st

from CONFIG import BACKEND_API_HOST, BACKEND_API_PASSWORD, BACKEND_API_PORT, BACKEND_API_USERNAME
from frontend.components.trade_viz import close_type_name, color_pnl, render_executor_analysis
from frontend.st_utils import initialize_st_page

initialize_st_page(title="Monitor Bots", icon="📈", show_readme=False)


# --------------------------------------------------------------------------- API
def _base_url():
    host = str(BACKEND_API_HOST)
    if not host.startswith(("http://", "https://")):
        return f"http://{host}:{BACKEND_API_PORT}"
    return host.rstrip("/")


def _auth():
    return (BACKEND_API_USERNAME, BACKEND_API_PASSWORD)


@st.cache_data(ttl=20)
def api_get(path):
    r = requests.get(f"{_base_url()}{path}", auth=_auth(), timeout=60)
    r.raise_for_status()
    return r.json()


def api_post(path, payload):
    r = requests.post(f"{_base_url()}{path}", json=payload, auth=_auth(), timeout=600)
    r.raise_for_status()
    return r.json()


# ------------------------------------------------------------------------- views
def render_archived(db_path):
    data = api_get(f"/archived-bots/{db_path}/executors")
    raw = data if isinstance(data, list) else (data.get("data") or data.get("executors") or [])
    render_executor_analysis(raw, processed_data=None, key_prefix="arch")


def render_live(bot_name):
    status = api_get(f"/bot-orchestration/{bot_name}/status")
    perf = (status.get("data") or {}).get("performance", {})
    if not perf:
        st.info("No performance data for this bot yet.")
        return
    rows = []
    for cid, v in perf.items():
        p = v.get("performance", {})
        ct = p.get("close_type_counts", {})
        tp = ct.get("CloseType.TAKE_PROFIT", 0); ts = ct.get("CloseType.TRAILING_STOP", 0)
        sl = ct.get("CloseType.STOP_LOSS", 0); tl = ct.get("CloseType.TIME_LIMIT", 0)
        total = tp + ts + sl + tl + ct.get("CloseType.EARLY_STOP", 0) + ct.get("CloseType.FAILED", 0)
        wr = round(100.0 * (tp + ts) / total, 1) if total else None
        rows.append({
            "Controller": cid, "Status": v.get("status"),
            "Realized ($)": round(p.get("realized_pnl_quote", 0), 4),
            "Unrealized ($)": round(p.get("unrealized_pnl_quote", 0), 4),
            "Net ($)": round(p.get("global_pnl_quote", 0), 4),
            "Volume ($)": round(p.get("volume_traded", 0), 2),
            "WR % (by close-type)": wr,
            "Close Types": " | ".join(f"{k.replace('CloseType.', '')}:{n}" for k, n in ct.items()) or "—",
        })
    df = pd.DataFrame(rows)
    st.subheader("Live per-controller performance")
    st.dataframe(df.style.apply(color_pnl, subset=["Realized ($)", "Unrealized ($)", "Net ($)"]),
                 use_container_width=True, hide_index=True)
    st.caption("Running bots only expose per-controller performance. Archive the bot for full per-trade "
               "analysis (individual entries/exits + charts).")


def render_backtest_overlay():
    st.markdown("---")
    st.subheader("🔬 Live vs Backtest (debug divergence)")
    st.caption("Run a backtest for a saved controller config and compare its trades to live. "
               "Hyperliquid/HIP-3 markets are now supported natively.")
    try:
        cfgs = api_get("/controllers/configs/")
        cfg_ids = [c.get("id") if isinstance(c, dict) else c
                   for c in (cfgs if isinstance(cfgs, list) else cfgs.get("data", []))]
    except Exception as e:
        st.error(f"Could not list controller configs: {e}")
        return
    c1, c2, c3 = st.columns(3)
    with c1:
        cfg_id = st.selectbox("Controller config", cfg_ids)
    with c2:
        start = st.date_input("Start", pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=7))
    with c3:
        end = st.date_input("End", pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=1))
    res = st.select_slider("Resolution", ["1m", "5m", "15m", "1h"], value="1m")
    if st.button("Run backtest", type="primary"):
        try:
            cfg = api_get(f"/controllers/configs/{cfg_id}")
            payload = {
                "start_time": int(pd.Timestamp(start).timestamp()),
                "end_time": int(pd.Timestamp(end).timestamp()) + 86399,
                "backtesting_resolution": res, "trade_cost": 0.0006, "config": cfg,
            }
            with st.spinner("Running backtest..."):
                result = api_post("/backtesting/run", payload)
        except Exception as e:
            st.error(f"Backtest failed: {e}")
            return
        results = result.get("results", {})
        ex = result.get("executors", [])
        if not ex:
            st.warning("Backtest produced no trades in this window.")
            return
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Net PnL ($)", f"{results.get('net_pnl_quote', 0):.4f}")
        m2.metric("Trades", results.get("total_positions", len(ex)))
        m3.metric("Accuracy", f"{results.get('accuracy', 0) * 100:.1f}%")
        m4.metric("Profit factor", f"{results.get('profit_factor', 0):.2f}")
        from collections import Counter
        cc = Counter(close_type_name(e.get("close_type")) for e in ex)
        st.write("**Backtest close types:**", dict(cc))
        st.caption("If trailing-stop closes appear here (they didn't in the stock engine), the intrabar "
                   "simulator patch is active. Compare these against the live bot above.")
        # Visual trade-by-trade breakdown of the backtest (candlesticks + markers).
        render_executor_analysis(ex, result.get("processed_data"), key_prefix="mb_bt")


# ---------------------------------------------------------------------------- UI
st.caption("Inspect every trade, per bot and per pair — color-coded PnL, win rate, close types, and a chart per trade.")
source = st.radio("Source", ["Archived bots", "Live bots"], horizontal=True)

try:
    if source == "Archived bots":
        archived = api_get("/archived-bots/")
        dbs = archived if isinstance(archived, list) else archived.get("data", [])
        if not dbs:
            st.info("No archived bots yet.")
        else:
            db = st.selectbox("Archived bot", dbs,
                              format_func=lambda p: p.split("/")[2] if len(p.split("/")) > 2 else p)
            render_archived(db)
    else:
        active = api_get("/bot-orchestration/status")
        data = active.get("data", active)
        names = list(data.keys()) if isinstance(data, dict) else []
        if not names:
            st.info("No active bots. Showing recent bot runs instead.")
            runs = api_get("/bot-orchestration/bot-runs")
            names = sorted({r.get("bot_name") for r in runs.get("data", []) if r.get("bot_name")})
        if names:
            bot = st.selectbox("Bot", names)
            render_live(bot)
except Exception as e:
    st.error(f"Failed to load bot data: {e}")

render_backtest_overlay()
