"""Scalping — Breakout (Filtered): the Scalping Breakout signal with optional
trend (Moving Average) and momentum (RSI) confirmation filters.

This is a SEPARATE controller from `scalping_breakout` — the original is left
untouched. The base breakout signal is identical; this version lets you require
the breakout to also agree with a moving-average trend and/or sit inside an RSI
band before a position is opened.

Base signal (same as scalping_breakout):
  * resistance = highest high of the last `range_lookback` bars (excluding current)
  * support    = lowest low  of the last `range_lookback` bars (excluding current)
  * LONG  (1)  when close > resistance AND volume > mult x average.
  * SHORT (-1) when close < support    AND volume > mult x average.

Optional TREND filter (`trend_filter_enabled`, OFF by default) — single MA gate:
  * ma = EMA or SMA of close over `trend_ma_length` (`trend_ma_type`).
  * LONG  kept only when close > ma (price in an up-trend).
  * SHORT kept only when close < ma (price in a down-trend).

Optional MOMENTUM filter (`rsi_filter_enabled`, OFF by default) — RSI band,
defaulted to "avoid exhaustion" so you don't chase over-extended breakouts:
  * rsi = Wilder RSI over `rsi_length`.
  * LONG  kept only when rsi < `rsi_overbought` (default 70) — skip overbought breakouts.
  * SHORT kept only when rsi > `rsi_oversold`  (default 30) — skip oversold breakdowns.
  (This is an upper bound on long entries / lower bound on short entries; tighten
  `rsi_overbought` toward 60 / raise `rsi_oversold` toward 40 to be more selective.)

Both filters are AND-combined with the base signal and with each other, so any
combination of {off, trend-only, rsi-only, both} is possible. With both filters
off this controller is byte-for-byte equivalent to scalping_breakout.

`signal_candle_offset` works exactly as in scalping_breakout:
  * 0 (default) = the LIVE, still-forming candle (repaints vs a closed-bar backtest);
  * 1 = the last FULLY CLOSED candle (lines up with the backtest, no repaint);
  * N = N bars back.
"""
from typing import List

import pandas as pd
from pydantic import Field, field_validator
from pydantic_core.core_schema import ValidationInfo

from hummingbot.data_feed.candles_feed.data_types import CandlesConfig
from hummingbot.strategy_v2.controllers.directional_trading_controller_base import (
    DirectionalTradingControllerBase,
    DirectionalTradingControllerConfigBase,
)


