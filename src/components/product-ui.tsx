import type { LucideIcon } from "lucide-react"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  Clock3Icon,
  LoaderCircleIcon,
  LockIcon,
  PauseCircleIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { StepStatus } from "@/lib/app-types"

const statusMap: Record<
  StepStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  locked: {
    label: "Đã khóa",
    icon: LockIcon,
    className: "text-muted-foreground",
  },
  ready: {
    label: "Sẵn sàng",
    icon: CircleDashedIcon,
    className: "text-primary",
  },
  running: {
    label: "Đang chạy",
    icon: LoaderCircleIcon,
    className: "text-info",
  },
  success: {
    label: "Hoàn thành",
    icon: CheckCircle2Icon,
    className: "text-success",
  },
  warning: {
    label: "Có cảnh báo",
    icon: TriangleAlertIcon,
    className: "text-warning-foreground dark:text-warning",
  },
  failed: {
    label: "Thất bại",
    icon: AlertCircleIcon,
    className: "text-destructive",
  },
  paused: {
    label: "Đã tạm dừng",
    icon: PauseCircleIcon,
    className: "text-warning-foreground dark:text-warning",
  },
}

export const pageShellClass =
  "w-full min-w-0 max-w-full px-4 sm:px-6 lg:px-8"

export const pageContainerClass = `${pageShellClass} flex flex-col gap-4 py-5`

export function StatusBadge({
  status,
  className,
}: {
  status: StepStatus
  className?: string
}) {
  const item = statusMap[status]
  const Icon = item.icon
  return (
    <Badge variant="outline" className={cn(item.className, className)}>
      <Icon
        data-icon="inline-start"
        className={cn(status === "running" && "animate-spin")}
      />
      {item.label}
    </Badge>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex max-w-3xl flex-col gap-1">
        <p className="text-xs font-semibold tracking-[0.18em] text-primary uppercase">
          {eyebrow}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </header>
  )
}

export function Metric({
  icon: Icon,
  label,
  value,
  hint,
  onClick,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  onClick?: () => void
}) {
  const className =
    "flex min-w-0 items-start gap-3 rounded-lg bg-surface-gradient p-3 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft-gradient text-primary">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </>
  )
  if (onClick) {
    return (
      <Button
        type="button"
        variant="outline"
        className={cn(className, "h-auto justify-start text-left hover:brightness-105")}
        onClick={onClick}
      >
        {body}
      </Button>
    )
  }
  return <div className={className}>{body}</div>
}

export function EmptyPanel({
  icon: Icon = Clock3Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {action && (
        <Button size="sm" variant="outline" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

export const formatNumber = (value: number) =>
  new Intl.NumberFormat("vi-VN").format(value)

