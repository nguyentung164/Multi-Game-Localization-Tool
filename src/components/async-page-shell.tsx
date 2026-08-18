import { AsyncLoadingOverlay, type AsyncLoadingOverlayProps } from "@/components/async-loading-overlay"
import { cn } from "@/lib/utils"

type AsyncPageShellProps = {
  children: React.ReactNode
  className?: string
  loading?: boolean
  overlay: Omit<AsyncLoadingOverlayProps, "visible">
}

export function AsyncPageShell({
  children,
  className,
  loading = false,
  overlay,
}: AsyncPageShellProps) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        loading && "pointer-events-none",
        className,
      )}
    >
      <AsyncLoadingOverlay visible={loading} {...overlay} />
      {children}
    </div>
  )
}
