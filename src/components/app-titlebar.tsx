import type { ReactNode } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  ChevronRightIcon,
  LanguagesIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react"
import { NotificationPanel } from "@/components/notification-panel"
import { WindowControls } from "@/components/window-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AppNotificationsController } from "@/hooks/use-app-notifications"
import type { AppView, StepId } from "@/lib/app-types"
import { isTauriRuntime } from "@/lib/tauri-ipc"

type AppTitlebarProps = {
  productLabel: string
  viewLabel: string
  running: boolean
  progress?: number
  notifications: AppNotificationsController
  onNavigate: (view: AppView, options?: { step?: StepId }) => void
  onToggleTheme: () => void
}

export function AppTitlebar({
  productLabel,
  viewLabel,
  running,
  progress,
  notifications,
  onNavigate,
  onToggleTheme,
}: AppTitlebarProps) {
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
      className="relative z-20 flex h-9 w-full shrink-0 items-stretch border-b border-sidebar-border/80 bg-sidebar text-sidebar-foreground select-none"
    >
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            data-no-drag
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          >
            <LanguagesIcon aria-hidden="true" className="size-3.5" />
          </span>
          <div data-no-drag>
            <SidebarTrigger className="size-6 text-sidebar-foreground [&_svg:not([class*='size-'])]:size-3.5" />
          </div>
          <div className="mx-0.5 hidden h-4 w-px bg-sidebar-border sm:block" />
          <div className="hidden min-w-0 items-center gap-1.5 text-[13px] sm:flex">
            <span className="truncate font-medium text-sidebar-foreground/90">
              {productLabel}
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
          {running ? (
            <Badge
              className="hidden sm:inline-flex text-info"
              variant="outline"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-info" />
              Đang chạy {Math.round(progress ?? 0)}%
            </Badge>
          ) : null}

          <NotificationPanel
            notifications={notifications}
            onNavigate={onNavigate}
          />

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
      <WindowControls className="h-9 border-sidebar-border/80" />
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
