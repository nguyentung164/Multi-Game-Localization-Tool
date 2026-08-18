import { useState } from "react"
import {
  BellIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  WorkflowIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AppNotificationsController } from "@/hooks/use-app-notifications"
import type { AppNotificationItem } from "@/lib/app-notifications"
import type { AppView, StepId } from "@/lib/app-types"
import { formatRelativeTime } from "@/lib/format-date"
import { cn } from "@/lib/utils"

const levelStyles: Record<
  AppNotificationItem["level"],
  { badge: string; dot: string; label: string }
> = {
  info: {
    badge: "text-info",
    dot: "bg-info",
    label: "Info",
  },
  success: {
    badge: "text-success",
    dot: "bg-success",
    label: "OK",
  },
  warning: {
    badge: "text-warning",
    dot: "bg-warning",
    label: "Cảnh báo",
  },
  error: {
    badge: "text-destructive",
    dot: "bg-destructive",
    label: "Lỗi",
  },
}

type NotificationPanelProps = {
  notifications: AppNotificationsController
  onNavigate: (view: AppView, options?: { step?: StepId }) => void
}

export function NotificationPanel({
  notifications,
  onNavigate,
}: NotificationPanelProps) {
  const {
    items,
    allItems,
    unreadAlertCount,
    runningSummary,
    notificationsEnabled,
    hasEvents,
    markRead,
    isUnread,
  } = notifications

  const [open, setOpen] = useState(false)

  const navigateAndClose = (
    view: AppView,
    options?: { step?: StepId },
  ) => {
    onNavigate(view, options)
    setOpen(false)
  }

  const tooltipText =
    allItems.length > 0
      ? `${allItems.length} sự kiện · ${unreadAlertCount > 0 ? `${unreadAlertCount} chưa đọc` : "không có cảnh báo mới"}`
      : "Xem trạng thái và sự kiện pipeline"

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) markRead()
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Thông báo"
              data-no-drag
              className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <span className="relative">
                <BellIcon />
                {unreadAlertCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-destructive text-[9px] font-semibold text-white">
                    {unreadAlertCount > 9 ? "9+" : unreadAlertCount}
                  </span>
                )}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="z-[200] w-96 p-0"
      >
        <div className="border-b px-3 py-2.5">
          <DropdownMenuLabel className="p-0 text-sm font-semibold">
            Thông báo
          </DropdownMenuLabel>
          <p className="mt-1 text-xs text-muted-foreground">
            {notificationsEnabled
              ? "Sự kiện CIV7, Legend và trạng thái hệ thống · Windows native khi hoàn tất/lỗi"
              : "Thông báo Windows đã tắt — vẫn xem log in-app tại đây"}
          </p>
        </div>

        <div className="flex items-start gap-2 border-b px-3 py-2.5">
          <span
            className={cn(
              "mt-1 size-2 shrink-0 rounded-full",
              runningSummary.running ? "animate-pulse bg-info" : "bg-success",
            )}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {runningSummary.running
                ? `${runningSummary.productLabel} đang chạy (${runningSummary.progress}%)`
                : "Hệ thống sẵn sàng"}
            </p>
            <p className="text-xs text-muted-foreground">{runningSummary.hint}</p>
          </div>
        </div>

        <DropdownMenuSeparator className="m-0" />

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <WorkflowIcon className="size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Chưa có sự kiện</p>
            <p className="text-xs text-muted-foreground">
              Log sẽ xuất hiện khi bạn chạy Export, Đồng bộ, Dịch CIV7 hoặc dịch
              Legend.
            </p>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto p-1">
            {items.map((event) => {
              const styles = levelStyles[event.level]
              const unread = isUnread(event)
              return (
                <DropdownMenuItem
                  key={event.id}
                  className={cn(
                    "flex cursor-pointer flex-col items-start gap-1 whitespace-normal rounded-md px-2 py-2",
                    unread && "bg-muted/40",
                  )}
                  onSelect={() => {
                    navigateAndClose(
                      event.navigateTo,
                      event.step ? { step: event.step } : undefined,
                    )
                  }}
                >
                  <div className="flex w-full items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        styles.dot,
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {event.title}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn("shrink-0 text-[10px]", styles.badge)}
                    >
                      {styles.label}
                    </Badge>
                  </div>
                  <div className="flex w-full items-center gap-1.5 pl-3.5">
                    <Badge
                      variant="secondary"
                      className="shrink-0 text-[10px] font-normal"
                    >
                      {event.sourceLabel}
                    </Badge>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {formatRelativeTime(event.occurredAtMs) || event.timestamp}
                      {event.description ? ` · ${event.description}` : ""}
                    </span>
                  </div>
                </DropdownMenuItem>
              )
            })}
          </div>
        )}

        {hasEvents && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <div className="flex flex-col gap-1 px-2 py-2">
              <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                <CheckCircle2Icon className="size-3.5 shrink-0" />
                {allItems.length} sự kiện · hiển thị {items.length} mục gần nhất
              </div>
              <div className="flex flex-wrap gap-1 px-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => navigateAndClose("pipeline")}
                >
                  Mở Pipeline console
                  <ChevronRightIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => navigateAndClose("legend-three-kingdoms")}
                >
                  Mở Legend console
                  <ChevronRightIcon className="size-3" />
                </Button>
              </div>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
