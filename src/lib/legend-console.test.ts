import { describe, expect, it } from "vitest"
import {
  isProgressMirrorLog,
  shouldKeepLegendConsoleEvent,
} from "@/lib/legend-console"

describe("isProgressMirrorLog", () => {
  it("detects translate heartbeat mirror logs", () => {
    expect(
      isProgressMirrorLog({
        title: "Đang dịch · 1 luồng",
        description: "80/132 mục · 1/4 luồng",
      }),
    ).toBe(true)
  })

  it("ignores deploy skip logs", () => {
    expect(
      isProgressMirrorLog({
        message: "Bỏ qua (không có trong game): foo.xml",
      }),
    ).toBe(false)
  })
})

describe("shouldKeepLegendConsoleEvent", () => {
  it("drops progress events", () => {
    expect(shouldKeepLegendConsoleEvent("progress", { processed: 1 })).toBe(
      false,
    )
  })

  it("drops progress mirror log events", () => {
    expect(
      shouldKeepLegendConsoleEvent("log", {
        title: "Đang dịch · 2 luồng",
        description: "40/132 mục · 2/4 luồng",
      }),
    ).toBe(false)
  })

  it("keeps warnings and lifecycle events", () => {
    expect(
      shouldKeepLegendConsoleEvent("warning", {
        title: "Đang thử lại API",
        description: "Lần 2",
      }),
    ).toBe(true)
    expect(shouldKeepLegendConsoleEvent("started", {})).toBe(true)
    expect(shouldKeepLegendConsoleEvent("completed", {})).toBe(true)
  })

  it("keeps Civ7 file milestone logs", () => {
    expect(
      shouldKeepLegendConsoleEvent("log", {
        title: "Thu thập 3/10",
        description: "Some/File.xml",
      }),
    ).toBe(true)
  })
})
