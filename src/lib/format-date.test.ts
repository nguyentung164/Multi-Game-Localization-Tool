import { describe, expect, it } from "vitest"
import { formatDateTime, normalizeSyncChanges } from "@/lib/format-date"
describe("formatDateTime", () => {
  it("formats ISO UTC to local dd/mm/yyyy hh:mm:ss", () => {
    const formatted = formatDateTime("2026-08-09T19:59:56.097Z")
    expect(formatted).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/)

    const date = new Date("2026-08-09T19:59:56.097Z")
    const expected = [
      String(date.getDate()).padStart(2, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getFullYear()),
    ].join("/")
    const expectedTime = [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ].join(":")
    expect(formatted).toBe(`${expected} ${expectedTime}`)
  })

  it("keeps non-date labels unchanged", () => {
    expect(formatDateTime("Vừa xong")).toBe("Vừa xong")
    expect(formatDateTime("Chưa chạy")).toBe("Chưa chạy")
  })

  it("returns empty for nullish values", () => {
    expect(formatDateTime(null)).toBe("")
    expect(formatDateTime(undefined)).toBe("")
    expect(formatDateTime("")).toBe("")
  })
})

describe("normalizeSyncChanges", () => {
  it("derives text from after/before when missing", () => {
    const normalized = normalizeSyncChanges([
      {
        id: "1",
        kind: "add",
        file: "a.xml",
        tag: "LOC_A",
        after: "Hello",
      },
      {
        id: "2",
        kind: "delete",
        file: "a.xml",
        tag: "LOC_B",
        before: "Xin chao",
      },
    ])
    expect(normalized[0]?.text).toBe("Hello")
    expect(normalized[1]?.text).toBe("Xin chao")
  })
})
