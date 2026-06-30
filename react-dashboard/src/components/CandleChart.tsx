import * as React from "react"
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"

export interface Candle {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
}

export interface OverlayLine {
  key: string
  color: string
  data: Array<{ time: number; value: number }>
}

interface CandleChartProps {
  candles: Candle[]
  lines?: OverlayLine[]
  markers?: Array<SeriesMarker<Time>>
  height?: number
}

const toCandle = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
})

/** TradingView lightweight-charts wrapper: candles + optional overlay lines + markers. */
export function CandleChart({ candles, lines = [], markers, height = 420 }: CandleChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const chartRef = React.useRef<IChartApi | null>(null)
  const candleRef = React.useRef<ISeriesApi<"Candlestick"> | null>(null)
  const lineRefs = React.useRef<Map<string, ISeriesApi<"Line">>>(new Map())
  const markersRef = React.useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null)

  // Create chart once.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const styles = getComputedStyle(document.documentElement)
    const isDark = document.documentElement.classList.contains("dark")
    const textColor = isDark ? "#a1a1aa" : "#52525b"
    const gridColor = isDark ? "rgba(82,82,91,0.18)" : "rgba(82,82,91,0.12)"

    const chart = createChart(el, {
      height,
      layout: {
        background: { color: "transparent" },
        textColor,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      rightPriceScale: { borderColor: gridColor },
      timeScale: { borderColor: gridColor, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    void styles

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    })

    chartRef.current = chart
    candleRef.current = candleSeries

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) chart.applyOptions({ width: Math.floor(w) })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      lineRefs.current.clear()
      markersRef.current = null
    }
  }, [height])

  // Update candle data.
  React.useEffect(() => {
    candleRef.current?.setData(candles.map(toCandle))
    if (candles.length) chartRef.current?.timeScale().fitContent()
  }, [candles])

  // Update overlay lines (create/update/remove as the set changes).
  React.useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const seen = new Set<string>()
    for (const line of lines) {
      seen.add(line.key)
      let series = lineRefs.current.get(line.key)
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: line.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        lineRefs.current.set(line.key, series)
      }
      series.setData(
        line.data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value }) as LineData<UTCTimestamp>),
      )
    }
    // Drop lines no longer present.
    for (const [key, series] of lineRefs.current) {
      if (!seen.has(key)) {
        chart.removeSeries(series)
        lineRefs.current.delete(key)
      }
    }
  }, [lines])

  // Update markers.
  React.useEffect(() => {
    const series = candleRef.current
    if (!series) return
    if (!markersRef.current) {
      markersRef.current = createSeriesMarkers(series, markers ?? [])
    } else {
      markersRef.current.setMarkers(markers ?? [])
    }
  }, [markers])

  return <div ref={containerRef} className="w-full" style={{ height }} />
}
