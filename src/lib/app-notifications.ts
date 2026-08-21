import type {
  AppView,
  EventLevel,
  JobEvent,
  StepId,
} from "@/lib/app-types"
import { STEP_LABELS } from "@/lib/app-types"
import {
  updaterErrorNotificationTitle,
  type AvailableAppUpdate,
  type UpdaterStatus,
} from "@/lib/app-updater"
import { formatDateTime, parseDisplayOrIsoTimestamp } from "@/lib/format-date"
import type { LegendConsoleEvent } from "@/lib/legend-console"

export const NOTIFICATION_DISPLAY_LIMIT = 8
export const NOTIFICATION_READ_AT_KEY = "app-notification-read-at"

export type NotificationSource = "civ7" | "legend" | "app"

export type AppNotificationKind = "job" | "update" | "update-error"

export interface AppNotificationItem {
  id: string
  source: NotificationSource
  kind?: AppNotificationKind
  level: EventLevel
  title: string
  description: string
  timestamp: string
  occurredAtMs: number
  sortRank: number
  sourceLabel: string
  navigateTo: AppView
  step?: StepId
}

export interface NotificationRunningSummary {
  running: boolean
  productLabel: string
  progress: number
  hint: string
}

const ALERT_LEVELS = new Set<EventLevel>(["warning", "error"])

export function notificationFeedKey(
  source: NotificationSource,
  id: string,
): string {
  return `${source}:${id}`
}

export function isAlertLevel(level: EventLevel): boolean {
  return ALERT_LEVELS.has(level)
}

export function loadNotificationReadAtMs(): number {
  if (typeof window === "undefined") return 0
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_READ_AT_KEY)
    if (!raw) return 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

/** Lần đầu mở app: coi mọi alert cũ là đã đọc để tránh badge 9+ ngay khi khởi động. */
export function initializeNotificationReadAtMs(): number {
  const existing = loadNotificationReadAtMs()
  if (existing > 0) return existing
  const now = Date.now()
  saveNotificationReadAtMs(now)
  return now
}

export function saveNotificationReadAtMs(value: number): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(NOTIFICATION_READ_AT_KEY, String(value))
  } catch {
    // ignore quota / private mode
  }
}

function resolveOccurredAtMs(timestamp: string, sortRank: number): number {
  const parsed = parseDisplayOrIsoTimestamp(timestamp)
  if (parsed > 0) return parsed
  return sortRank
}

export function mapCiv7Notification(
  event: JobEvent,
  sortRank: number,
): AppNotificationItem {
  const stepLabel = STEP_LABELS[event.step] ?? event.step
  return {
    id: notificationFeedKey("civ7", event.id),
    source: "civ7",
    level: event.level,
    title: event.title,
    description: event.description,
    timestamp: event.timestamp,
    occurredAtMs: resolveOccurredAtMs(event.timestamp, sortRank),
    sortRank,
    sourceLabel: `CIV7 · ${stepLabel}`,
    navigateTo: "pipeline",
    step: event.step,
  }
}

export function mapLegendNotification(
  event: LegendConsoleEvent,
  sortRank: number,
): AppNotificationItem {
  return {
    id: notificationFeedKey("legend", event.id),
    source: "legend",
    level: event.level,
    title: event.title,
    description: event.description,
    timestamp: event.timestamp,
    occurredAtMs: resolveOccurredAtMs(event.timestamp, sortRank),
    sortRank,
    sourceLabel: "Legend · Dịch",
    navigateTo: "legend-three-kingdoms",
  }
}

export function mapLegendJsonNotification(
  event: LegendConsoleEvent,
  sortRank: number,
): AppNotificationItem {
  return {
    id: notificationFeedKey("legend", `json:${event.id}`),
    source: "legend",
    level: event.level,
    title: event.title,
    description: event.description,
    timestamp: event.timestamp,
    occurredAtMs: resolveOccurredAtMs(event.timestamp, sortRank),
    sortRank,
    sourceLabel: "Legend · JSON Pipeline",
    navigateTo: "legend-json-pipeline",
  }
}

export function compareNotificationItems(
  left: AppNotificationItem,
  right: AppNotificationItem,
): number {
  if (right.occurredAtMs !== left.occurredAtMs) {
    return right.occurredAtMs - left.occurredAtMs
  }
  return right.sortRank - left.sortRank
}