class ScalpingBreakoutFilteredConfig(DirectionalTradingControllerConfigBase):
    controller_name: str = "scalping_breakout_filtered"
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

    # --- Trend (Moving Average) filter ---
    trend_filter_enabled: bool = Field(
        default=False,
        json_schema_extra={
            "prompt": "Enable the moving-average trend filter? (True/False): ",
            "prompt_on_new": True,
            "is_updatable": True,
        },
    )
    trend_ma_type: str = Field(
        default="ema",
        json_schema_extra={"prompt": "Trend MA type (ema/sma): ", "is_updatable": True},
    )
    trend_ma_length: int = Field(
        default=50,
        json_schema_extra={"prompt": "Trend MA length (bars): ", "is_updatable": True},
    )

    # --- Momentum (RSI) filter ---
    rsi_filter_enabled: bool = Field(
        default=False,
        json_schema_extra={
            "prompt": "Enable the RSI momentum filter? (True/False): ",
            "prompt_on_new": True,
            "is_updatable": True,
        },
    )
    rsi_length: int = Field(
        default=14,
        json_schema_extra={"prompt": "RSI length (bars): ", "is_updatable": True},
    )
    rsi_overbought: float = Field(
        default=70.0,
        json_schema_extra={"prompt": "Block LONGs when RSI >= this (overbought): ", "is_updatable": True},
    )
    rsi_oversold: float = Field(
        default=30.0,
        json_schema_extra={"prompt": "Block SHORTs when RSI <= this (oversold): ", "is_updatable": True},
    )

    @field_validator("signal_candle_offset", "trend_ma_length", "rsi_length", mode="before")
    @classmethod
    def _coerce_int(cls, v):
        return 0 if v is None else int(v)

    @field_validator("signal_candle_offset")
    @classmethod
    def _check_offset(cls, v):
        if v < 0:
            raise ValueError("signal_candle_offset must be >= 0")
        return v

    @field_validator("trend_ma_length", "rsi_length")
    @classmethod
    def _check_positive(cls, v):
        if v < 1:
            raise ValueError("MA / RSI length must be >= 1")
        return v

    @field_validator("rsi_overbought", "rsi_oversold", mode="before")
    @classmethod
    def _coerce_float(cls, v):
        return float(v)

    @field_validator("trend_ma_type", mode="before")
    @classmethod
    def _check_ma_type(cls, v):
        v = (str(v) if v is not None else "ema").strip().lower()
        if v not in ("ema", "sma"):
            raise ValueError("trend_ma_type must be 'ema' or 'sma'")
        return v

    @field_validator("candles_connector", mode="before")
    @classmethod
    def set_candles_connector(cls, v, validation_info: ValidationInfo):
        return v or validation_info.data.get("connector_name")

    @field_validator("candles_trading_pair", mode="before")
    @classmethod
    def set_candles_trading_pair(cls, v, validation_info: ValidationInfo):
        return v or validation_info.data.get("trading_pair")


class ScalpingBreakoutFilteredController(DirectionalTradingControllerBase):
    def __init__(self, config: ScalpingBreakoutFilteredConfig, *args, **kwargs):
        self.config = config
        # Enough history for the channel/volume baselines AND the longest enabled
        # filter (RSI needs extra warm-up for Wilder smoothing to settle).
        needs = [config.range_lookback, config.vol_lookback]
        if config.trend_filter_enabled:
            needs.append(config.trend_ma_length)
        if config.rsi_filter_enabled:
            needs.append(config.rsi_length * 5)
        self.max_records = max(needs) + 20 + config.signal_candle_offset
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

    @staticmethod
    def _rsi(close: pd.Series, length: int) -> pd.Series:
        """Wilder's RSI."""
        delta = close.diff()
        gain = delta.clip(lower=0.0)
        loss = -delta.clip(upper=0.0)
        avg_gain = gain.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
        rs = avg_gain / avg_loss
        rsi = 100.0 - (100.0 / (1.0 + rs))
        # When there are no losses, RS -> inf -> RSI 100; clean up the resulting NaN.
        rsi = rsi.where(avg_loss != 0, 100.0)
        return rsi

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

        # --- optional trend (MA) filter ---
        if c.trend_filter_enabled:
            if c.trend_ma_type == "sma":
                df["trend_ma"] = df["close"].rolling(c.trend_ma_length).mean()
            else:
                df["trend_ma"] = df["close"].ewm(span=c.trend_ma_length, adjust=False).mean()
            long_condition &= df["close"] > df["trend_ma"]
            short_condition &= df["close"] < df["trend_ma"]

        # --- optional momentum (RSI) filter ---
        if c.rsi_filter_enabled:
            df["rsi"] = self._rsi(df["close"], c.rsi_length)
            long_condition &= df["rsi"] < c.rsi_overbought
            short_condition &= df["rsi"] > c.rsi_oversold

        df["signal"] = 0
        df.loc[long_condition, "signal"] = 1
        df.loc[short_condition, "signal"] = -1

        # offset 0 = forming candle (iloc[-1]); 1 = last closed candle (iloc[-2]); N = N bars back.
        idx = -1 - self.config.signal_candle_offset
        self.processed_data["signal"] = int(df["signal"].iloc[idx]) if len(df) >= abs(idx) else 0
        self.processed_data["features"] = df
