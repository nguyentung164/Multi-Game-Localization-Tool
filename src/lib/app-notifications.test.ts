import { describe, expect, it } from "vitest"
import {
  compareNotificationItems,
  countUnreadAlerts,
  initializeNotificationReadAtMs,
  mapCiv7Notification,
  mapLegendNotification,
  mergeNotificationFeeds,
  notificationFeedKey,
  selectNotificationDisplayItems,
} from "@/lib/app-notifications"
import type { JobEvent } from "@/lib/app-types"
import { parseDisplayOrIsoTimestamp } from "@/lib/format-date"
import type { LegendConsoleEvent } from "@/lib/legend-console"

const civ7Event = (
  id: string,
  level: JobEvent["level"],
  timestamp: string,
  seq: number,
): JobEvent => ({
  id,
  seq,
  timestamp,
  level,
  title: `CIV7 ${id}`,
  description: "",
  step: "translate",
})

const legendEvent = (
  id: string,
  level: LegendConsoleEvent["level"],
  timestamp: string,
  seq: number,
): LegendConsoleEvent => ({
  id,
  seq,
  timestamp,
  level,
  title: `Legend ${id}`,
  description: "",
})

describe("parseDisplayOrIsoTimestamp", () => {
  it("parse chuỗi dd/mm/yyyy", () => {
    const parsed = parseDisplayOrIsoTimestamp("18/08/2026 21:00:00")
    expect(parsed).toBeGreaterThan(0)
  })

  it("parse time-only HH:mm:ss với ngày hôm nay", () => {
    const parsed = parseDisplayOrIsoTimestamp("00:33:48")
    expect(parsed).toBeGreaterThan(0)
  })
})

describe("notificationFeedKey", () => {
  it("tránh collision giữa CIV7 và Legend", () => {
    const merged = mergeNotificationFeeds(
      [civ7Event("job-1", "info", "18/08/2026 20:00:00", 1)],
      [legendEvent("job-1", "error", "18/08/2026 21:00:00", 1)],
    )
    expect(merged).toHaveLength(2)
    expect(merged.map((item) => item.id)).toEqual([
      notificationFeedKey("legend", "job-1"),
      notificationFeedKey("civ7", "job-1"),
    ])
  })
})

describe("mergeNotificationFeeds", () => {
  it("gộp và sắp xếp theo thời gian mới nhất", () => {
    const merged = mergeNotificationFeeds(
      [civ7Event("c1", "info", "18/08/2026 20:00:00", 1)],
      [legendEvent("l1", "success", "18/08/2026 21:00:00", 2)],
    )
    expect(merged.map((item) => item.id)).toEqual([
      notificationFeedKey("legend", "l1"),
      notificationFeedKey("civ7", "c1"),
    ])
    expect(merged[0]?.source).toBe("legend")
  })

  it("sort fallback theo sortRank khi timestamp không parse được", () => {
    const merged = mergeNotificationFeeds(
      [
        civ7Event("newer", "info", "legacy-ts-a", 1),
        civ7Event("older", "info", "legacy-ts-b", 2),
      ],
      [],
    )
    expect(merged[0]?.id).toBe(notificationFeedKey("civ7", "newer"))
    expect(merged[1]?.id).toBe(notificationFeedKey("civ7", "older"))
    expect(merged[0]!.sortRank).toBeGreaterThan(merged[1]!.sortRank)
  })
})

describe("compareNotificationItems", () => {
  it("ưu tiên occurredAtMs rồi sortRank", () => {
    const newer = mapCiv7Notification(
      civ7Event("a", "info", "18/08/2026 22:00:00", 1),
      2,
    )
    const older = mapLegendNotification(
      legendEvent("b", "info", "18/08/2026 20:00:00", 1),
      1,
    )
    expect(compareNotificationItems(newer, older)).toBeLessThan(0)
  })
})

describe("selectNotificationDisplayItems", () => {
  it("ưu tiên unread warning/error lên đầu", () => {
    const items = mergeNotificationFeeds(
      [
        civ7Event("info-1", "info", "18/08/2026 22:00:00", 3),
        civ7Event("warn-1", "warning", "18/08/2026 20:00:00", 1),
      ],
      [legendEvent("err-1", "error", "18/08/2026 21:00:00", 2)],
    )
    const display = selectNotificationDisplayItems(items, 0, 2)
    expect(display.map((item) => item.id)).toEqual([
      notificationFeedKey("legend", "err-1"),
      notificationFeedKey("civ7", "warn-1"),
    ])
  })

  it("badge đếm unread trên toàn feed", () => {
    const items = mergeNotificationFeeds(
      [civ7Event("warn-old", "warning", "18/08/2026 10:00:00", 1)],
      [legendEvent("err-new", "error", "18/08/2026 12:00:00", 2)],
    )
    expect(countUnreadAlerts(items, 0)).toBe(2)
    expect(countUnreadAlerts(items, Date.parse("2026-08-18T11:00:00"))).toBe(1)
  })
})

describe("initializeNotificationReadAtMs", () => {
  it("khởi tạo mốc đọc khi chưa có localStorage", () => {
    window.localStorage.removeItem("app-notification-read-at")
    const initialized = initializeNotificationReadAtMs()
    expect(initialized).toBeGreaterThan(0)
    expect(window.localStorage.getItem("app-notification-read-at")).toBe(
      String(initialized),
    )
  })
})

describe("mappers", () => {
  it("mapCiv7Notification gắn nhãn step và id namespaced", () => {
    const item = mapCiv7Notification(
      civ7Event("x", "success", "18/08/2026 12:00:00", 1),
      1,
    )
    expect(item.id).toBe(notificationFeedKey("civ7", "x"))
    expect(item.sourceLabel).toBe("CIV7 · Dịch")
    expect(item.navigateTo).toBe("pipeline")
    expect(item.step).toBe("translate")
  })

  it("mapLegendNotification gắn nhãn Legend", () => {
    const item = mapLegendNotification(
      legendEvent("x", "info", "18/08/2026 12:00:00", 1),
      1,
    )
    expect(item.id).toBe(notificationFeedKey("legend", "x"))
    expect(item.sourceLabel).toBe("Legend · Dịch")
    expect(item.navigateTo).toBe("legend-three-kingdoms")
  })
})
