"""Auto-Tune — walk-forward Bayesian optimization of a controller's parameters.

Drives the (now Hyperliquid-capable) /backtesting/run endpoint, optimizes with
Optuna's TPE sampler across walk-forward folds, and reports honest out-of-sample
performance on an untouched holdout. See frontend/components/auto_tune.py.
"""
import json

import pandas as pd
import requests
import streamlit as st

from CONFIG import BACKEND_API_HOST, BACKEND_API_PASSWORD, BACKEND_API_PORT, BACKEND_API_USERNAME
from frontend.components.auto_tune import (OBJECTIVES, PARAM_GROUPS, optimize, run_backtest, score_results)
from frontend.st_utils import initialize_st_page

initialize_st_page(title="Auto-Tune", icon="🎛️", show_readme=False)


def _base_url():
    host = str(BACKEND_API_HOST)
    if not host.startswith(("http://", "https://")):
        return f"http://{host}:{BACKEND_API_PORT}"
    return host.rstrip("/")


def _auth():
    return (BACKEND_API_USERNAME, BACKEND_API_PASSWORD)


@st.cache_data(ttl=60)
def list_configs():
    r = requests.get(f"{_base_url()}/controllers/configs/", auth=_auth(), timeout=30)
    r.raise_for_status()
    d = r.json()
    return [c.get("id") if isinstance(c, dict) else c for c in (d if isinstance(d, list) else d.get("data", []))]


def get_config(cid):
    r = requests.get(f"{_base_url()}/controllers/configs/{cid}", auth=_auth(), timeout=30)
    r.raise_for_status()
    return r.json()


def save_config(cfg):
    r = requests.post(f"{_base_url()}/controllers/configs/{cfg['id']}", json=cfg, auth=_auth(), timeout=30)
    r.raise_for_status()
    return r.json()


st.caption("Bayesian (TPE) search with **walk-forward validation** — tunes on earlier folds, reports honest "
           "out-of-sample results on an untouched holdout. Designed to resist overfitting.")

cfg_ids = list_configs()
if not cfg_ids:
    st.error("No controller configs found.")
    st.stop()

c1, c2, c3 = st.columns(3)
with c1:
    cfg_id = st.selectbox("Controller config to tune", cfg_ids)
with c2:
    start = st.date_input("Start", pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=60))
with c3:
    end = st.date_input("End", pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=1))

base_cfg = get_config(cfg_id)
with st.expander("Base config"):
    st.json(base_cfg)

st.markdown("### Search settings")
groups_labels = st.multiselect("Parameters to tune", list(PARAM_GROUPS.keys()), default=list(PARAM_GROUPS.keys()))
groups = [PARAM_GROUPS[g] for g in groups_labels]

s1, s2, s3, s4 = st.columns(4)
with s1:
    objective = st.selectbox("Objective (maximize)", OBJECTIVES, index=0)
with s2:
    n_trials = st.number_input("Trials", 5, 200, 25, step=5,
                               help="Each trial runs one backtest per fold. More trials = better search, slower.")
with s3:
    n_folds = st.number_input("Walk-forward folds", 2, 6, 3)
with s4:
    resolution = st.select_slider("Backtest resolution", ["1m", "5m", "15m", "1h"], value="5m",
                                  help="Finer = more accurate (esp. trailing stop) but slower. Winner is re-checked on holdout.")
s5, s6, s7 = st.columns(3)
with s5:
    holdout_frac = st.slider("Holdout fraction (out-of-sample)", 0.1, 0.4, 0.25, 0.05)
with s6:
    min_trades = st.number_input("Min trades per fold", 1, 50, 5,
                                 help="Folds with fewer trades are ignored (not statistically meaningful).")
with s7:
    consistency_penalty = st.slider("Consistency penalty", 0.0, 2.0, 0.5, 0.1,
                                    help="Penalizes params whose score varies a lot across folds (anti-overfit).")

est = int(n_trials) * int(n_folds) + 1
st.caption(f"≈ {est} backtests will run ({n_trials} trials × {n_folds} folds + 1 holdout). "
           f"This can take several minutes; results are cached.")

if not groups:
    st.warning("Select at least one parameter group to tune.")
    st.stop()

