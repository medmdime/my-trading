from datetime import datetime, timedelta

import requests
import streamlit as st

from CONFIG import BACKEND_API_HOST, BACKEND_API_PASSWORD, BACKEND_API_PORT, BACKEND_API_USERNAME

# hummingbot's backtesting engine hard-codes these connectors as unavailable for the
# trading-rules connector (BacktestingDataProvider.EXCLUDED_CONNECTORS). Using one of
# them as `connector_name` makes the engine return a None connector and crash with
# "'NoneType' object has no attribute '_update_trading_rules'". For a BACKTEST the
# trading-rules source only affects order sizing, so we transparently swap to the
# candles connector (which has valid rules + history). The saved/live config the user
# deploys is untouched — live trading does not use this excluded list.
_BACKTEST_EXCLUDED_CONNECTORS = {
    "hyperliquid_perpetual", "hyperliquid", "dydx_perpetual", "dydx_v4_perpetual",
    "cube", "vertex", "coinbase_advanced_trade", "kraken", "hitbtc",
    "injective_v2_perpetual", "injective_v2",
}


def _get_base_url():
    """Build the backend base URL from CONFIG (mirrors st_utils.get_backend_api_client)."""
    if not str(BACKEND_API_HOST).startswith(("http://", "https://")):
        return f"http://{BACKEND_API_HOST}:{BACKEND_API_PORT}"
    return f"{BACKEND_API_HOST}:{BACKEND_API_PORT}"


def _run_backtesting_request(backend_api_client, start_time, end_time, backtesting_resolution, trade_cost, config):
    """Call the backend /backtesting/run endpoint directly.

    The bundled hummingbot_api_client posts to /backtesting/run-backtesting, which does not
    exist on this backend image (it serves /backtesting/run), so we hit the route directly.
    """
    base_url = _get_base_url().rstrip("/")
    # The controller config model requires an `id`; the page inputs don't include one,
    # so inject a deterministic placeholder (the value is irrelevant for a backtest run).
    config = dict(config)
    config.setdefault("id", f"{config.get('controller_name', 'controller')}_backtest")
    # Swap an excluded trading-rules connector for the candles connector so the engine
    # can build trading rules (see _BACKTEST_EXCLUDED_CONNECTORS above).
    #
    # NOTE (my-trading patch): Hyperliquid is now backtestable natively — the API
    # image injects Hyperliquid trading rules from a cached snapshot
    # (see api-patches/backtesting_data_provider.py), and the Hyperliquid candles
    # feed already supports the HIP-3 builder-dex markets (XYZ:SP500-USD, etc.).
    # So we DON'T swap Hyperliquid to Binance anymore — that swap silently changed
    # the data source (different OHLCV/volume -> different entries) and was
    # impossible for HIP-3 markets (no Binance equivalent). The swap is kept only
    # for the other genuinely-unsupported excluded connectors.
    _swap_connectors = {c for c in _BACKTEST_EXCLUDED_CONNECTORS if not c.startswith("hyperliquid")}
    if config.get("connector_name") in _swap_connectors:
        excluded = config["connector_name"]
        candles_conn = config.get("candles_connector") or config.get("candles_connector_name")
        candles_pair = config.get("candles_trading_pair")
        if candles_conn and candles_conn not in _BACKTEST_EXCLUDED_CONNECTORS:
            # Prefer the candles connector — it already has valid rules + a matching pair.
            new_conn, new_pair = candles_conn, candles_pair
        else:
            # Candles connector is ALSO excluded (e.g. both hyperliquid). Fall back to a
            # universally-available perp connector and convert the pair to its quote (USDT).
            new_conn = "binance_perpetual"
            tp = config.get("trading_pair", "")
            new_pair = (tp[:-4] + "-USDT") if tp.endswith("-USD") else (candles_pair or tp)
        st.info(
            f"`{excluded}` can't supply backtest trading rules (hummingbot engine "
            f"limitation), so this backtest uses `{new_conn}` ({new_pair}) rules instead. "
            f"Your saved/live config still trades on `{excluded}`."
        )
        config["connector_name"] = new_conn
        if new_pair:
            config["trading_pair"] = new_pair
    payload = {
        "start_time": start_time,
        "end_time": end_time,
        "backtesting_resolution": backtesting_resolution,
        "trade_cost": trade_cost,
        "config": config,
    }
    response = requests.post(
        f"{base_url}/backtesting/run",
        json=payload,
        auth=(BACKEND_API_USERNAME, BACKEND_API_PASSWORD),
        timeout=600,
    )
    response.raise_for_status()
    return response.json()


def backtesting_section(inputs, backend_api_client):
    st.write("### Backtesting")
    c1, c2, c3, c4, c5 = st.columns(5)
    default_end_time = datetime.now().date() - timedelta(days=1)
    default_start_time = default_end_time - timedelta(days=2)
    with c1:
        start_date = st.date_input("Start Date", default_start_time)
    with c2:
        end_date = st.date_input("End Date", default_end_time,
                                 help="End date is inclusive, make sure that you are not including the current date.")
    with c3:
        backtesting_resolution = st.selectbox("Backtesting Resolution",
                                              options=["1m", "3m", "5m", "15m", "30m", "1h", "1s"], index=0)
    with c4:
        trade_cost = st.number_input("Trade Cost (%)", min_value=0.0, value=0.06, step=0.01, format="%.2f")
    with c5:
        run_backtesting = st.button("Run Backtesting")

    if run_backtesting:
        start_datetime = datetime.combine(start_date, datetime.min.time())
        end_datetime = datetime.combine(end_date, datetime.max.time())
        try:
            backtesting_results = _run_backtesting_request(
                backend_api_client,
                start_time=int(start_datetime.timestamp()),
                end_time=int(end_datetime.timestamp()),
                backtesting_resolution=backtesting_resolution,
                trade_cost=trade_cost / 100,
                config=inputs,
            )
        except Exception as e:
            st.error(e)
            return None
        if isinstance(backtesting_results, dict) and backtesting_results.get("error"):
            st.error(f"Backtesting failed: {backtesting_results['error']}")
            return None
        if len(backtesting_results["processed_data"]) == 0:
            st.error("No trades were executed during the backtesting period.")
            return None
        if len(backtesting_results["executors"]) == 0:
            st.error("No executors were found during the backtesting period.")
            return None
        return backtesting_results
