import { useLayoutEffect, useState } from "react"

type PresenceTransitionOptions = {
  /** false = hiện page ngay khi chuyển tab (không fade-in). */
  animateEnter?: boolean
}

/** Giữ mount trong lúc exit animation rồi mới gỡ khỏi DOM. */
export function usePresenceTransition(
  active: boolean,
  durationMs = 200,
  keepMounted = false,
  options: PresenceTransitionOptions = {},
) {
  const { animateEnter = true } = options
  const [mounted, setMounted] = useState(active || keepMounted)
  const [open, setOpen] = useState(active)

  useLayoutEffect(() => {
    if (active) {
      setMounted(true)
      if (!animateEnter) {
        setOpen(true)
        return
      }
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setOpen(true))
      })
      return () => cancelAnimationFrame(raf)
    }

    setOpen(false)
    if (keepMounted) return

    const timer = window.setTimeout(() => setMounted(false), durationMs)
    return () => clearTimeout(timer)
  }, [active, animateEnter, durationMs, keepMounted])

  return { mounted, open, state: open ? ("open" as const) : ("closed" as const) }
}
