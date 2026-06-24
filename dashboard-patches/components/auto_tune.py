"""Auto-Tune (my-trading): walk-forward Bayesian optimization of strategy params.

Approach (statistically honest — overfitting is the failure mode we design against):
  * Search with Optuna's TPE sampler (a Bayesian method; the GP sampler needs
    PyTorch, too heavy for the dashboard image). It fits a probabilistic model of
    the parameter->score surface and proposes the next params intelligently.
  * Walk-forward: the search region is split into K consecutive folds; a trial's
    objective is the MEAN fold score minus a consistency penalty (std across
    folds), so params that only work in one period are rejected.
  * A final HOLDOUT segment (the most recent slice) is never seen during search;
    the winner is evaluated there for an honest out-of-sample number.

It drives the existing /backtesting/run endpoint (now Hyperliquid/HIP-3 capable),
so it inherits the intrabar TP/trailing fidelity of the simulator patch.
"""
import json

import numpy as np
import requests
import streamlit as st

from CONFIG import BACKEND_API_HOST, BACKEND_API_PASSWORD, BACKEND_API_PORT, BACKEND_API_USERNAME

# Tunable parameter groups (matches the AskUserQuestion selections).
PARAM_GROUPS = {
    "Trailing stop + stop loss": "trailing_sl",
    "Signal params": "signal",
    "Interval": "interval",
    "Time limit + cooldown": "time",
}
INTERVAL_CHOICES = ["1m", "5m", "15m", "1h"]
TIME_LIMIT_CHOICES = [3600, 7200, 21600, 43200, 86400, 172800]
OBJECTIVES = ["sharpe_ratio", "profit_factor", "net_pnl_quote", "accuracy"]


def _base_url():
    host = str(BACKEND_API_HOST)
    if not host.startswith(("http://", "https://")):
        return f"http://{host}:{BACKEND_API_PORT}"
    return host.rstrip("/")


@st.cache_data(ttl=1800, show_spinner=False)
def run_backtest(cfg_json, start, end, resolution, trade_cost=0.0006):
    """Cached single backtest. cfg_json is a sorted-keys JSON string for cache stability."""
    cfg = json.loads(cfg_json)
    payload = {"start_time": int(start), "end_time": int(end),
               "backtesting_resolution": resolution, "trade_cost": trade_cost, "config": cfg}
    r = requests.post(f"{_base_url()}/backtesting/run", json=payload,
                      auth=(BACKEND_API_USERNAME, BACKEND_API_PASSWORD), timeout=600)
    r.raise_for_status()
    return r.json().get("results", {})


def score_results(results, objective, min_trades):
    """Single-window score; returns None when there aren't enough trades to trust it."""
    if not results:
        return None
    n = results.get("total_positions", 0) or 0
    if n < min_trades:
        return None
    val = results.get(objective)
    if val is None:
        return None
    # Guard against inf/nan (e.g. profit_factor with zero losses)
    if not np.isfinite(val):
        return None
    return float(val)


def build_config(trial, base_cfg, groups):
    """Apply the selected tunable groups onto a copy of base_cfg using an Optuna trial."""
    cfg = json.loads(json.dumps(base_cfg))  # deep copy
    if "trailing_sl" in groups:
        cfg["stop_loss"] = trial.suggest_float("stop_loss", 0.003, 0.05, log=True)
        act = trial.suggest_float("ts_activation", 0.002, 0.03, log=True)
        delta = trial.suggest_float("ts_delta", 0.001, 0.02, log=True)
        cfg["trailing_stop"] = {"activation_price": act, "trailing_delta": min(delta, act)}
        # keep TP above the activation so it stays the outer barrier (it rarely fires anyway)
        cfg["take_profit"] = max(cfg.get("take_profit", 0.02), act * 3)
    if "signal" in groups:
        cfg["rel_volume_mult"] = trial.suggest_float("rel_volume_mult", 1.2, 4.0)
        cfg["range_lookback"] = trial.suggest_int("range_lookback", 10, 60)
        cfg["vol_lookback"] = trial.suggest_int("vol_lookback", 10, 60)
    if "interval" in groups:
        iv = trial.suggest_categorical("interval", INTERVAL_CHOICES)
        cfg["interval"] = iv
    if "time" in groups:
        cfg["time_limit"] = trial.suggest_categorical("time_limit", TIME_LIMIT_CHOICES)
        cfg["cooldown_time"] = trial.suggest_int("cooldown_time", 0, 3600, step=300)
    return cfg


