import { useMemo, useState } from "react"
import {
  ActivityIcon,
  AlertCircleIcon,
  BracesIcon,
  CheckCircle2Icon,
  ListFilterIcon,
  TerminalSquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { JobEventDetailDialog } from "@/components/job-event-detail-dialog"
import { formatNumber } from "@/components/product-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { EventLevel } from "@/lib/app-types"
import type { LegendConsoleEvent } from "@/lib/legend-console"
import { cn } from "@/lib/utils"

const eventIcons = {
  info: ActivityIcon,
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  error: AlertCircleIcon,
}

const eventLevelIconStyles: Record<EventLevel, string> = {
  info: "bg-surface-gradient text-info",
  success: "bg-surface-gradient text-success",
  warning: "bg-surface-gradient text-warning-foreground dark:text-warning",
  error: "bg-surface-gradient text-destructive",
}

const eventLevelCardStyles: Record<EventLevel, string> = {
  info: "border-info/35 bg-info/5",
  success: "border-success/35 bg-success/5",
  warning: "border-warning/35 bg-warning/5",
  error: "border-destructive/30 bg-destructive/5",
}

function LegendConsoleItem({ event }: { event: LegendConsoleEvent }) {
  const [detailOpen, setDetailOpen] = useState(false)
  const Icon = eventIcons[event.level]
  return (
    <div className="flex gap-2">
      <span
        className={cn(
          "relative mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          eventLevelIconStyles[event.level],
        )}
      >
        <Icon aria-hidden="true" className="size-3" />
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-md bg-card-surface p-2",
          eventLevelCardStyles[event.level],
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            <p className="text-xs font-medium leading-snug">{event.title}</p>
            {event.detail !== undefined && (
              <>
                <Button
                  className="h-6 shrink-0 px-1.5"
                  size="xs"
                  variant="ghost"
                  onClick={() => setDetailOpen(true)}
                >
                  <BracesIcon data-icon="inline-start" />
                  Chi tiết kỹ thuật
                </Button>
                {detailOpen && (
                  <JobEventDetailDialog
                    open={detailOpen}
                    onOpenChange={setDetailOpen}
                    title={event.title}
                    timestamp={event.timestamp}
                    detail={event.detail}
                  />
                )}
              </>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {event.timestamp}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {event.description || "Không có mô tả chi tiết."}
        </p>
      </div>
    </div>
  )
}

export function LegendJobConsole({
  events,
  onClear,
}: {
  events: LegendConsoleEvent[]
  onClear: () => void
}) {
  const [level, setLevel] = useState<EventLevel | "all">("all")
  const filteredEvents = useMemo(
    () => events.filter((event) => level === "all" || event.level === level),
    [events, level],
  )
  const errorCount = events.filter((event) => event.level === "error").length
  const warningCount = events.filter((event) => event.level === "warning").length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <TerminalSquareIcon aria-hidden="true" className="size-4" />
          </span>
          <div>
            <CardTitle>Job Console</CardTitle>
            <CardDescription>
              Nhật ký dịch Legend · progress ẩn để dễ thấy lỗi
            </CardDescription>
          </div>
        </div>
        <CardAction className="flex items-center gap-1">
          {errorCount > 0 ? (
            <Badge variant="destructive">{formatNumber(errorCount)} lỗi</Badge>
          ) : null}
          {warningCount > 0 ? (
            <Badge variant="secondary">
              {formatNumber(warningCount)} cảnh báo
            </Badge>
          ) : null}
          <Select
            value={level}
            onValueChange={(value) => setLevel(value as EventLevel | "all")}
          >
            <SelectTrigger size="sm" aria-label="Lọc mức độ">
              <ListFilterIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="info">Thông tin</SelectItem>
                <SelectItem value="success">Thành công</SelectItem>
                <SelectItem value="warning">Cảnh báo</SelectItem>
                <SelectItem value="error">Lỗi</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            size="icon-sm"
            variant="destructive"
            aria-label="Xóa nhật ký"
            disabled={events.length === 0}
            onClick={onClear}
          >
            <Trash2Icon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {filteredEvents.length > 0 ? (
          <div className="max-h-64 space-y-1 overflow-auto pr-0.5">
            {filteredEvents.map((event) => (
              <LegendConsoleItem key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <div className="flex h-28 flex-col items-center justify-center gap-1 text-center">
            <ActivityIcon
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            <p className="text-xs font-medium">Chưa có nhật ký</p>
            <p className="max-w-sm text-[11px] leading-snug text-muted-foreground">
              Sự kiện started, warning, lỗi và completed sẽ hiện khi bạn dịch
              hoặc khi thao tác thất bại.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
