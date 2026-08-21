import { useCallback, useEffect, useRef, useState } from "react"
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart"
import { toast } from "sonner"
import { formatInvokeError, isTauriRuntime } from "@/lib/tauri-ipc"

export type AppAutostart = ReturnType<typeof useAppAutostart>

export function useAppAutostart() {
  const desktop = isTauriRuntime()
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(!desktop)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)

  useEffect(() => {
    if (!desktop) return

    let cancelled = false
    void isEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value)
      })
      .catch(() => {
        if (!cancelled) setEnabled(false)
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [desktop])

  const setAutostartEnabled = useCallback(
    async (next: boolean) => {
      if (!desktop || pendingRef.current) return
      pendingRef.current = true
      setPending(true)
      try {
        if (next) await enable()
        else await disable()
        const actual = await isEnabled()
        setEnabled(actual)
        toast.success(
          actual
            ? "Đã bật khởi chạy cùng Windows."
            : "Đã tắt khởi chạy cùng Windows.",
        )
      } catch (error) {
        toast.error(formatInvokeError(error))
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    },
    [desktop],
  )

  return {
    available: desktop,
    enabled,
    pending,
    ready,
    setAutostartEnabled,
  }
}
