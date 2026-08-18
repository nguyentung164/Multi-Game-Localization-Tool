import { describe, expect, it } from "vitest"
import {
  appendLegendConsoleEvent,
  legendConsoleEventLevel,
  shouldKeepLegendConsoleEvent,
  toLegendConsoleEvent,
} from "@/lib/legend-console"
import type { LegendJobEvent } from "@/lib/legend-types"

function event(
  type: LegendJobEvent["type"],
  payload: Record<string, unknown> = {},
): LegendJobEvent {
  return {
    protocolVersion: 1,
    jobId: "legend-job-1",
    seq: 4,
    timestamp: "2026-08-16T00:00:00Z",
    type,
    payload,
  }
}

describe("legend console", () => {
  it("ẩn progress và gắn mức lỗi/cảnh báo", () => {
    expect(shouldKeepLegendConsoleEvent("progress")).toBe(false)
    expect(shouldKeepLegendConsoleEvent("failed")).toBe(true)
    expect(legendConsoleEventLevel("failed")).toBe("error")
    expect(legendConsoleEventLevel("warning")).toBe("warning")
    expect(legendConsoleEventLevel("completed")).toBe("success")
  })

  it("lấy title/mô tả và bỏ payload nặng", () => {
    const item = toLegendConsoleEvent(
      event("failed", {
        message: "Không dịch được mục",
        code: "item_failed",
        diffs: [{ line: 1 }],
        qa: { blocking: true },
      }),
    )
    expect(item.level).toBe("error")
    expect(item.title).toBe("Không dịch được mục")
    expect(item.id).toBe("legend-job-1-4")
    expect(item.detail).toEqual({
      message: "Không dịch được mục",
      code: "item_failed",
    })
  })

  it("không thêm sự kiện trùng id", () => {
    const first = toLegendConsoleEvent(event("warning", { message: "Token" }))
    const next = appendLegendConsoleEvent(
      appendLegendConsoleEvent([], first),
      first,
    )
    expect(next).toHaveLength(1)
  })
})
