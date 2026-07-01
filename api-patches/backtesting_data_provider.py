import asyncio
import hashlib
import json
import logging
import os
from decimal import Decimal
from typing import Dict, Optional

import pandas as pd

from hummingbot.client.config.config_helpers import get_connector_class
from hummingbot.client.settings import AllConnectorSettings, ConnectorType
from hummingbot.connector.connector_base import ConnectorBase
from hummingbot.connector.trading_rule import TradingRule
from hummingbot.core.data_type.common import LazyDict, PriceType
from hummingbot.data_feed.candles_feed.candles_base import CandlesBase
from hummingbot.data_feed.candles_feed.candles_factory import CandlesFactory
from hummingbot.data_feed.candles_feed.data_types import CandlesConfig, HistoricalCandlesConfig
from hummingbot.data_feed.market_data_provider import MarketDataProvider

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- PATCH (my-trading) --------------------------------------------------------
# Hummingbot excludes hyperliquid (and a few others) from backtesting because the
# engine can't build the connector to fetch trading rules in the backtest sandbox
# -> initialize_trading_rules() crashed with
#   "'NoneType' object has no attribute '_update_trading_rules'".
# That blocked backtesting the Hyperliquid HIP-3 builder-dex markets
# (XYZ:SP500-USD, XYZ:SILVER-USD, XYZ:XYZ100-USD) entirely, even though the
# Hyperliquid candles feed already supports them.
#
# Candle data is NOT the blocker (get_candles_feed uses CandlesFactory directly,
# which works for HL/HIP-3) - only trading-rules sourcing is. So instead of
# touching EXCLUDED_CONNECTORS or the candles path, we inject trading rules for
# excluded connectors from a static snapshot of the live API
# (GET /connectors/<name>/trading-rules), baked into the image.
_HL_RULES_PATH = os.environ.get("HL_TRADING_RULES_PATH", "/opt/seed-bots/hl_trading_rules.json")
_CACHED_RULES_RAW: Optional[Dict[str, dict]] = None
# Numeric TradingRule fields that must be coerced to Decimal.
_RULE_DECIMAL_FIELDS = (
    "min_order_size", "max_order_size", "min_price_increment",
    "min_base_amount_increment", "min_quote_amount_increment",
    "min_notional_size", "min_order_value", "max_price_significant_digits",
)


def _load_cached_rules_raw() -> Dict[str, dict]:
    global _CACHED_RULES_RAW
    if _CACHED_RULES_RAW is None:
        try:
            with open(_HL_RULES_PATH) as f:
                _CACHED_RULES_RAW = json.load(f)
        except Exception as e:  # pragma: no cover - defensive
            logger.error(f"Could not load cached trading rules from {_HL_RULES_PATH}: {e}")
            _CACHED_RULES_RAW = {}
    return _CACHED_RULES_RAW


def _build_trading_rules_from_cache(connector_name: str) -> Dict[str, TradingRule]:
    """Build {trading_pair: TradingRule} from the cached snapshot for an excluded connector."""
    raw = _load_cached_rules_raw()
    rules: Dict[str, TradingRule] = {}
    for pair, fields in raw.items():
        kwargs = {}
        for k, v in fields.items():
            kwargs[k] = Decimal(str(v)) if k in _RULE_DECIMAL_FIELDS else v
        rules[pair] = TradingRule(trading_pair=pair, **kwargs)
    if not rules:
        logger.warning(f"No cached trading rules available for excluded connector '{connector_name}'.")
    return rules


# --- PATCH (my-trading): persistent candle cache -------------------------------
# Hyperliquid's public candle endpoint is IP-weight rate-limited (HTTP 429) and
# that limit is SHARED with the live bots' connector on the same server IP, so a
# burst of backtests can starve live trading. We cache each fetched window to
# disk keyed by (connector, pair, interval, window) so a given window is pulled
# from Hyperliquid exactly once and then reused forever — the Compare view (which
# re-runs the SAME window) and repeated backtests then cost ZERO HL requests.
_CANDLE_CACHE_DIR = os.environ.get("CANDLE_CACHE_DIR", "/hummingbot-api/bots/.candle_cache")


def _candle_cache_path(connector: str, trading_pair: str, interval: str, start, end) -> str:
    key = f"{connector}|{trading_pair}|{interval}|{int(start)}|{int(end)}"
    digest = hashlib.md5(key.encode()).hexdigest()[:16]
    safe_pair = trading_pair.replace("/", "-").replace(":", "-")
    return os.path.join(_CANDLE_CACHE_DIR, f"{connector}_{safe_pair}_{interval}_{digest}.pkl")


def _read_candle_cache(path: str):
    try:
        if os.path.exists(path):
            df = pd.read_pickle(path)
            if df is not None and not df.empty:
                logger.info(f"Candle cache HIT: {path} ({len(df)} rows)")
                return df
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"Candle cache read failed ({path}): {e}")
    return None


