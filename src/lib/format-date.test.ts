import { describe, expect, it } from "vitest"
import { parseDisplayOrIsoTimestamp } from "@/lib/format-date"

describe("parseDisplayOrIsoTimestamp edge cases", () => {
  it("trả 0 với chuỗi rỗng", () => {
    expect(parseDisplayOrIsoTimestamp("")).toBe(0)
  })

  it("parse ISO", () => {
    expect(parseDisplayOrIsoTimestamp("2026-08-18T12:00:00.000Z")).toBeGreaterThan(
      0,
    )
  })

  it("parse time-only demo timestamp", () => {
    expect(parseDisplayOrIsoTimestamp("00:33:48")).toBeGreaterThan(0)
  })
})