if st.button("🎛️ Run Auto-Tune", type="primary"):
    start_s = int(pd.Timestamp(start).timestamp())
    end_s = int(pd.Timestamp(end).timestamp()) + 86399
    prog = st.progress(0.0)
    status = st.empty()

    def cb(done, total, best):
        prog.progress(min(done / total, 1.0))
        status.write(f"Trial {done}/{total} — best {objective}: {best:.4f}" if best is not None else f"Trial {done}/{total}")

    with st.spinner("Optimizing..."):
        out = optimize(base_cfg, groups, start_s, end_s, n_trials=int(n_trials), n_folds=int(n_folds),
                       holdout_frac=float(holdout_frac), resolution=resolution, objective=objective,
                       min_trades=int(min_trades), consistency_penalty=float(consistency_penalty), progress_cb=cb)
    prog.progress(1.0)
    st.session_state["autotune_out"] = out
    st.session_state["autotune_base"] = base_cfg

out = st.session_state.get("autotune_out")
if out:
    st.markdown("---")
    st.markdown("## Results")
    st.success(f"Best in-sample {out['objective']} (mean across folds, penalized): **{out['best_value']:.4f}**")

    # honest comparison: baseline vs tuned on the untouched holdout
    base_cfg = st.session_state.get("autotune_base", base_cfg)
    hs, he = out["holdout"]
    try:
        base_holdout = run_backtest(json.dumps(base_cfg, sort_keys=True), hs, he, out["resolution"])
    except Exception:
        base_holdout = {}
    tuned_holdout = out["holdout_results"]

    def row(label, r):
        return {"Config": label, "Net PnL ($)": round(r.get("net_pnl_quote", 0), 4),
                "Sharpe": round(r.get("sharpe_ratio", 0), 3), "Profit factor": round(r.get("profit_factor", 0), 3),
                "Accuracy": round(r.get("accuracy", 0) * 100, 1), "Trades": r.get("total_positions", 0),
                "Max DD %": round(r.get("max_drawdown_pct", 0) * 100, 2)}
    st.markdown("### Out-of-sample (holdout) — baseline vs tuned")
    st.caption("The holdout window was never used during the search. This is the number that matters.")
    cmp_df = pd.DataFrame([row("Baseline", base_holdout), row("Tuned", tuned_holdout)])
    st.dataframe(cmp_df, use_container_width=True, hide_index=True)
    if (tuned_holdout.get("net_pnl_quote", 0) or 0) <= (base_holdout.get("net_pnl_quote", 0) or 0):
        st.warning("⚠️ Tuned params did NOT beat the baseline out-of-sample — likely overfit to the search window, "
                   "or the search space/objective needs adjusting. Do not deploy this.")

    st.markdown("### Best parameters")
    st.json(out["best_params"])

    # Optuna visualizations (history, importances, and the smooth contour surface)
    try:
        import optuna.visualization as ov
        st.markdown("### Optimization history")
        st.plotly_chart(ov.plot_optimization_history(out["study"]), use_container_width=True)
        params = list(out["best_params"].keys())
        if len(params) >= 2:
            st.markdown("### Parameter importance")
            st.plotly_chart(ov.plot_param_importances(out["study"]), use_container_width=True)
            st.markdown("### Response surface (smoothed)")
            cc1, cc2 = st.columns(2)
            with cc1:
                px = st.selectbox("X param", params, index=0, key="contour_x")
            with cc2:
                py = st.selectbox("Y param", params, index=1, key="contour_y")
            if px != py:
                st.plotly_chart(ov.plot_contour(out["study"], params=[px, py]), use_container_width=True)
                st.caption("This interpolated surface is the rigorous version of the 'smooth curve over the data' "
                           "idea — pick a stable plateau, not a lone spike.")
    except Exception as e:
        st.info(f"Visualization unavailable: {e}")

    st.markdown("### Save tuned config")
    new_id = st.text_input("New config id", value=f"{cfg_id}_tuned")
    if st.button("💾 Save as new config"):
        cfg = json.loads(json.dumps(out["best_cfg"]))
        cfg["id"] = new_id
        try:
            save_config(cfg)
            st.success(f"Saved '{new_id}'. Find it in the config list / Deploy V2.")
        except Exception as e:
            st.error(f"Save failed: {e}")
