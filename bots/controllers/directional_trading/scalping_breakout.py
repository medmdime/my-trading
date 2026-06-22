"""Scalping — Breakout: range-consolidation breakout on high volume.

Directional controller. Tracks a rolling resistance/support channel and fires
when price breaks out of it on above-average volume. Exits are handled by the
PositionExecutor via the base config (stop-loss / take-profit / trailing-stop /
time-limit set in the dashboard).

Signal (latest closed candle):
  * resistance = highest high of the last `range_lookback` bars (excluding current)
  * support    = lowest low  of the last `range_lookback` bars (excluding current)
  * LONG  (1)  when close > resistance AND volume > mult x average.
  * SHORT (-1) when close < support    AND volume > mult x average.
  * else FLAT (0).
"""
from typing import List

from pydantic import Field, field_validator
from pydantic_core.core_schema import ValidationInfo

from hummingbot.data_feed.candles_feed.data_types import CandlesConfig
from hummingbot.strategy_v2.controllers.directional_trading_controller_base import (
    DirectionalTradingControllerBase,
    DirectionalTradingControllerConfigBase,
)


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
        self.max_records = max(config.range_lookback, config.vol_lookback) + 20
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

        self.processed_data["signal"] = int(df["signal"].iloc[-1])
        self.processed_data["features"] = df