def split_windows(start, end, n_folds, holdout_frac):
    """Return (search_folds, holdout_window). Holdout is the most recent slice."""
    total = end - start
    holdout_start = end - int(total * holdout_frac)
    seg = (holdout_start - start) // n_folds
    folds = [(start + i * seg, start + (i + 1) * seg) for i in range(n_folds)]
    return folds, (holdout_start, end)


def make_objective(base_cfg, groups, folds, resolution, objective, min_trades, consistency_penalty):
    def objective_fn(trial):
        cfg = build_config(trial, base_cfg, groups)
        res_resolution = resolution
        # if interval is tuned, never run the engine finer than the candle interval
        if "interval" in groups:
            order = {"1m": 0, "5m": 1, "15m": 2, "1h": 3}
            if order.get(res_resolution, 0) > order.get(cfg["interval"], 3):
                res_resolution = cfg["interval"]
        scores = []
        for (fs, fe) in folds:
            try:
                results = run_backtest(json.dumps(cfg, sort_keys=True), fs, fe, res_resolution)
                s = score_results(results, objective, min_trades)
            except Exception:
                s = None
            scores.append(s)
        valid = [s for s in scores if s is not None]
        trial.set_user_attr("fold_scores", scores)
        trial.set_user_attr("config", cfg)
        if len(valid) < max(1, len(folds) // 2):
            return -1e6  # too few tradeable folds -> reject
        return float(np.mean(valid) - consistency_penalty * np.std(valid))
    return objective_fn


def optimize(base_cfg, groups, start, end, *, n_trials=20, n_folds=3, holdout_frac=0.25,
             resolution="5m", objective="sharpe_ratio", min_trades=5, consistency_penalty=0.5,
             progress_cb=None, seed=42):
    """Run the walk-forward Bayesian search. Returns a dict of results."""
    import optuna
    from optuna.samplers import TPESampler
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    folds, holdout = split_windows(start, end, n_folds, holdout_frac)
    study = optuna.create_study(direction="maximize", sampler=TPESampler(seed=seed))
    obj = make_objective(base_cfg, groups, folds, resolution, objective, min_trades, consistency_penalty)

    def _cb(study_, trial_):
        if progress_cb:
            progress_cb(len(study_.trials), n_trials, study_.best_value if study_.best_trial else None)
    study.optimize(obj, n_trials=n_trials, callbacks=[_cb])

    best = study.best_trial
    best_cfg = best.user_attrs.get("config", base_cfg)
    # honest out-of-sample evaluation on the untouched holdout
    res_resolution = resolution
    if "interval" in groups:
        order = {"1m": 0, "5m": 1, "15m": 2, "1h": 3}
        if order.get(res_resolution, 0) > order.get(best_cfg.get("interval", "1h"), 3):
            res_resolution = best_cfg["interval"]
    try:
        holdout_results = run_backtest(json.dumps(best_cfg, sort_keys=True), holdout[0], holdout[1], res_resolution)
    except Exception:
        holdout_results = {}
    return {
        "study": study, "best_trial": best, "best_cfg": best_cfg,
        "best_value": best.value, "best_params": best.params,
        "folds": folds, "holdout": holdout, "holdout_results": holdout_results,
        "objective": objective, "resolution": res_resolution,
    }
