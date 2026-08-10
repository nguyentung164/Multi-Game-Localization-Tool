import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export const DEFAULT_TABLE_PAGE_SIZE_OPTIONS = [25, 50, 100, 200, 500] as const
export const SYNC_TABLE_PAGE_SIZE_OPTIONS = [5, 10, 25, 50, 100] as const

function formatRange(page: number, pageSize: number, totalItems: number): string {
  if (totalItems === 0) return "0"
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, totalItems)
  return `${start.toLocaleString("vi-VN")}–${end.toLocaleString("vi-VN")} / ${totalItems.toLocaleString("vi-VN")}`
}

export function TablePaginator({
  page,
  totalPages,
  totalItems,
  pageSize,
  pageSizeOptions = DEFAULT_TABLE_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  summary,
  className,
  showFirstLast = true,
  pageSizeLabel = "dòng / trang",
}: {
  page: number
  totalPages: number
  totalItems: number
  pageSize: number
  pageSizeOptions?: readonly number[]
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  summary?: string
  className?: string
  showFirstLast?: boolean
  pageSizeLabel?: string
}) {
  if (totalItems === 0) return null

  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">Hiển thị</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value))}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">{pageSizeLabel}</span>
        <span className="text-muted-foreground hidden text-sm sm:inline">
          · {formatRange(page, pageSize, totalItems)}
        </span>
        {summary ? (
          <span className="text-muted-foreground hidden text-sm md:inline">
            · {summary}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm sm:hidden">
          {formatRange(page, pageSize, totalItems)}
        </span>
        {summary ? (
          <span className="text-muted-foreground text-sm md:hidden">{summary}</span>
        ) : null}
        <span className="text-sm tabular-nums">
          Trang {page} / {totalPages}
        </span>
        {showFirstLast ? (
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
            title="Trang đầu"
            aria-label="Trang đầu"
          >
            <ChevronsLeftIcon className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          title="Trang trước"
          aria-label="Trang trước"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          title="Trang sau"
          aria-label="Trang sau"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
        {showFirstLast ? (
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page >= totalPages}
            onClick={() => onPageChange(totalPages)}
            title="Trang cuối"
            aria-label="Trang cuối"
          >
            <ChevronsRightIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
