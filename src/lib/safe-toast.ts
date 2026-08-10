import { toast as sonnerToast } from "sonner"

function shouldSuppressToast(message: unknown): boolean {
  const chunks: string[] = []
  if (typeof message === "string") chunks.push(message)
  else if (message instanceof Error) chunks.push(message.message)
  else if (message != null) {
    try {
      chunks.push(JSON.stringify(message))
    } catch {
      chunks.push(String(message))
    }
  }
  const text = chunks.join("\n").toLocaleLowerCase("vi-VN")
  return (
    text.includes("job_already_running") ||
    text.includes("chỉ được chạy một job") ||
    text.includes("chỉ được chạy một tác vụ") ||
    (text.includes("một thời điểm") &&
      (text.includes("job") || text.includes("tác vụ") || text.includes("chạy")))
  )
}

type ToastError = typeof sonnerToast.error

const originalError: ToastError = sonnerToast.error.bind(sonnerToast)

/**
 * Patch once at app boot. Guarantees the "already running" IPC error
 * can never appear as a red toast, regardless of call site / stale HMR.
 */
export function installSafeToast(): void {
  const patched = sonnerToast as typeof sonnerToast & {
    __civ7SafeToastInstalled?: boolean
  }
  if (patched.__civ7SafeToastInstalled) return
  patched.__civ7SafeToastInstalled = true

  sonnerToast.error = ((message: unknown, data?: unknown) => {
    if (shouldSuppressToast(message)) return ""
    return originalError(message as never, data as never)
  }) as ToastError
}

export { sonnerToast as toast }