export function mergeNotificationFeeds(
  civ7Events: JobEvent[],
  legendEvents: LegendConsoleEvent[],
  extraItems: AppNotificationItem[] = [],
): AppNotificationItem[] {
  const byId = new Map<string, AppNotificationItem>()
  civ7Events.forEach((event, index) => {
    const sortRank = civ7Events.length - index
    byId.set(
      notificationFeedKey("civ7", event.id),
      mapCiv7Notification(event, sortRank),
    )
  })
  legendEvents.forEach((event, index) => {
    const sortRank = legendEvents.length - index
    byId.set(
      notificationFeedKey("legend", event.id),
      mapLegendNotification(event, sortRank),
    )
  })
  extraItems.forEach((item) => {
    byId.set(item.id, item)
  })
  return [...byId.values()].sort(compareNotificationItems)
}

export function isUnreadAlert(
  item: AppNotificationItem,
  lastReadAtMs: number,
): boolean {
  return isAlertLevel(item.level) && item.occurredAtMs > lastReadAtMs
}

export function countUnreadAlerts(
  items: AppNotificationItem[],
  lastReadAtMs: number,
): number {
  return items.filter((item) => isUnreadAlert(item, lastReadAtMs)).length
}

export function selectNotificationDisplayItems(
  items: AppNotificationItem[],
  lastReadAtMs: number,
  limit = NOTIFICATION_DISPLAY_LIMIT,
): AppNotificationItem[] {
  if (items.length === 0) return []

  const unreadAlerts = items.filter((item) => isUnreadAlert(item, lastReadAtMs))
  const rest = items.filter((item) => !isUnreadAlert(item, lastReadAtMs))

  const selected: AppNotificationItem[] = []
  const seen = new Set<string>()

  for (const item of unreadAlerts) {
    if (selected.length >= limit) break
    if (seen.has(item.id)) continue
    seen.add(item.id)
    selected.push(item)
  }

  for (const item of rest) {
    if (selected.length >= limit) break
    if (seen.has(item.id)) continue
    seen.add(item.id)
    selected.push(item)
  }

  return selected
}

export function buildNotificationRunningSummary(options: {
  civ7Running: boolean
  legendRunning: boolean
  legendJsonRunning?: boolean
  progress: number
  civ7ProductLabel: string
  legendProductLabel: string
}): NotificationRunningSummary {
  const progress = Math.round(options.progress)
  if (options.civ7Running) {
    return {
      running: true,
      productLabel: options.civ7ProductLabel,
      progress,
      hint: "Theo dõi tiến trình ở footer Pipeline hoặc console bên dưới.",
    }
  }
  if (options.legendRunning) {
    return {
      running: true,
      productLabel: options.legendProductLabel,
      progress,
      hint: "Theo dõi tiến trình ở trang Dịch Legend hoặc Job Console bên dưới.",
    }
  }
  if (options.legendJsonRunning) {
    return {
      running: true,
      productLabel: options.legendProductLabel,
      progress,
      hint: "Theo dõi tiến trình ở trang JSON Pipeline hoặc Job Console bên dưới.",
    }
  }
  return {
    running: false,
    productLabel: "",
    progress: 0,
    hint: "Chạy một bước pipeline hoặc dịch Legend để sinh sự kiện mới.",
  }
}

export function buildAppUpdaterNotificationItems(input: {
  available: AvailableAppUpdate | null
  status: UpdaterStatus
  error: string | null
  errorAtMs?: number | null
}): AppNotificationItem[] {
  const items: AppNotificationItem[] = []
  if (input.available) {
    const detectedAtMs = input.available.detectedAtMs
    items.push({
      id: `app:update:${input.available.version}`,
      source: "app",
      kind: "update",
      level: "warning",
      title: `Có bản ${input.available.version}`,
      description: `Bạn đang dùng ${input.available.currentVersion}. Cài sẽ khởi động lại app.`,
      timestamp: formatDateTime(detectedAtMs),
      occurredAtMs: detectedAtMs,
      sortRank: Number.MAX_SAFE_INTEGER,
      sourceLabel: "Ứng dụng",
      navigateTo: "about",
    })
  }
  if (input.status === "error" && input.error?.trim()) {
    const errorAtMs = input.errorAtMs ?? Date.now()
    items.push({
      id: "app:update-error",
      source: "app",
      kind: "update-error",
      level: "error",
      title: updaterErrorNotificationTitle(Boolean(input.available)),
      description: input.error.trim(),
      timestamp: formatDateTime(errorAtMs),
      occurredAtMs: errorAtMs,
      sortRank: Number.MAX_SAFE_INTEGER - 1,
      sourceLabel: "Ứng dụng",
      navigateTo: "about",
    })
  }
  return items
}
