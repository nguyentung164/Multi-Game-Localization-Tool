import type { ReactNode } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  BellIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  LanguagesIcon,
  MoonIcon,
  SunIcon,
  WorkflowIcon,
} from "lucide-react"
import { WindowControls } from "@/components/window-controls"
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
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { JobEvent } from "@/lib/app-types"
import { isTauriRuntime } from "@/lib/tauri-ipc"
import { cn } from "@/lib/utils"

type AppTitlebarProps = {
  viewLabel: string
  running: boolean
  progress?: number
  events: JobEvent[]
  notificationsEnabled: boolean
  onToggleTheme: () => void
}

const levelStyles: Record<
  JobEvent["level"],
  { badge: string; dot: string }
> = {
  info: {
    badge: "border-border text-muted-foreground",
    dot: "bg-info",
  },
  success: {
    badge: "border-success/30 text-success",
    dot: "bg-success",
  },
  warning: {
    badge: "border-warning/30 text-warning",
    dot: "bg-warning",
  },
  error: {
    badge: "border-destructive/30 text-destructive",
    dot: "bg-destructive",
  },
}

export function AppTitlebar({
  viewLabel,
  running,
  progress,
  events,
  notificationsEnabled,
  onToggleTheme,
}: AppTitlebarProps) {
  const recentEvents = events.slice(0, 8)
  const alertCount = recentEvents.filter(
    (event) => event.level === "warning" || event.level === "error",
  ).length
  const tooltipText = recentEvents.length > 0
    ? `${recentEvents.length} sự kiện gần đây`
    : "Xem trạng thái và sự kiện pipeline"

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest("button, a, [data-no-drag]")) return
        if (isTauriRuntime()) {
          void getCurrentWindow().toggleMaximize()
        }
      }}
      className="relative z-20 flex h-11 w-full shrink-0 items-stretch border-b border-sidebar-border/80 bg-sidebar text-sidebar-foreground select-none"
    >
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-no-drag
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          >
            <LanguagesIcon aria-hidden="true" className="size-3.5" />
          </span>
          <div data-no-drag>
            <SidebarTrigger className="text-sidebar-foreground" />
          </div>
          <div className="mx-1 hidden h-4 w-px bg-sidebar-border sm:block" />
          <div className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
            <span className="truncate font-medium text-sidebar-foreground/90">
              CIV7 Localization
            </span>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-sidebar-foreground/45"
            />
            <span className="truncate text-sidebar-foreground/65">
              {viewLabel}
            </span>
          </div>
        </div>

        <div data-no-drag className="flex items-center gap-1.5">
          {running && (
            <Badge
              className="hidden border-sidebar-border bg-sidebar-accent/50 text-sidebar-foreground sm:inline-flex"
              variant="outline"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-info" />
              Đang chạy {Math.round(progress ?? 0)}%
            </Badge>
          )}

          <DropdownMenu>
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
                      {alertCount > 0 && (
                        <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-destructive text-[9px] font-semibold text-white">
                          {alertCount > 9 ? "9+" : alertCount}
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
              className="z-[200] w-80 p-0"
            >
              <div className="border-b px-3 py-2.5">
                <DropdownMenuLabel className="p-0 text-sm font-semibold">
                  Thông báo
                </DropdownMenuLabel>
                <p className="mt-1 text-xs text-muted-foreground">
                  {notificationsEnabled
                    ? "Sự kiện pipeline và trạng thái hệ thống"
                    : "Thông báo Windows đã tắt — vẫn xem log tại đây"}
                </p>
              </div>

              <div className="flex items-start gap-2 border-b px-3 py-2.5">
                <span
                  className={cn(
                    "mt-1 size-2 shrink-0 rounded-full",
                    running ? "animate-pulse bg-info" : "bg-success",
                  )}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {running
                      ? `Engine đang chạy (${Math.round(progress ?? 0)}%)`
                      : "Hệ thống sẵn sàng"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {running
                      ? "Theo dõi tiến trình ở footer Pipeline hoặc console bên dưới."
                      : "Chạy một bước pipeline để sinh sự kiện mới."}
                  </p>
                </div>
              </div>

              <DropdownMenuSeparator className="m-0" />

              {recentEvents.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                  <WorkflowIcon className="size-8 text-muted-foreground/60" />
                  <p className="text-sm font-medium">Chưa có sự kiện</p>
                  <p className="text-xs text-muted-foreground">
                    Log sẽ xuất hiện ở đây khi bạn chạy Export, Đồng bộ, Dịch
                    hoặc Deploy.
                  </p>
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto p-1">
                  {recentEvents.map((event) => {
                    const styles = levelStyles[event.level]
                    return (
                      <DropdownMenuItem
                        key={event.id}
                        className="flex cursor-default flex-col items-start gap-1 whitespace-normal rounded-md px-2 py-2"
                        onSelect={(selectEvent) => selectEvent.preventDefault()}
                      >
                        <div className="flex w-full items-center gap-2">
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full", styles.dot)}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {event.title}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn("shrink-0 text-[10px]", styles.badge)}
                          >
                            {event.level === "error"
                              ? "Lỗi"
                              : event.level === "warning"
                                ? "Cảnh báo"
                                : event.level === "success"
                                  ? "OK"
                                  : "Info"}
                          </Badge>
                        </div>
                        <p className="pl-3.5 text-xs text-muted-foreground">
                          {event.timestamp}
                          {event.description ? ` · ${event.description}` : ""}
                        </p>
                      </DropdownMenuItem>
                    )
                  })}
                </div>
              )}

              {recentEvents.length > 0 && (
                <>
                  <DropdownMenuSeparator className="m-0" />
                  <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
                    <CheckCircle2Icon className="size-3.5 shrink-0" />
                    {recentEvents.length} sự kiện gần nhất · xem thêm ở console
                    Pipeline
                  </div>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <TitlebarIconButton
            label="Đổi chủ đề"
            tooltip="Đổi giao diện sáng/tối"
            onClick={onToggleTheme}
          >
            <SunIcon className="hidden dark:block" />
            <MoonIcon className="dark:hidden" />
          </TitlebarIconButton>
        </div>
      </div>
      <WindowControls className="h-11 border-sidebar-border/80" />
    </header>
  )
}

function TitlebarIconButton({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string
  tooltip: string
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          data-no-drag
          onClick={onClick}
          className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
