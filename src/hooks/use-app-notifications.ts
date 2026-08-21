import { useCallback, useMemo, useState } from "react"
import type { JobEvent } from "@/lib/app-types"
import {
  buildNotificationRunningSummary,
  countUnreadAlerts,
  initializeNotificationReadAtMs,
  isAlertLevel,
  mergeNotificationFeeds,
  saveNotificationReadAtMs,
  selectNotificationDisplayItems,
  type AppNotificationItem,
} from "@/lib/app-notifications"
import type { LegendConsoleEvent } from "@/lib/legend-console"
import { GAME_NAVIGATION } from "@/lib/navigation"

const CIV7_PRODUCT_LABEL =
  GAME_NAVIGATION.find((group) => group.id === "civ7")?.productLabel ??
  "Sid Meier's Civilization VII"
const LEGEND_PRODUCT_LABEL =
  GAME_NAVIGATION.find((group) => group.id === "legend")?.productLabel ??
  "Legend of Heroes Three Kingdoms"

export interface UseAppNotificationsOptions {
  civ7Events: JobEvent[]
  legendEvents: LegendConsoleEvent[]
  extraItems?: AppNotificationItem[]
  civ7Running: boolean
  legendRunning: boolean
  legendJsonRunning?: boolean
  progress?: number
  notificationsEnabled: boolean
}

const EMPTY_NOTIFICATION_ITEMS: AppNotificationItem[] = []

export function useAppNotifications({
  civ7Events,
  legendEvents,
  extraItems = EMPTY_NOTIFICATION_ITEMS,
  civ7Running,
  legendRunning,
  legendJsonRunning = false,
  progress = 0,
  notificationsEnabled,
}: UseAppNotificationsOptions) {
  const [lastReadAtMs, setLastReadAtMs] = useState(initializeNotificationReadAtMs)

  const allItems = useMemo(
    () => mergeNotificationFeeds(civ7Events, legendEvents, extraItems),
    [civ7Events, extraItems, legendEvents],
  )

  const items = useMemo(
    () => selectNotificationDisplayItems(allItems, lastReadAtMs),
    [allItems, lastReadAtMs],
  )

  const unreadAlertCount = useMemo(
    () => countUnreadAlerts(allItems, lastReadAtMs),
    [allItems, lastReadAtMs],
  )

  const runningSummary = useMemo(
    () =>
      buildNotificationRunningSummary({
        civ7Running,
        legendRunning,
        legendJsonRunning,
        progress,
        civ7ProductLabel: CIV7_PRODUCT_LABEL,
        legendProductLabel: LEGEND_PRODUCT_LABEL,
      }),
    [civ7Running, legendJsonRunning, legendRunning, progress],
  )

  const markRead = useCallback(() => {
    const now = Date.now()
    saveNotificationReadAtMs(now)
    setLastReadAtMs(now)
  }, [])

  const isUnread = useCallback(
    (item: AppNotificationItem) =>
      isAlertLevel(item.level) && item.occurredAtMs > lastReadAtMs,
    [lastReadAtMs],
  )

  const hasEvents = allItems.length > 0

  return {
    items,
    allItems,
    unreadAlertCount,
    runningSummary,
    legendJsonRunning,
    notificationsEnabled,
    hasEvents,
    markRead,
    isUnread,
  }
}

export type AppNotificationsController = ReturnType<typeof useAppNotifications>
