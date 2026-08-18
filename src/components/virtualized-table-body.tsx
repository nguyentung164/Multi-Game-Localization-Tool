import { useRef, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { TableBody, TableCell, TableRow } from "@/components/ui/table"

const VIRTUAL_ROW_THRESHOLD = 200
const DEFAULT_ROW_HEIGHT = 52

type VirtualizedTableBodyProps<T> = {
  rows: T[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  renderRow: (item: T, index: number) => ReactNode
  emptyRow?: ReactNode
  estimateSize?: number
  colSpan?: number
}

export function shouldVirtualizeTableRows(count: number): boolean {
  return count > VIRTUAL_ROW_THRESHOLD
}

export function useVirtualTableScrollRef() {
  return useRef<HTMLDivElement>(null)
}

export function VirtualizedTableBody<T>({
  rows,
  scrollRef,
  renderRow,
  emptyRow,
  estimateSize = DEFAULT_ROW_HEIGHT,
  colSpan = 4,
}: VirtualizedTableBodyProps<T>) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 10,
  })

  if (rows.length === 0) {
    return <TableBody>{emptyRow}</TableBody>
  }

  const virtualRows = virtualizer.getVirtualItems()
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0
  const paddingBottom =
    virtualRows.length > 0
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0

  return (
    <TableBody>
      {paddingTop > 0 ? (
        <TableRow aria-hidden className="pointer-events-none border-0 hover:bg-transparent">
          <TableCell colSpan={colSpan} style={{ height: paddingTop, padding: 0 }} />
        </TableRow>
      ) : null}
      {virtualRows.map((virtualRow) => {
        const item = rows[virtualRow.index]
        if (!item) return null
        return renderRow(item, virtualRow.index)
      })}
      {paddingBottom > 0 ? (
        <TableRow aria-hidden className="pointer-events-none border-0 hover:bg-transparent">
          <TableCell colSpan={colSpan} style={{ height: paddingBottom, padding: 0 }} />
        </TableRow>
      ) : null}
    </TableBody>
  )
}
