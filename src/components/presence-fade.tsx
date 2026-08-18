import {
  useEffect,
  useState,
  type ComponentProps,
  type ElementType,
  type ReactNode,
} from "react"
import { Alert } from "@/components/ui/alert"
import { usePresenceTransition } from "@/hooks/use-presence-transition"
import { cn } from "@/lib/utils"

type PresenceFadeProps = {
  show: boolean
  children: ReactNode
  className?: string
  /** Giữ DOM khi ẩn (keep-alive pages). */
  keepMounted?: boolean
  durationMs?: number
  /** false = không fade-in (dùng cho chuyển page). */
  animateEnter?: boolean
  as?: ElementType
}

/** Fade + slide nhẹ; hỗ trợ enter/exit đầy đủ hoặc keep-alive. */
export function PresenceFade({
  show,
  children,
  className,
  keepMounted = false,
  durationMs = 180,
  animateEnter = true,
  as: Tag = "div",
}: PresenceFadeProps) {
  const { mounted, state } = usePresenceTransition(show, durationMs, keepMounted, {
    animateEnter,
  })

  if (!mounted) return null

  return (
    <Tag
      className={cn(
        animateEnter
          ? keepMounted
            ? "presence-page"
            : "presence-fade"
          : keepMounted
            ? "presence-page-snap"
            : "presence-fade-snap",
        keepMounted && show && "z-0",
        keepMounted &&
          !show &&
          "pointer-events-none absolute inset-0 -z-10 overflow-hidden",
        className,
      )}
      data-state={state}
      aria-hidden={!show || undefined}
    >
      {children}
    </Tag>
  )
}

/** Chuyển page sidebar — không animation, phản hồi tức thì. */
export function PageSlot({
  show,
  children,
  className,
  keepMounted = false,
}: {
  show: boolean
  children: ReactNode
  className?: string
  keepMounted?: boolean
}) {
  if (!keepMounted && !show) return null

  return (
    <div
      className={cn(
        keepMounted &&
          !show &&
          "pointer-events-none invisible absolute inset-0 -z-10 overflow-hidden",
        keepMounted && show && "z-0",
        className,
      )}
      aria-hidden={!show || undefined}
    >
      {children}
    </div>
  )
}

/** @deprecated Dùng PageSlot */
export const PagePresenceFade = PageSlot

/** Chỉ animate khi mount (Suspense / lazy chunk). */
export function MountFadeIn({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode
  className?: string
  as?: ElementType
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <Tag
      className={cn("presence-fade", className)}
      data-state={open ? "open" : "closed"}
    >
      {children}
    </Tag>
  )
}

/** Crossfade khi `phaseKey` đổi — giữ API, không animate. */
export function PhaseFade({
  children,
  className,
}: {
  phaseKey?: string
  children: ReactNode
  className?: string
}) {
  return <div className={className}>{children}</div>
}

/** Alert có điều kiện — không animate. */
export function PresenceAlert({
  show,
  className,
  children,
  ...props
}: ComponentProps<typeof Alert> & { show: boolean }) {
  if (!show) return null

  return (
    <Alert {...props} className={className}>
      {children}
    </Alert>
  )
}

/** Label nút loading — swap tức thì. */
export function LoadingButtonLabel({
  loading,
  loadingContent,
  idleContent,
}: {
  loading: boolean
  loadingContent: ReactNode
  idleContent: ReactNode
  className?: string
}) {
  return loading ? loadingContent : idleContent
}

/** Inline loading block (dialog, list). */
export function InlineLoadingBlock({
  loading,
  children,
  className,
  label = "Đang tải…",
}: {
  loading: boolean
  children: ReactNode
  className?: string
  label?: string
}) {
  return (
    <div className={cn("relative min-h-[2.5rem]", className)}>
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {label}
        </div>
      ) : (
        children
      )}
    </div>
  )
}
