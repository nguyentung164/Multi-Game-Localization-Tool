import { describe, expect, it } from "vitest"
import {
  buildAppUpdaterNotificationItems,
  buildNotificationRunningSummary,
  mapLegendJsonNotification,
  mergeNotificationFeeds,
} from "@/lib/app-notifications"

describe("buildAppUpdaterNotificationItems", () => {
  it("adds a warning item when an update is available", () => {
    const items = buildAppUpdaterNotificationItems({
      available: {
        version: "1.3.0",
        currentVersion: "1.2.1",
        body: "",
        detectedAtMs: 1_700_000_000_000,
      },
      status: "available",
      error: null,
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("update")
    expect(items[0]?.level).toBe("warning")
    expect(items[0]?.title).toContain("1.3.0")
  })

  it("adds an error item when auto-check fails", () => {
    const items = buildAppUpdaterNotificationItems({
      available: null,
      status: "error",
      error: "network timeout",
      errorAtMs: 1_700_000_000_000,
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("update-error")
    expect(items[0]?.title).toBe("Không kiểm tra được bản cập nhật")
  })

  it("uses install-error title when an update was already found", () => {
    const items = buildAppUpdaterNotificationItems({
      available: {
        version: "1.3.0",
        currentVersion: "1.2.1",
        body: "",
        detectedAtMs: 1_700_000_000_000,
      },
      status: "error",
      error: "signature failed",
      errorAtMs: 1_700_000_000_000,
    })
    expect(items.some((item) => item.kind === "update-error")).toBe(true)
    expect(
      items.find((item) => item.kind === "update-error")?.title,
    ).toBe("Không cài được bản cập nhật")
  })
})

describe("mergeNotificationFeeds", () => {
  it("includes app updater extras in the feed", () => {
    const extras = buildAppUpdaterNotificationItems({
      available: {
        version: "1.3.0",
        currentVersion: "1.2.1",
        body: "",
        detectedAtMs: 1_700_000_000_000,
      },
      status: "available",
      error: null,
    })
    const merged = mergeNotificationFeeds([], [], extras)
    expect(merged.map((item) => item.id)).toEqual(["app:update:1.3.0"])
  })
})

describe("buildNotificationRunningSummary", () => {
  const labels = {
    civ7ProductLabel: "CIV7",
    legendProductLabel: "Legend",
  }

  it("prefers CIV7, then Legend TK, then JSON Pipeline", () => {
    expect(
      buildNotificationRunningSummary({
        civ7Running: true,
        legendRunning: true,
        legendJsonRunning: true,
        progress: 10,
        ...labels,
      }).hint,
    ).toContain("footer Pipeline")

    expect(
      buildNotificationRunningSummary({
        civ7Running: false,
        legendRunning: true,
        legendJsonRunning: true,
        progress: 20,
        ...labels,
      }).hint,
    ).toContain("Dịch Legend")

    const json = buildNotificationRunningSummary({
      civ7Running: false,
      legendRunning: false,
      legendJsonRunning: true,
      progress: 30,
      ...labels,
    })
    expect(json.hint).toContain("JSON Pipeline")
    expect(json.progress).toBe(30)
  })
})

describe("mapLegendJsonNotification", () => {
  it("routes JSON pipeline events to the JSON Pipeline page", () => {
    const item = mapLegendJsonNotification(
      {
        id: "job-1",
        seq: 1,
        timestamp: "21/08/2026 00:00:00",
        level: "success",
        title: "Hoàn tất dịch JSON",
        description: "Đã lưu target vào SQLite incremental.",
      },
      1,
    )
    expect(item.navigateTo).toBe("legend-json-pipeline")
    expect(item.sourceLabel).toBe("Legend · JSON Pipeline")
    expect(item.id).toContain("json:job-1")
  })
})
