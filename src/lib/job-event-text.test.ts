import { describe, expect, it } from "vitest"
import { resolveJobEventText } from "@/lib/job-event-text"

describe("resolveJobEventText", () => {
  it("diễn giải warning endpoint-switch", () => {
    const result = resolveJobEventText("warning", {
      phase: "endpoint-switch",
      reason: "HTTP 429",
      keyIndex: 2,
      keyCount: 3,
      model: "gemini-3.5-flash-lite",
    })
    expect(result.title).toBe("Đổi model hoặc API key")
    expect(result.description).toContain("HTTP 429")
    expect(result.description).toContain("Key 2/3")
  })

  it("diễn giải spare swap khi hết quota ngày", () => {
    const result = resolveJobEventText("warning", {
      phase: "endpoint-switch",
      switchKind: "spare",
      reason: "Daily quota",
      fromKeyIndex: 2,
      keyIndex: 5,
      model: "gemini-3.5-flash-lite",
    })
    expect(result.title).toBe("Key 2 hết quota ngày · chuyển sang Key 5")
    expect(result.description).toContain("Daily quota")
  })

  it("diễn giải warning retry kèm key", () => {
    const result = resolveJobEventText("warning", {
      phase: "retry",
      attempt: 2,
      waitSeconds: 3,
      keyIndex: 1,
      keyCount: 4,
    })
    expect(result.title).toBe("Đang thử lại API")
    expect(result.description).toContain("Key 1/4")
  })

  it("diễn giải warning qa-summary", () => {
    const result = resolveJobEventText("warning", {
      phase: "qa-summary",
      issueCount: 5,
      issueCounts: { untranslated: 3, "missing-token": 2 },
    })
    expect(result.title).toBe("QA phát hiện cảnh báo")
    expect(result.description).toContain("5 vấn đề")
  })
})
