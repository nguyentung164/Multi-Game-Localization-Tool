import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { pathBasename } from "@/lib/path-utils"
import { isTauriRuntime } from "@/lib/tauri-ipc"
export type SyncProgressEvent = {
  command: string
  step: string
  payload: Record<string, unknown>
}

function isValidFileScanRatio(processed: number, total: number): boolean {
  return total > 0 && processed >= 0 && processed <= total
}

export function formatSyncProgressLabel(event: SyncProgressEvent): string | null {
  const { payload } = event
  const processed = readNumber(payload.processed)
  const total = readNumber(payload.total)
  if (
    processed !== null &&
    total !== null &&
    isValidFileScanRatio(processed, total)
  ) {
    const file =
      typeof payload.file === "string" && payload.file.trim()
        ? pathBasename(payload.file.trim())
        : null
    const count = `${processed.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")}`
    if (file) {
      return `Đã quét ${count} file · ${file}`
    }
    return `Đã quét ${count} file`
  }

  const replaced = readNumber(payload.replaced)
  const replaceTotal = readNumber(payload.replaceTotal)
  if (replaced !== null && replaceTotal !== null && replaceTotal > 0) {
    return `Đã thay ${replaced.toLocaleString("vi-VN")} / ${replaceTotal.toLocaleString("vi-VN")} tag`
  }

  const message =
    typeof payload.message === "string" ? payload.message.trim() : ""
  return message || null
}

export function syncProgressPercent(event: SyncProgressEvent): number | null {
  const progress = readNumber(event.payload.progress)
  if (progress !== null) {
    return clampPercent(progress)
  }

  const processed = readNumber(event.payload.processed)
  const total = readNumber(event.payload.total)
  if (
    processed !== null &&
    total !== null &&
    isValidFileScanRatio(processed, total)
  ) {
    return clampPercent((processed / total) * 100)
  }

  const replaced = readNumber(event.payload.replaced)
  const replaceTotal = readNumber(event.payload.replaceTotal)
  if (
    replaced !== null &&
    replaceTotal !== null &&
    replaceTotal > 0 &&
    replaced <= replaceTotal
  ) {
    return clampPercent((replaced / replaceTotal) * 100)
  }

  return null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export async function listenToSyncProgress(
  handler: (event: SyncProgressEvent) => void,
  commandFilter?: string | string[],
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => undefined
  const filters = commandFilter
    ? Array.isArray(commandFilter)
      ? commandFilter
      : [commandFilter]
    : null
  return listen<SyncProgressEvent>("sync-progress", ({ payload }) => {
    if (filters && !filters.includes(payload.command)) return
    handler(payload)
  })
}
