import { Progress } from "@/components/ui/progress"
import { formatNumber } from "@/components/product-ui"
import { useJobProgress } from "@/lib/job-progress-store"

/** Thanh tiến độ — subscribe store riêng, không kéo theo Pipeline/DeployPreview. */
export function JobProgressBar({
  className,
  showFile = true,
}: {
  className?: string
  showFile?: boolean
}) {
  const job = useJobProgress()
  if (!job || job.status !== "running") return null

  const unit = job.step === "deploy" ? "file" : "mục"
  const primaryLabel =
    job.total > 0
      ? `Đã xử lý ${formatNumber(job.processed)} / ${formatNumber(job.total)} ${unit}`
      : `Đã xử lý ${formatNumber(job.processed)} ${unit}`

  return (
    <div className={className}>
      <div className="flex justify-between gap-3 text-sm">
        <span className="min-w-0 font-medium">{primaryLabel}</span>
        <span className="shrink-0 font-semibold tabular-nums">
          {Math.round(job.progress)}%
        </span>
      </div>
      <Progress
        value={Math.round(job.progress)}
        aria-label="Tiến độ tác vụ"
        className="mt-2"
      />
      {showFile && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {job.currentFile || "Đang chuẩn bị…"}
        </p>
      )}
    </div>
  )
}
