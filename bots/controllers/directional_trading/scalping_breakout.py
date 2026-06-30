"""Scalping — Breakout: range-consolidation breakout on high volume.

Directional controller. Tracks a rolling resistance/support channel and fires
when price breaks out of it on above-average volume. Exits are handled by the
PositionExecutor via the base config (stop-loss / take-profit / trailing-stop /
time-limit set in the dashboard).

Signal:
  * resistance = highest high of the last `range_lookback` bars (excluding current)
  * support    = lowest low  of the last `range_lookback` bars (excluding current)
  * LONG  (1)  when close > resistance AND volume > mult x average.
  * SHORT (-1) when close < support    AND volume > mult x average.
  * else FLAT (0).

Which candle the signal is read from is controlled by `signal_candle_offset`:
  * 0 (default) = the LIVE, still-forming candle -> enters intra-bar the instant
    price crosses (maximum responsiveness, but repaints vs a closed-bar backtest;
    a bar can poke past the level and close back inside -> live-only fake-outs).
  * 1 = the last FULLY CLOSED candle -> enters at the next tick after a confirmed
    breakout close. This is what a closed-bar backtest simulates, so live lines
    up with the backtest. No repaint, fewer/later trades.
  * N = N bars back (further delay; rarely needed).
"""
import math
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_core.core_schema import ValidationInfo

from hummingbot.data_feed.candles_feed.data_types import CandlesConfig
from hummingbot.strategy_v2.controllers.directional_trading_controller_base import (
    DirectionalTradingControllerBase,
    DirectionalTradingControllerConfigBase,
)


def _safe_float(v) -> Optional[float]:
    """Coerce to float, returning None for NaN/inf/garbage so the value is JSON-safe."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


class ScalpingBreakoutConfig(DirectionalTradingControllerConfigBase):
    controller_name: str = "scalping_breakout"
    candles_connector: str = Field(
        default=None,
        json_schema_extra={
            "prompt": "Candles connector (leave empty to reuse the trading connector): ",
            "prompt_on_new": True,
        },
    )
    candles_trading_pair: str = Field(
        default=None,
        json_schema_extra={
            "prompt": "Candles trading pair (leave empty to reuse the trading pair): ",
            "prompt_on_new": True,
        },
    )
    interval: str = Field(
        default="1m",
        json_schema_extra={"prompt": "Candle interval (e.g. 1m, 5m): ", "prompt_on_new": True},
    )
    range_lookback: int = Field(
        default=20,
        json_schema_extra={
            "prompt": "Bars used to define the resistance/support channel: ",
            "prompt_on_new": True,
            "is_updatable": True,
        },
    )
    vol_lookback: int = Field(default=20, json_schema_extra={"is_updatable": True})
    rel_volume_mult: float = Field(
        default=2.0,
        json_schema_extra={
            "prompt": "Require volume > this multiple of the average (2.0 = 200%): ",
            "prompt_on_new": True,
            "is_updatable": True,
        },
    )
    signal_candle_offset: int = Field(
        default=0,
        json_schema_extra={
            "prompt": "Signal candle offset (0 = live/forming candle, 1 = last CLOSED candle): ",
            "prompt_on_new": True,
            "is_updatable": True,
        },
    )

    @field_validator("signal_candle_offset", mode="before")
    @classmethod
    def _validate_offset(cls, v):
        v = 0 if v is None else int(v)
        if v < 0:
            raise ValueError("signal_candle_offset must be >= 0")
        return v

    @field_validator("candles_connector", mode="before")
    @classmethod
    def set_candles_connector(cls, v, validation_info: ValidationInfo):
        return v or validation_info.data.get("connector_name")

    @field_validator("candles_trading_pair", mode="before")
    @classmethod
    def set_candles_trading_pair(cls, v, validation_info: ValidationInfo):
        return v or validation_info.data.get("trading_pair")


class ScalpingBreakoutController(DirectionalTradingControllerBase):
    def __init__(self, config: ScalpingBreakoutConfig, *args, **kwargs):
        self.config = config
        self.max_records = max(config.range_lookback, config.vol_lookback) + 20 + config.signal_candle_offset
        super().__init__(config, *args, **kwargs)

    def get_candles_config(self) -> List[CandlesConfig]:
        return [
            CandlesConfig(
                connector=self.config.candles_connector,
                trading_pair=self.config.candles_trading_pair,
                interval=self.config.interval,
                max_records=self.max_records,
            )
        ]

    async def update_processed_data(self):
        c = self.config
        df = self.market_data_provider.get_candles_df(
            connector_name=c.candles_connector,
            trading_pair=c.candles_trading_pair,
            interval=c.interval,
            max_records=self.max_records,
        )

        # .shift(1) so the current bar can't define its own breakout level.
        df["resistance"] = df["high"].rolling(c.range_lookback).max().shift(1)
        df["support"] = df["low"].rolling(c.range_lookback).min().shift(1)
        df["rel_vol"] = df["volume"] / df["volume"].rolling(c.vol_lookback).mean()

        high_vol = df["rel_vol"] > c.rel_volume_mult
        long_condition = (df["close"] > df["resistance"]) & high_vol
        short_condition = (df["close"] < df["support"]) & high_vol

        df["signal"] = 0
        df.loc[long_condition, "signal"] = 1
        df.loc[short_condition, "signal"] = -1

        # offset 0 = forming candle (iloc[-1]); 1 = last closed candle (iloc[-2]); N = N bars back.
        idx = -1 - self.config.signal_candle_offset
        self.processed_data["signal"] = int(df["signal"].iloc[idx]) if len(df) >= abs(idx) else 0
        self.processed_data["features"] = df

    def get_custom_info(self) -> dict:
        """Expose the latest per-tick decision so the dashboard can watch the bot
        think in real time. Published every tick via v2_with_controllers' performance
        report. Purely additive and fully guarded — never raises into the trading loop.
        """
        info: dict = {}
        try:
            base = super().get_custom_info()
            if isinstance(base, dict):
                info.update(base)
        except Exception:
            pass
        try:
            df = self.processed_data.get("features")
            if df is not None and len(df) > 0:
                idx = -1 - self.config.signal_candle_offset
                row = df.iloc[idx] if len(df) >= abs(idx) else df.iloc[-1]
                info.update({
                    "signal": int(self.processed_data.get("signal", 0)),
                    "close": _safe_float(row.get("close")),
                    "resistance": _safe_float(row.get("resistance")),
                    "support": _safe_float(row.get("support")),
                    "rel_vol": _safe_float(row.get("rel_vol")),
                    "rel_volume_mult": _safe_float(self.config.rel_volume_mult),
                    "signal_candle_offset": int(self.config.signal_candle_offset),
                    "ts": _safe_float(row.get("timestamp")),
                })
        except Exception:
            pass
        return info
