import { ArrowUpIcon, TagIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { APP_VERSION, formatAppVersionLabel } from "@/lib/app-meta"
import { cn } from "@/lib/utils"

export function VersionBadge({
  version = APP_VERSION,
  availableVersion,
  compact = false,
  className,
  onClick,
}: {
  version?: string
  availableVersion?: string | null
  compact?: boolean
  className?: string
  onClick?: () => void
}) {
  const currentLabel = formatAppVersionLabel(version)
  const latestLabel = availableVersion
    ? formatAppVersionLabel(availableVersion)
    : null
  const hasUpdate = Boolean(latestLabel && latestLabel !== currentLabel)
  const label = hasUpdate && latestLabel ? latestLabel : currentLabel
  const title = hasUpdate
    ? `Đang dùng ${currentLabel} — có ${latestLabel}. Bấm để cập nhật.`
    : `Phiên bản ${currentLabel}`

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "border font-mono font-semibold tracking-wide",
        hasUpdate
          ? "border-warning/30 bg-warning-soft-gradient text-warning"
          : "border-primary/20 bg-primary-soft-gradient text-primary",
        compact ? "px-1.5 text-[10px]" : "text-[11px]",
        onClick && "cursor-pointer",
        className,
      )}
      aria-label={title}
      title={title}
    >
      {hasUpdate ? (
        <ArrowUpIcon data-icon="inline-start" />
      ) : (
        <TagIcon data-icon="inline-start" />
      )}
      {label}
    </Badge>
  )

  if (!onClick) return badge

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {badge}
    </button>
  )
}
