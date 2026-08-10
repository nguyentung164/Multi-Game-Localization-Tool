import type { AppState, SyncChange } from "@/lib/app-types"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** Format ISO/Date → `dd/mm/yyyy hh:mm:ss` (giờ local). Chuỗi không phải ngày giữ nguyên. */
export function formatDateTime(value?: string | Date | number | null): string {
  if (value == null || value === "") return ""

  if (typeof value === "string" && !ISO_DATE_RE.test(value)) {
    return value
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : ""
  }

  return [
    `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(" ")
}

/** Bổ sung text từ before/after nếu state cũ chưa có field text. */
export function normalizeSyncChanges(changes: SyncChange[]): SyncChange[] {
  return changes.map((change) => {
    if (change.text !== undefined) return change
    if (change.kind === "delete" || change.kind === "vtt") {
      if (change.before !== undefined) {
        return { ...change, text: change.before }
      }
    }
    if (change.after !== undefined) {
      return { ...change, text: change.after }
    }
    return change
  })
}

/** Thời gian tương đối ngắn gọn, ví dụ "3 phút trước". */
export function formatRelativeTime(value?: string | Date | number | null): string {
  if (value == null || value === "") return ""

  const date =
    typeof value === "string" && !ISO_DATE_RE.test(value)
      ? null
      : value instanceof Date
        ? value
        : new Date(value)
  if (!date || Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : ""
  }

  const deltaMs = Date.now() - date.getTime()
  if (deltaMs < 0) return "Vừa xong"
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return "Vừa xong"
  if (minutes < 60) return `${minutes} phút trước`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} giờ trước`
  const days = Math.floor(hours / 24)
  return `${days} ngày trước`
}

/** Chuẩn hóa các field ngày trong AppState trước khi đưa lên UI. */
export function formatAppStateDates(state: AppState): AppState {
  return {
    ...state,
    syncChanges: normalizeSyncChanges(state.syncChanges),
    steps: state.steps.map((step) => ({
      ...step,
      lastRun: step.lastRun ? formatDateTime(step.lastRun) : step.lastRun,
    })),
    activeJob: state.activeJob
      ? {
          ...state.activeJob,
          startedAt: formatDateTime(state.activeJob.startedAt),
        }
      : null,
    events: state.events.map((event) => ({
      ...event,
      timestamp: formatDateTime(event.timestamp),
    })),
    apiKeys: state.apiKeys.map((key) => ({
      ...key,
      lastUsed: key.lastUsed ? formatDateTime(key.lastUsed) : key.lastUsed,
      activeSince: key.activeSince
        ? formatDateTime(key.activeSince)
        : key.activeSince,
    })),
    reports: state.reports.map((report) => ({
      ...report,
      createdAt: formatDateTime(report.createdAt),
    })),
    backups: state.backups.map((backup) => ({
      ...backup,
      createdAt: formatDateTime(backup.createdAt),
    })),
    syncPreview: state.syncPreview
      ? { ...state.syncPreview }
      : state.syncPreview,
  }
}
