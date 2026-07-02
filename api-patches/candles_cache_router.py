"""my-trading patch: candle cache management + cached candle reads.

Copied into /hummingbot-api/routers/candles_cache.py by api.Dockerfile and
registered in main.py. Everything reads/writes the same per-market CSV store
the backtest engine uses (hummingbot.strategy_v2.backtesting.candle_store), so
charts, the optimizer and backtests all share one candle database and each
candle is fetched from the exchange exactly once.
"""
import asyncio
import logging
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from hummingbot.data_feed.candles_feed.candles_factory import CandlesFactory
from hummingbot.data_feed.candles_feed.data_types import CandlesConfig, HistoricalCandlesConfig
from hummingbot.strategy_v2.backtesting import candle_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/candles-cache", tags=["Candles Cache"])


class CacheRangeRequest(BaseModel):
    connector_name: str = "hyperliquid_perpetual"
    trading_pair: str
    interval: str = "1m"
    start_time: int
    end_time: int


async def _get_or_fetch(req: CacheRangeRequest):
    if req.connector_name not in CandlesFactory._candles_map:
        raise HTTPException(status_code=400, detail=f"Unsupported connector '{req.connector_name}'")
    if req.end_time <= req.start_time:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")

    feed = CandlesFactory.get_candle(CandlesConfig(
        connector=req.connector_name,
        trading_pair=req.trading_pair,
        interval=req.interval,
    ))

    async def _fetch_gap(gap_start: int, gap_end: int):
        hist = HistoricalCandlesConfig(
            connector_name=req.connector_name,
            trading_pair=req.trading_pair,
            interval=req.interval,
            start_time=gap_start,
            end_time=gap_end,
        )
        df = await feed.get_historical_candles(config=hist)
        attempts = int(os.environ.get("BACKTEST_CANDLE_RETRIES", "5"))
        delay = 1.5
        for _ in range(attempts):
            if df is not None and not df.empty:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 1.6, 8.0)
            df = await feed.get_historical_candles(config=hist)
        return df

    return await candle_store.get_or_fetch(
        req.connector_name, req.trading_pair, req.interval,
        int(req.start_time), int(req.end_time), _fetch_gap,
    )


@router.get("/")
async def list_cache():
    """Inventory of the candle database: one entry per market+interval."""
    return candle_store.inventory()


@router.post("/fill")
async def fill_cache(req: CacheRangeRequest):
    """Prefetch a range into the store (only missing gaps hit the exchange)."""
    _df, info = await _get_or_fetch(req)
    entry = next((e for e in candle_store.inventory()
                  if e["slug"] == candle_store.slug(req.connector_name, req.trading_pair, req.interval)),
                 None)
    return {**info, "entry": entry}


@router.post("/candles")
async def cached_candles(req: CacheRangeRequest):
    """Candles for a range, served from the store (gaps auto-filled).

    Same record shape as /market-data/historical-candles, but reads disk-first
    so it's fast, deterministic, and doesn't burn Hyperliquid rate limit.
    """
    df, _info = await _get_or_fetch(req)
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail="No candles available for this range")
    return df.to_dict(orient="records")


@router.delete("/{connector_name}/{trading_pair}/{interval}")
async def delete_cache(connector_name: str, trading_pair: str, interval: str):
    if not candle_store.delete(connector_name, trading_pair, interval):
        raise HTTPException(status_code=404, detail="No cache entry for that market")
    return {"deleted": True}


@router.get("/{connector_name}/{trading_pair}/{interval}/csv")
async def download_csv(connector_name: str, trading_pair: str, interval: str):
    s = candle_store.slug(connector_name, trading_pair, interval)
    path = candle_store.csv_path(s)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No cache entry for that market")
    return FileResponse(path, media_type="text/csv", filename=f"{s}.csv")
