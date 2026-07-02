"""my-trading patch: persistent per-market candle store (CSV database).

One CSV per (connector, trading_pair, interval) under CANDLE_CACHE_DIR, plus a
sidecar .meta.json recording which [start, end] spans have already been fetched
from the exchange. Any consumer (backtests, the optimizer, chart endpoints)
asks for a range; only the MISSING gaps are fetched upstream, merged in and
persisted — so a given candle is downloaded from Hyperliquid exactly once,
ever. The directory lives inside the bind-mounted ./bots, so the database
survives container redeploys and can be inspected/copied as plain CSV.

Span bookkeeping (not just "which rows exist") matters because HIP-3 markets
(silver/SP500) have genuine no-trading gaps: absent rows there are NOT missing
data, and refetching them forever would defeat the cache.

Concurrency: the API is a single uvicorn worker, so read-merge-write is done
synchronously (no awaits inside) making it atomic per event loop; writes use
tmp + os.replace so a concurrent reader never sees a partial file.
"""
import json
import logging
import os
import re
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

import pandas as pd

logger = logging.getLogger(__name__)

CACHE_DIR = os.environ.get("CANDLE_CACHE_DIR", "/hummingbot-api/bots/.candle_cache")

Span = Tuple[int, int]

# In-process cache of loaded CSVs keyed by slug, invalidated by file mtime —
# optimizer runs hit the same file hundreds of times per minute.
_df_cache: Dict[str, Tuple[float, pd.DataFrame]] = {}


def slug(connector: str, trading_pair: str, interval: str) -> str:
    safe_pair = re.sub(r"[^A-Za-z0-9._-]", "-", trading_pair)
    return f"{connector}__{safe_pair}__{interval}"


def csv_path(s: str) -> str:
    return os.path.join(CACHE_DIR, f"{s}.csv")


def meta_path(s: str) -> str:
    return os.path.join(CACHE_DIR, f"{s}.meta.json")


def _atomic_write(path: str, write_fn) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    write_fn(tmp)
    os.replace(tmp, path)


def merge_spans(spans: List[Span]) -> List[Span]:
    out: List[Span] = []
    for a, b in sorted((int(a), int(b)) for a, b in spans if b > a):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def load_meta(s: str) -> dict:
    try:
        with open(meta_path(s)) as f:
            m = json.load(f)
        m["spans"] = merge_spans([tuple(x) for x in m.get("spans", [])])
        return m
    except Exception:
        return {"spans": []}


def load_df(s: str) -> pd.DataFrame:
    path = csv_path(s)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return pd.DataFrame()
    hit = _df_cache.get(s)
    if hit is not None and hit[0] == mtime:
        return hit[1]
    try:
        df = pd.read_csv(path)
        df = df.sort_values("timestamp").reset_index(drop=True)
        _df_cache[s] = (mtime, df)
        return df
    except Exception as e:
        logger.warning(f"candle_store: failed reading {path}: {e}")
        return pd.DataFrame()


def missing_gaps(s: str, start: int, end: int) -> List[Span]:
    """Sub-ranges of [start, end] not yet covered by any fetched span."""
    gaps: List[Span] = []
    cursor = int(start)
    for a, b in load_meta(s)["spans"]:
        if b <= cursor:
            continue
        if a >= end:
            break
        if a > cursor:
            gaps.append((cursor, min(a, int(end))))
        cursor = max(cursor, b)
        if cursor >= end:
            break
    if cursor < end:
        gaps.append((cursor, int(end)))
    return gaps


