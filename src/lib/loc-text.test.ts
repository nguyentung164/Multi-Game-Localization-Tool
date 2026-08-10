import { describe, expect, it } from "vitest"
import { formatLocDisplayText } from "@/lib/loc-text"

describe("formatLocDisplayText", () => {
  it("gộp xuống dòng và tab sau [n] thành khoảng trắng", () => {
    const raw =
      "As Yi Sun-sin, access a new Exploration Dedication:[n]\n\t\t\t+3 Combat Strength for your Naval Units, -10% Influence"
    expect(formatLocDisplayText(raw)).toBe(
      "As Yi Sun-sin, access a new Exploration Dedication:[n] +3 Combat Strength for your Naval Units, -10% Influence",
    )
  })

  it("giữ text một dòng không đổi", () => {
    const raw =
      "As Yi Sun-sin, access a new Exploration Dedication:[n] +3 Combat Strength for your Naval Units, -10% Influence"
    expect(formatLocDisplayText(raw)).toBe(raw)
  })

  it("xử lý chuỗi rỗng", () => {
    expect(formatLocDisplayText("")).toBe("")
  })
})
