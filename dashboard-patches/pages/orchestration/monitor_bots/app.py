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
  * a "Compare Live vs Backtest" mode: pick the exact strategy (controller) on
    each side, run a backtest over the same time window, and get a time-aligned
    comparison table plus a single overlay graph (live trades vs backtest
    trades on the same price chart) to localize where the two diverge.

State note: backtest results and the loaded live trades are kept in
st.session_state, so selecting a trade or changing the chart interval no longer
wipes the page (Streamlit reruns the whole script on every widget change; a
result gated only behind a button would otherwise disappear).

The reusable visualization lives in frontend/components/trade_viz.py (shared
with the Scalping Breakout config page). Live per-trade data (entry/exit times,
close types) only exists once a bot is archived, so the comparison uses archived
bots as the "live" source.
"""
import pandas as pd
import requests
import streamlit as st

from CONFIG import BACKEND_API_HOST, BACKEND_API_PASSWORD, BACKEND_API_PORT, BACKEND_API_USERNAME
from frontend.components.trade_viz import (close_type_name, color_pnl, comparison_table, controller_ids,
                                           fetch_hl_candles, fills_to_positions, filter_by_controller,
                                           live_db_path, live_fills_table, normalize_executor, overlay_chart,
                                           render_executor_analysis, summary_table)
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


def load_archived_executors(db_path):
    data = api_get(f"/archived-bots/{db_path}/executors")
    raw = data if isinstance(data, list) else (data.get("data") or data.get("executors") or [])
    return [normalize_executor(e) for e in raw if e.get("close_timestamp")]


def load_live_fills(bot_name):
    """Live fills (TradeFill rows) for a RUNNING bot, read from its live sqlite.
    Returns [] gracefully if the bot hasn't traded yet / db not readable."""
    try:
        data = api_get(f"/archived-bots/{live_db_path(bot_name)}/trades")
    except Exception:
        return []
    return data if isinstance(data, list) else (data.get("data") or data.get("trades") or [])


def list_config_ids():
    cfgs = api_get("/controllers/configs/")
    return [c.get("id") if isinstance(c, dict) else c
            for c in (cfgs if isinstance(cfgs, list) else cfgs.get("data", []))]


def run_backtest(cfg_id, start_ts, end_ts, res):
    cfg = api_get(f"/controllers/configs/{cfg_id}")
    payload = {"start_time": int(start_ts), "end_time": int(end_ts),
               "backtesting_resolution": res, "trade_cost": 0.0006, "config": cfg}
    return api_post("/backtesting/run", payload)


def _db_label(p):
    parts = p.split("/")
    return parts[2] if len(parts) > 2 else p


# ----------------------------------------------------------------- single-bot view
def render_archived(db_path):
    data = api_get(f"/archived-bots/{db_path}/executors")
    raw = data if isinstance(data, list) else (data.get("data") or data.get("executors") or [])
    execs = [normalize_executor(e) for e in raw if e.get("close_timestamp")]
    ctrls = controller_ids(execs)
    if len(ctrls) > 1:
        pick = st.selectbox("Strategy (controller)", ["(all)"] + ctrls, key="arch_ctrl")
        raw = [e for e in raw if pick == "(all)" or e.get("controller_id") == pick]
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

    # --- actual live trades (reconstructed from the bot's live TradeFill table) ---
    st.subheader("🔴 Live trades")
    fills = load_live_fills(bot_name)
    if not fills:
        st.info("No fills yet for this bot (the strategy hasn't entered a position). "
                "Live trades appear here the moment the bot fills an order — no need to archive.")
        return
    pairs = sorted({t.get("trading_pair") for t in fills if t.get("trading_pair")})
    pick = st.selectbox("Pair (strategy)", ["(all)"] + pairs, key="live_pair") if len(pairs) > 1 else "(all)"
    fsel = [t for t in fills if pick == "(all)" or t.get("trading_pair") == pick]

    positions = fills_to_positions(fsel)
    closed = [p for p in positions if p["close_timestamp"]]
    open_ps = [p for p in positions if not p["close_timestamp"]]
    realized = sum(p["net_pnl_quote"] or 0 for p in closed)
    a, b, c = st.columns(3)
    a.metric("Fills", len(fsel))
    b.metric("Closed positions", len(closed))
    c.metric("Realized PnL ($)", f"{realized:.4f}")
    if open_ps:
        st.caption("Open now: " + ", ".join(f"{p['side']} {p['trading_pair']} @ {p['entry_price']}" for p in open_ps))

    st.markdown("**Round-trip positions** (paired OPEN→CLOSE fills)")
    if closed:
        render_executor_analysis(closed, processed_data=None, key_prefix="live", show_summary=True)
    else:
        st.caption("No completed round-trips yet — only open position(s) so far.")

    with st.expander("Raw fills (every order executed)"):
        ft = live_fills_table(fsel)
        if not ft.empty:
            st.dataframe(ft.style.apply(lambda col: ["color:#2ECC71" if v == "BUY" else "color:#E74C3C"
                                                     for v in col] if col.name == "Side" else ["" for _ in col]),
                         use_container_width=True, hide_index=True)
    st.caption("Live exit reason (STOP_LOSS / TRAILING_STOP / …) isn't recorded in fills — it appears once "
               "the bot is archived (Executors table). PnL here is computed from the OPEN/CLOSE fill prices.")


