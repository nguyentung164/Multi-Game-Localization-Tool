import { LanguagesIcon, Loader2Icon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { APP_NAME } from "@/lib/app-meta"

type AppLoadingShellProps = {
  variant?: "boot" | "page"
  title?: string
  subtitle?: string
  statusLabel?: string
  /** Trạng thái presence — mặc định open. */
  presenceState?: "open" | "closed"
}

export function AppLoadingShell({
  variant = "boot",
  title = APP_NAME,
  subtitle = "Đang đồng bộ trạng thái từ orchestrator…",
  statusLabel,
  presenceState = "open",
}: AppLoadingShellProps) {
  if (variant === "page") {
    return (
      <div
        className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
        data-state={presenceState}
        role="status"
        aria-live="polite"
        aria-label={statusLabel ?? "Đang tải trang"}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]" />
        <div className="relative flex flex-1 flex-col gap-5 p-8">
          <div className="space-y-2">
            <Skeleton className="h-3 w-28 bg-muted-gradient" />
            <Skeleton className="h-8 w-64 bg-muted-gradient" />
            <Skeleton className="h-4 w-96 max-w-full bg-muted-gradient" />
          </div>
          <Skeleton className="h-16 w-full rounded-xl bg-surface-gradient" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-28 rounded-xl bg-surface-gradient" />
            <Skeleton className="h-28 rounded-xl bg-surface-gradient" />
            <Skeleton className="h-28 rounded-xl bg-surface-gradient" />
          </div>
          <Skeleton className="h-48 w-full rounded-xl bg-surface-gradient" />
          <Skeleton className="h-72 w-full rounded-xl bg-surface-gradient" />
          <LoadingStatusRow label={statusLabel ?? "Đang tải Pipeline…"} />
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden p-8"
      data-state={presenceState}
      role="status"
      aria-live="polite"
      aria-label="Đang tải dữ liệu"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent)]" />

      <div className="relative flex w-full max-w-md flex-col items-center gap-6 text-center">
        <div className="relative">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary-gradient shadow-[0_4px_16px_color-mix(in_oklch,var(--primary)_35%,transparent)]">
            <LanguagesIcon
              aria-hidden="true"
              className="size-7 text-primary-foreground"
            />
          </div>
          <span
            aria-hidden="true"
            className="absolute -inset-1 animate-ping rounded-2xl bg-primary/25 opacity-50"
          />
        </div>

        <div className="space-y-1">
          <p className="text-lg font-semibold tracking-tight">{title}</p>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>

        <div className="w-full max-w-xs space-y-2">
          <div className="loading-progress-track h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="loading-progress-indeterminate h-full w-2/5 rounded-full bg-primary-gradient" />
          </div>
          <p className="text-xs text-muted-foreground">
            {statusLabel ?? "Đang khởi động engine…"}
          </p>
        </div>

        <div className="grid w-full gap-3 opacity-60">
          <Skeleton className="mx-auto h-3 w-36 bg-muted-gradient" />
          <Skeleton className="h-20 w-full rounded-xl bg-muted-gradient/80" />
        </div>
      </div>
    </div>
  )
}

function LoadingStatusRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2Icon aria-hidden="true" className="size-5 animate-spin text-primary" />
      <span>{label}</span>
    </div>
  )
}
