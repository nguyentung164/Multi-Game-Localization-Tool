import { Loader2Icon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

export function PipelineLoadingShell() {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background"
      role="status"
      aria-live="polite"
      aria-label="Đang tải Pipeline"
    >
      <div className="flex flex-1 flex-col gap-5 p-8">
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden="true" className="size-5 animate-spin" />
          <span>Đang tải Pipeline…</span>
        </div>
      </div>
    </div>
  )
}
