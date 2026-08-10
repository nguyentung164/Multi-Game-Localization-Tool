/** Module-level lock — survives React remount / Strict Mode. */
let locked = false
let unlockTimer: ReturnType<typeof setTimeout> | undefined
/** Coalesce concurrent start attempts into one in-flight promise. */
let inFlight: Promise<{ jobId: string } | null> | null = null

export function isJobStartLocked(): boolean {
  return locked || inFlight !== null
}

export function acquireJobStartLock(): boolean {
  if (locked || inFlight !== null) return false
  locked = true
  return true
}

export function releaseJobStartLock(): void {
  locked = false
  if (unlockTimer !== undefined) {
    clearTimeout(unlockTimer)
    unlockTimer = undefined
  }
}

/** Keep UI/IPC from re-entering for a short window after a start attempt. */
export function holdJobStartLock(ms = 800): void {
  locked = true
  if (unlockTimer !== undefined) clearTimeout(unlockTimer)
  unlockTimer = setTimeout(() => {
    locked = false
    unlockTimer = undefined
  }, ms)
}

export function getInFlightJobStart(): Promise<{ jobId: string } | null> | null {
  return inFlight
}

export function setInFlightJobStart(
  promise: Promise<{ jobId: string } | null> | null,
): void {
  inFlight = promise
}

/** Detect backend "only one job" errors across Tauri string/object shapes. */
export function isDuplicateJobStartError(error: unknown): boolean {
  const chunks: string[] = []
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) chunks.push(value)
  }

  push(error)
  if (error instanceof Error) {
    push(error.message)
    push(error.name)
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    for (const key of ["message", "code", "error", "errorCode", "kind"]) {
      const value = record[key]
      push(value)
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>
        push(nested.message)
        push(nested.code)
      }
    }
    try {
      chunks.push(JSON.stringify(error))
    } catch {
      /* ignore */
    }
  }

  const text = chunks.join("\n").toLocaleLowerCase("vi-VN")
  return (
    text.includes("job_already_running") ||
    text.includes("chỉ được chạy một job") ||
    text.includes("chỉ được chạy một tác vụ") ||
    (text.includes("một thời điểm") &&
      (text.includes("job") || text.includes("tác vụ")))
  )
}
