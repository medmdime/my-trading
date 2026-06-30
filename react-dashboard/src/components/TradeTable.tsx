import { cleanCloseType, fmtNum, fmtTs, fmtUsd, pnlColor } from "@/lib/format"
import { summarize, type Trade } from "@/lib/trades"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function TradeSummaryCards({ trades }: { trades: Trade[] }) {
  const s = summarize(trades)
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
      <Metric label="Trades" value={String(s.count)} />
      <Metric label="Win rate" value={`${fmtNum(s.winRate, 1)}%`} />
      <Metric label="Net PnL" value={fmtUsd(s.netPnl)} valueClass={pnlColor(s.netPnl)} />
      <Metric label="Fees" value={fmtUsd(s.fees)} />
      <Metric label="Volume" value={fmtUsd(s.volume)} />
      <div className="col-span-2 sm:col-span-4 lg:col-span-5">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(s.closeTypeCounts).map(([k, v]) => (
            <Badge key={k} variant="secondary" className="text-[11px]">
              {cleanCloseType(k)}: {v}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-0.5 text-lg font-semibold tabular-nums ${valueClass ?? ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

export function TradeRows({
  trades,
  onSelect,
  selectedId,
}: {
  trades: Trade[]
  onSelect?: (t: Trade) => void
  selectedId?: string
}) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-background">
          <TableRow>
            <TableHead>Side</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Exit</TableHead>
            <TableHead>Close</TableHead>
            <TableHead className="text-right">PnL %</TableHead>
            <TableHead className="text-right">PnL $</TableHead>
            <TableHead>Opened</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => (
            <TableRow
              key={t.id}
              onClick={() => onSelect?.(t)}
              data-selected={t.id === selectedId}
              className={
                onSelect
                  ? "cursor-pointer data-[selected=true]:bg-muted"
                  : undefined
              }
            >
              <TableCell>
                <Badge
                  className={
                    t.side === "LONG"
                      ? "bg-emerald-600 text-white"
                      : "bg-red-600 text-white"
                  }
                >
                  {t.side}
                </Badge>
              </TableCell>
              <TableCell className="tabular-nums">{fmtNum(t.entry, 4)}</TableCell>
              <TableCell className="tabular-nums">{fmtNum(t.exit, 4)}</TableCell>
              <TableCell className="text-xs">{cleanCloseType(t.closeType)}</TableCell>
              <TableCell className={`text-right tabular-nums ${pnlColor(t.netPnlQuote)}`}>
                {fmtNum(t.netPnlPct * 100, 2)}%
              </TableCell>
              <TableCell className={`text-right tabular-nums ${pnlColor(t.netPnlQuote)}`}>
                {fmtNum(t.netPnlQuote, 4)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{fmtTs(t.ts)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
