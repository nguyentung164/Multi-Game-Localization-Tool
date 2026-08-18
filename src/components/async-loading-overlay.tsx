import { Loader2Icon } from "lucide-react"
import { createPortal } from "react-dom"
import { Progress } from "@/components/ui/progress"
import { usePresenceTransition } from "@/hooks/use-presence-transition"
import { cn } from "@/lib/utils"

export type AsyncLoadingPhase =
  | "fetching"
  | "rendering"
  | "saving"
  | "applying"

const defaultPhaseLabels: Record<AsyncLoadingPhase, string> = {
  fetching: "Đang quét dữ liệu…",
  rendering: "Đang hiển thị kết quả…",
  saving: "Đang lưu…",
  applying: "Đang áp dụng…",
}

export type AsyncLoadingOverlayProps = {
  visible: boolean
  title: string
  description?: string
  phase?: AsyncLoadingPhase
  phaseLabel?: string
  progress?: number | null
}

const OVERLAY_TRANSITION_MS = 200

export function AsyncLoadingOverlay({
  visible,
  title,
  description,
  phase,
  phaseLabel,
  progress = null,
}: AsyncLoadingOverlayProps) {
  const { mounted, state } = usePresenceTransition(
    visible,
    OVERLAY_TRANSITION_MS,
  )

  if (!mounted) return null

  const resolvedPhaseLabel =
    phaseLabel ?? (phase ? defaultPhaseLabels[phase] : null)
  const showDeterminate =
    typeof progress === "number" && Number.isFinite(progress)

  return createPortal(
    <div
      className={cn(
        "presence-overlay-backdrop fixed inset-0 z-50 flex items-center justify-center overflow-hidden",
        "bg-background/70 supports-backdrop-filter:backdrop-blur-sm",
      )}
      data-state={state}
      role="status"
      aria-live="polite"
      aria-busy={state === "open"}
      aria-label={title}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent)]" />

      <div
        className={cn(
          "presence-overlay-panel relative mx-4 flex w-full min-w-0 max-w-sm flex-col items-center gap-4 rounded-xl",
          "bg-surface-gradient px-6 py-5 text-center",
          "shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]",
        )}
        data-state={state}
      >
        <div className="relative flex size-7 items-center justify-center">
          <Loader2Icon
            aria-hidden="true"
            className="relative z-10 size-7 animate-spin text-primary"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 scale-75 animate-ping rounded-full bg-primary/20 opacity-40"
          />
        </div>

        <div className="min-w-0 w-full space-y-1">
          <p className="text-sm font-medium break-words">{title}</p>
          {description ? (
            <p className="text-muted-foreground text-xs break-words">
              {description}
            </p>
          ) : null}
          {resolvedPhaseLabel ? (
            <p
              className="text-muted-foreground truncate text-xs"
              title={resolvedPhaseLabel}
            >
              {resolvedPhaseLabel}
            </p>
          ) : null}
        </div>

        {showDeterminate ? (
          <div className="w-full space-y-1">
            <Progress value={Math.max(0, Math.min(100, progress))} />
            <p className="text-muted-foreground text-xs tabular-nums">
              {Math.round(progress)}%
            </p>
          </div>
        ) : (
          <div className="loading-progress-track h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="loading-progress-indeterminate h-full w-2/5 rounded-full bg-primary-gradient" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** @deprecated Use AsyncLoadingOverlay */
export const SearchLoadingOverlay = AsyncLoadingOverlay