def _write_candle_cache(path: str, df) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Atomic write: parallel backtests may race on the same window; a partial
        # pickle must never be visible to a concurrent reader.
        tmp = f"{path}.tmp.{os.getpid()}"
        df.to_pickle(tmp)
        os.replace(tmp, path)
        logger.info(f"Candle cache WRITE: {path} ({len(df)} rows)")
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"Candle cache write failed ({path}): {e}")
# --- END PATCH -----------------------------------------------------------------


class BacktestingDataProvider(MarketDataProvider):
    CONNECTOR_TYPES = [ConnectorType.CLOB_SPOT, ConnectorType.CLOB_PERP, ConnectorType.Exchange,
                       ConnectorType.Derivative]
    EXCLUDED_CONNECTORS = ["hyperliquid_perpetual", "dydx_perpetual", "cube", "vertex",
                           "coinbase_advanced_trade", "kraken", "dydx_v4_perpetual", "hitbtc",
                           "hyperliquid", "injective_v2_perpetual", "injective_v2"]

    def __init__(self, connectors: Dict[str, ConnectorBase]):
        super().__init__(connectors)
        self.start_time = None
        self.end_time = None
        self.prices = {}
        self._time = None
        self.trading_rules = {}
        self.conn_settings = AllConnectorSettings.get_connector_settings()
        self.connectors = LazyDict[str, Optional[ConnectorBase]](
            lambda name: self.get_connector(name) if (
                self.conn_settings[name].type in self.CONNECTOR_TYPES and
                name not in self.EXCLUDED_CONNECTORS and
                "testnet" not in name
            ) else None
        )

    def get_connector(self, connector_name: str):
        conn_setting = self.conn_settings.get(connector_name)
        if conn_setting is None:
            logger.error(f"Connector {connector_name} not found")
            raise ValueError(f"Connector {connector_name} not found")

        init_params = conn_setting.conn_init_parameters(
            trading_pairs=[],
            trading_required=False,
            api_keys=MarketDataProvider.get_connector_config_map(connector_name),
        )
        connector_class = get_connector_class(connector_name)
        connector = connector_class(**init_params)
        return connector

    def get_trading_rules(self, connector_name: str, trading_pair: str):
        """
        Retrieves the trading rules from the specified connector.
        :param connector_name: str
        :return: Trading rules.
        """
        return self.trading_rules[connector_name][trading_pair]

    def time(self):
        return self._time

    async def initialize_trading_rules(self, connector_name: str):
        if len(self.trading_rules.get(connector_name, {})) == 0:
            connector = self.connectors.get(connector_name)
            # --- PATCH (my-trading) ---
            # Excluded connectors (e.g. hyperliquid_perpetual) resolve to None.
            # Instead of crashing, inject trading rules from the cached snapshot.
            if connector is None:
                self.trading_rules[connector_name] = _build_trading_rules_from_cache(connector_name)
                return
            # --- END PATCH ---
            await connector._update_trading_rules()
            self.trading_rules[connector_name] = connector.trading_rules

    async def initialize_candles_feed(self, config: CandlesConfig):
        await self.get_candles_feed(config)

    def update_backtesting_time(self, start_time: int, end_time: int):
        self.start_time = start_time
        self.end_time = end_time
        self._time = start_time

    async def get_candles_feed(self, config: CandlesConfig):
        """
        Retrieves or creates and starts a candle feed based on the given configuration.
        If an existing feed has a higher or equal max_records, it is reused.
        :param config: CandlesConfig
        :return: Candle feed instance.
        """
        key = self._generate_candle_feed_key(config)
        existing_feed = self.candles_feeds.get(key, pd.DataFrame())
        # existing_feed = self.ensure_epoch_index(existing_feed)

        if not existing_feed.empty:
            existing_feed_start_time = existing_feed["timestamp"].min()
            existing_feed_end_time = existing_feed["timestamp"].max()
            if existing_feed_start_time <= self.start_time and existing_feed_end_time >= self.end_time:
                return existing_feed
        # Create a new feed or restart the existing one with updated max_records
        candle_feed = CandlesFactory.get_candle(config)
        # --- PATCH (my-trading): persistent candle cache (wire-up) ---
        # Normalize the fetch window so EVERY config over the same backtest window
        # shares one cache entry: the warmup buffer depends on max_records (which
        # varies per optimizer candidate via the lookbacks), so we fetch a fixed
        # generous buffer and round the bounds — otherwise each candidate would
        # get its own cache key and still hammer Hyperliquid.
        interval_secs = CandlesBase.interval_to_seconds[config.interval]
        buffer_secs = max(config.max_records, 500) * interval_secs
        fetch_start = int((self.start_time - buffer_secs) // 86400 * 86400)
        fetch_end = int(-(-self.end_time // interval_secs) * interval_secs)
        cache_path = _candle_cache_path(
            config.connector, config.trading_pair, config.interval, fetch_start, fetch_end
        )
        cached_df = _read_candle_cache(cache_path)
        if cached_df is not None:
            self.candles_feeds[key] = cached_df
            return cached_df
        hist_config = HistoricalCandlesConfig(
            connector_name=config.connector,
            trading_pair=config.trading_pair,
            interval=config.interval,
            start_time=fetch_start,
            end_time=fetch_end,
        )
        # --- PATCH (my-trading) ---
        # Hyperliquid's public candle endpoint intermittently returns an EMPTY
        # snapshot when called repeatedly (IP weight-based rate limiting). The
        # backtest engine then runs over zero candles and silently produces 0
        # trades -> the dashboard reports "no trades in this window" and the
        # Compare-vs-Live view has nothing to compare even though the strategy
        # would have traded. Empty candles are a TRANSIENT data failure, not a
        # real "no signal" result, so retry with backoff until we get data.
        candles_df = await candle_feed.get_historical_candles(config=hist_config)
        attempts = int(os.environ.get("BACKTEST_CANDLE_RETRIES", "5"))
        delay = 1.5
        for attempt in range(attempts):
            if candles_df is not None and not candles_df.empty:
                break
            logger.warning(
                f"Empty candles for {config.connector} {config.trading_pair} "
                f"{config.interval} (attempt {attempt + 1}/{attempts}); "
                f"Hyperliquid likely throttling — retrying in {delay:.1f}s"
            )
            await asyncio.sleep(delay)
            delay = min(delay * 1.6, 8.0)
            candles_df = await candle_feed.get_historical_candles(config=hist_config)
        if candles_df is None or candles_df.empty:
            logger.error(
                f"Still no candles for {config.connector} {config.trading_pair} "
                f"{config.interval} after {attempts} attempts — backtest will be empty."
            )
        else:
            # Persist so this window is fetched from Hyperliquid exactly once.
            _write_candle_cache(cache_path, candles_df)
        # --- END PATCH ---
        # TODO: fix pandas-ta improper float index slicing to allow us to use float indexes
        # candles_df = self.ensure_epoch_index(candles_df)
        self.candles_feeds[key] = candles_df
        return candles_df

    def get_candles_df(self, connector_name: str, trading_pair: str, interval: str, max_records: int = 500):
        """
        Retrieves the candles for a trading pair from the specified connector.
        :param connector_name: str
        :param trading_pair: str
        :param interval: str
        :param max_records: int
        :return: Candles dataframe.
        """
        candles_df = self.candles_feeds.get(f"{connector_name}_{trading_pair}_{interval}")
        return candles_df[(candles_df["timestamp"] >= self.start_time) & (candles_df["timestamp"] <= self.end_time)]

    def get_price_by_type(self, connector_name: str, trading_pair: str, price_type: PriceType):
        """
        Retrieves the price for a trading pair from the specified connector based on the price type.
        :param connector_name: str
        :param trading_pair: str
        :param price_type: PriceType
        :return: Price.
        """
        return self.prices.get(f"{connector_name}_{trading_pair}", Decimal("1"))

    def quantize_order_amount(self, connector_name: str, trading_pair: str, amount: Decimal):
        """
        Quantizes the order amount based on the trading pair's minimum order size.
        :param connector_name: str
        :param trading_pair: str
        :param amount: Decimal
        :return: Quantized amount.
        """
        trading_rules = self.get_trading_rules(connector_name, trading_pair)
        order_size_quantum = trading_rules.min_base_amount_increment
        return (amount // order_size_quantum) * order_size_quantum

    def quantize_order_price(self, connector_name: str, trading_pair: str, price: Decimal):
        """
        Quantizes the order price based on the trading pair's minimum price increment.
        :param connector_name: str
        :param trading_pair: str
        :param price: Decimal
        :return: Quantized price.
        """
        trading_rules = self.get_trading_rules(connector_name, trading_pair)
        price_quantum = trading_rules.min_price_increment
        return (price // price_quantum) * price_quantum

    # TODO: enable copy-on-write and allow specification of inplace
    @staticmethod
    def ensure_epoch_index(df: pd.DataFrame, timestamp_column: str = "timestamp",
                           keep_original: bool = True, index_name: str = "epoch_seconds") -> pd.DataFrame:
        """Ensures DataFrame has numeric monotonic increasing timestamp index in seconds since epoch."""
        # Skip if already numeric index but not RangeIndex as that generally means the index was dropped
        if df.index.name == index_name or df.empty:
            return df

        # DatetimeIndex → convert to seconds
        if isinstance(df.index, pd.DatetimeIndex):
            df.index = df.index.map(pd.Timestamp.timestamp)
        # Has timestamp column → use as index
        elif timestamp_column in df.columns:
            df = df.set_index(timestamp_column, drop=not keep_original)
            # Convert non-numeric indices to seconds
            if not pd.api.types.is_numeric_dtype(df.index):
                df.index = pd.to_datetime(df.index).map(pd.Timestamp.timestamp)
        else:
            raise ValueError(f"Cannot create timestamp index: no '{timestamp_column}' column found and index isn't convertible")
        df.sort_index(inplace=True)
        df.index.name = index_name
        return df