def render_single():
    source = st.radio("Source", ["Archived bots", "Live bots"], horizontal=True, key="single_src")
    try:
        if source == "Archived bots":
            archived = api_get("/archived-bots/")
            dbs = archived if isinstance(archived, list) else archived.get("data", [])
            if not dbs:
                st.info("No archived bots yet.")
                return
            db = st.selectbox("Archived bot", dbs, format_func=_db_label, key="single_db")
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
                bot = st.selectbox("Bot", names, key="single_bot")
                render_live(bot)
    except Exception as e:
        st.error(f"Failed to load bot data: {e}")


# --------------------------------------------------------------- compare view
def _render_comparison_result():
    """Render from session_state so widget interactions don't wipe the page."""
    live = st.session_state.get("cmp_live") or []
    result = st.session_state.get("cmp_result") or {}
    tol_s = st.session_state.get("cmp_tol", 1800)
    bt = [normalize_executor(e) for e in result.get("executors", []) if e.get("close_timestamp")]
    if not bt:
        st.warning("Backtest produced no trades in this window — nothing to compare. "
                   "Widen the window or lower the volume filter.")
    res_meta = result.get("results", {})

    # headline metrics: live vs backtest
    lpnl = sum(e["net_pnl_quote"] or 0 for e in live)
    bpnl = sum(e["net_pnl_quote"] or 0 for e in bt)
    m = st.columns(4)
    m[0].metric("Live trades", len(live))
    m[1].metric("Backtest trades", len(bt))
    m[2].metric("Live net PnL ($)", f"{lpnl:.4f}")
    m[3].metric("Backtest net PnL ($)", f"{bpnl:.4f}", delta=f"{bpnl - lpnl:.4f} vs live")

    st.subheader("⏱️ Time-aligned comparison")
    st.caption(f"Each live trade paired with the nearest backtest trade within ±"
               f"{int(tol_s/60)} min. 🔴 live-only = live took a trade the backtest didn't; "
               "🔵 bt-only = the reverse.")
    cmp_df = comparison_table(live, bt, tol_s)
    if not cmp_df.empty:
        st.dataframe(cmp_df.style.apply(color_pnl, subset=["PnL$ L", "PnL$ BT"]),
                     use_container_width=True, hide_index=True)
        both = int((cmp_df["Match"] == "✅ both").sum())
        st.caption(f"Matched: {both} • live-only: {int((cmp_df['Match'] == '🔴 live only').sum())} "
                   f"• backtest-only: {int((cmp_df['Match'] == '🔵 bt only').sum())}")

    st.subheader("📈 Overlay — live trades vs backtest trades")
    pair = st.session_state.get("cmp_pair")
    interval = st.select_slider("Overlay candle interval", ["1m", "5m", "15m", "1h"], value="5m",
                                key="cmp_interval")
    allx = live + bt
    if pair and allx:
        t0 = min(e["timestamp"] for e in allx)
        t1 = max((e["close_timestamp"] or e["timestamp"]) for e in allx)
        pad = max(int((t1 - t0) * 0.05), 1800)
        candles = fetch_hl_candles(pair, interval, t0 - pad, t1 + pad)
        fig = overlay_chart(live, bt, candles, title=f"{pair} — LIVE vs BACKTEST")
        if fig is not None:
            st.plotly_chart(fig, use_container_width=True, key="cmp_overlay")
        else:
            st.warning("Could not fetch candles for this window.")

    with st.expander("Per-side summary tables"):
        c1, c2 = st.columns(2)
        with c1:
            st.markdown("**Live**")
            if live:
                st.dataframe(summary_table(live), use_container_width=True, hide_index=True)
        with c2:
            st.markdown("**Backtest**")
            if bt:
                st.dataframe(summary_table(bt), use_container_width=True, hide_index=True)
    if res_meta:
        st.caption(f"Backtest engine: net_pnl={res_meta.get('net_pnl_quote', 0):.4f} "
                   f"accuracy={res_meta.get('accuracy', 0) * 100:.1f}% "
                   f"profit_factor={res_meta.get('profit_factor', 0):.2f}")


