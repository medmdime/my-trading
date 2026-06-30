import * as React from "react"

import type { Candle } from "@/components/CandleChart"
import { useWsSubscription, type WsStatus } from "./ws"

interface RawCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Subscribe to a connector/pair/interval candle stream. The API pushes the full
 * candle snapshot each update_interval, so we just replace on every message.
 */
export function useLiveCandles(
  connector: string | null,
  tradingPair: string | null,
  interval: string | null,
  updateInterval = 1.0,
): { candles: Candle[]; status: WsStatus } {
  const [candles, setCandles] = React.useState<Candle[]>([])

  const subs = React.useMemo(() => {
    if (!connector || !tradingPair || !interval) return null
    return [
      {
        type: "candles",
        connector,
        trading_pair: tradingPair,
        interval,
        update_interval: updateInterval,
      },
    ]
  }, [connector, tradingPair, interval, updateInterval])

  // Reset when the target changes so we don't briefly show stale candles.
  React.useEffect(() => {
    setCandles([])
  }, [connector, tradingPair, interval])

  const status = useWsSubscription<RawCandle[]>("market-data", subs, (msg) => {
    if (msg.type !== "candles" || !Array.isArray(msg.data)) return
    setCandles(
      msg.data.map((c) => ({
        time: Math.floor(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    )
  })

  return { candles, status }
}