def add(connector: str, trading_pair: str, interval: str,
        df: Optional[pd.DataFrame], covered: Span) -> None:
    """Merge fetched rows into the CSV and record the span as covered.

    Call with an empty df + covered span for ranges the exchange confirmed hold
    no bars (market closed) so they aren't refetched.
    """
    s = slug(connector, trading_pair, interval)
    existing = load_df(s)
    if df is not None and not df.empty:
        df = df.copy()
        df["timestamp"] = df["timestamp"].astype("int64")
        merged = pd.concat([existing, df], ignore_index=True) if not existing.empty else df
        merged = (merged.drop_duplicates(subset="timestamp", keep="last")
                        .sort_values("timestamp").reset_index(drop=True))
    else:
        merged = existing
    meta = load_meta(s)
    meta["spans"] = merge_spans(meta["spans"] + [covered])
    meta.update({"connector": connector, "trading_pair": trading_pair, "interval": interval})
    if not merged.empty:
        _atomic_write(csv_path(s), lambda tmp: merged.to_csv(tmp, index=False))
        try:
            _df_cache[s] = (os.path.getmtime(csv_path(s)), merged)
        except OSError:
            pass
    _atomic_write(meta_path(s), lambda tmp: open(tmp, "w").write(json.dumps(meta)))


def read_range(connector: str, trading_pair: str, interval: str,
               start: int, end: int) -> pd.DataFrame:
    df = load_df(slug(connector, trading_pair, interval))
    if df.empty:
        return df
    return df[(df["timestamp"] >= start) & (df["timestamp"] <= end)].reset_index(drop=True)


async def get_or_fetch(connector: str, trading_pair: str, interval: str,
                       start: int, end: int,
                       fetcher: Callable[[int, int], Awaitable[Optional[pd.DataFrame]]],
                       ) -> Tuple[pd.DataFrame, dict]:
    """Return candles for [start, end], fetching only the uncovered gaps.

    fetcher(gap_start, gap_end) -> df; None means the fetch FAILED (don't mark
    covered). A non-empty df marks the whole gap covered (the exchange returned
    what it has). An empty df is ambiguous (throttle vs genuinely no bars), so
    the gap is NOT marked and will be retried on the next request.
    """
    s = slug(connector, trading_pair, interval)
    gaps = missing_gaps(s, start, end)
    fetched: List[dict] = []
    for gs, ge in gaps:
        try:
            df = await fetcher(gs, ge)
        except Exception as e:
            logger.warning(f"candle_store: fetch failed for {s} [{gs},{ge}]: {e}")
            df = None
        if df is not None and not df.empty:
            add(connector, trading_pair, interval, df, (gs, ge))
            fetched.append({"start": gs, "end": ge, "rows": int(len(df))})
        else:
            fetched.append({"start": gs, "end": ge, "rows": 0,
                            "error": "no data returned (throttled or empty market)"})
    out = read_range(connector, trading_pair, interval, start, end)
    info = {"gaps_fetched": fetched, "from_cache": len(gaps) == 0, "rows": int(len(out))}
    if gaps:
        logger.info(f"candle_store: {s} filled {len(gaps)} gap(s): {fetched}")
    else:
        logger.info(f"candle_store: {s} full cache hit [{start},{end}] ({len(out)} rows)")
    return out, info


def inventory() -> List[dict]:
    entries: List[dict] = []
    try:
        names = sorted(os.listdir(CACHE_DIR))
    except OSError:
        return entries
    for name in names:
        if not name.endswith(".meta.json"):
            continue
        s = name[: -len(".meta.json")]
        meta = load_meta(s)
        df = load_df(s)
        try:
            size = os.path.getsize(csv_path(s))
        except OSError:
            size = 0
        entries.append({
            "slug": s,
            "connector": meta.get("connector"),
            "trading_pair": meta.get("trading_pair"),
            "interval": meta.get("interval"),
            "rows": int(len(df)),
            "first_timestamp": int(df["timestamp"].min()) if not df.empty else None,
            "last_timestamp": int(df["timestamp"].max()) if not df.empty else None,
            "spans": [list(x) for x in meta["spans"]],
            "size_bytes": size,
        })
    return entries


def delete(connector: str, trading_pair: str, interval: str) -> bool:
    s = slug(connector, trading_pair, interval)
    _df_cache.pop(s, None)
    found = False
    for p in (csv_path(s), meta_path(s)):
        if os.path.exists(p):
            os.remove(p)
            found = True
    return found