def render_compare():
    st.caption("Compare a bot's real trades against a backtest of a chosen strategy, trade-by-trade and "
               "on one chart — to understand why live diverged from backtest.")
    try:
        cfg_ids = list_config_ids()
    except Exception as e:
        st.error(f"Could not load controller configs: {e}")
        return

    src = st.radio("Live trades from", ["Archived bot", "Running bot (live fills)"], horizontal=True,
                   key="cmp_src")
    try:
        if src == "Archived bot":
            archived = api_get("/archived-bots/")
            dbs = archived if isinstance(archived, list) else archived.get("data", [])
            if not dbs:
                st.info("No archived bots yet.")
                return
            db = st.selectbox("Archived bot", dbs, format_func=_db_label, key="cmp_db")
            live_all = load_archived_executors(db)
        else:
            active = api_get("/bot-orchestration/status")
            data = active.get("data", active)
            names = list(data.keys()) if isinstance(data, dict) else []
            if not names:
                st.info("No running bots.")
                return
            bot = st.selectbox("Running bot", names, key="cmp_runbot")
            live_all = [p for p in fills_to_positions(load_live_fills(bot)) if p["close_timestamp"]]
            if not live_all:
                st.warning("This running bot has no completed round-trips yet (only open positions). "
                           "It needs at least one OPEN→CLOSE before there's anything to compare.")
                return
    except Exception as e:
        st.error(f"Failed to load live trades: {e}")
        return
    if not live_all:
        st.warning("No closed trades to compare.")
        return

    ctrls = controller_ids(live_all)
    c1, c2 = st.columns(2)
    with c1:
        live_ctrl = st.selectbox("Live strategy (controller / pair)", ctrls, key="cmp_live_ctrl")
    live = filter_by_controller(live_all, live_ctrl)
    default_idx = cfg_ids.index(live_ctrl) if live_ctrl in cfg_ids else 0
    with c2:
        bt_cfg = st.selectbox("Backtest strategy (config)", cfg_ids, index=default_idx, key="cmp_bt_cfg",
                              help="Defaults to the same id as the live controller when it exists.")

    pair = live[0]["trading_pair"] if live else None
    t0 = min(e["timestamp"] for e in live)
    t1 = max((e["close_timestamp"] or e["timestamp"]) for e in live)
    st.caption(f"Live: **{len(live)}** trades on **{pair}** between "
               f"{pd.to_datetime(t0, unit='s')} and {pd.to_datetime(t1, unit='s')} (UTC). "
               "Backtest window defaults to this range.")
    d1, d2, d3, d4 = st.columns(4)
    with d1:
        start = st.date_input("BT start", pd.to_datetime(t0, unit="s").normalize(), key="cmp_start")
    with d2:
        end = st.date_input("BT end", pd.to_datetime(t1, unit="s").normalize() + pd.Timedelta(days=1),
                            key="cmp_end")
    with d3:
        res = st.select_slider("Resolution", ["1m", "5m", "15m", "1h"], value="1m", key="cmp_res")
    with d4:
        tol_min = st.slider("Match ± min", 1, 240, 30, key="cmp_tolmin")

    if st.button("Run comparison", type="primary", key="cmp_run"):
        try:
            with st.spinner("Running backtest over the live window..."):
                result = run_backtest(bt_cfg, pd.Timestamp(start).timestamp(),
                                      pd.Timestamp(end).timestamp() + 86399, res)
        except Exception as e:
            st.error(f"Backtest failed: {e}")
            return
        st.session_state["cmp_result"] = result
        st.session_state["cmp_live"] = live
        st.session_state["cmp_pair"] = pair
        st.session_state["cmp_tol"] = tol_min * 60

    if "cmp_result" in st.session_state:
        st.markdown("---")
        _render_comparison_result()


# ---------------------------------------------------------------------------- UI
mode = st.radio("Mode", ["Single bot", "🔬 Compare Live vs Backtest"], horizontal=True, key="mb_mode")
if mode == "Single bot":
    render_single()
else:
    render_compare()
