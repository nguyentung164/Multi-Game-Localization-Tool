import { describe, expect, it } from "vitest"
import {
  hasHan,
  legendDiffsWithHan,
  legendEffectiveTarget,
} from "@/lib/legend-han"
import type { LegendTranslationDiff } from "@/lib/legend-types"

const diff = (
  overrides: Partial<LegendTranslationDiff> = {},
): LegendTranslationDiff => ({
  lineNumber: 1,
  source: "西川",
  before: "Cũ",
  after: "Tây Xuyên",
  effectiveTarget: "Tây Xuyên",
  effectiveAfter: "Tây Xuyên",
  selected: true,
  status: "pending",
  ...overrides,
})

describe("legend han filter", () => {
  it("nhận diện chữ Hán lẫn trong tiếng Việt", () => {
    expect(hasHan("Tây Xuyên")).toBe(false)
    expect(hasHan("Tây X川")).toBe(true)
    expect(hasHan("")).toBe(false)
  })

  it("lọc theo bản hiệu lực, kể cả dòng bỏ chọn", () => {
    const rows = [
      diff({ lineNumber: 1, after: "Tây Xuyên" }),
      diff({
        lineNumber: 2,
        after: "Tây Xuyên",
        editedAfter: "Tây X川",
      }),
      diff({
        lineNumber: 3,
        selected: false,
        before: "旧州",
        after: "Tây Xuyên",
      }),
    ]
    expect(legendEffectiveTarget(rows[1]!)).toBe("Tây X川")
    expect(legendDiffsWithHan(rows).map((row) => row.lineNumber)).toEqual([
      2, 3,
    ])
  })

  it("bỏ qua editedAfter null từ JSON Python", () => {
    const row = diff({
      after: "Tây X川",
      effectiveTarget: "Tây X川",
      editedAfter: null as unknown as undefined,
    })
    expect(legendEffectiveTarget(row)).toBe("Tây X川")
    expect(legendDiffsWithHan([row]).map((item) => item.lineNumber)).toEqual([
      1,
    ])
  })
})
