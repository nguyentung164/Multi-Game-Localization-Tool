import { describe, expect, it } from "vitest"
import {
  filterLegendSearchResult,
  searchLegendEntries,
} from "@/lib/legend-search"
import type { LegendFileEntry } from "@/lib/legend-types"

const entries: LegendFileEntry[] = [
  { lineNumber: 1, source: "刘备", currentTarget: "Lưu Bị", kind: "entry" },
  {
    lineNumber: 2,
    source: "白马义从",
    currentTarget: "Bạch Mã Nghĩa Tòng",
    kind: "entry",
  },
  { lineNumber: 3, source: "黄巾", currentTarget: "Khăn vàng", kind: "entry" },
]

describe("legend search", () => {
  it("tìm theo tiếng Trung hoặc tiếng Việt", () => {
    const chinese = searchLegendEntries(
      entries,
      "刘备",
      "chinese",
      "demo.txt",
      { caseSensitive: false, wholeWord: false },
    )
    expect(chinese.matches.map((item) => item.lineNumber)).toEqual([1])

    const vietnamese = searchLegendEntries(
      entries,
      "khăn",
      "vietnamese",
      "demo.txt",
      { caseSensitive: false, wholeWord: false },
    )
    expect(vietnamese.matches.map((item) => item.lineNumber)).toEqual([3])
  })

  it("phạm vi all khớp số dòng", () => {
    const result = searchLegendEntries(entries, "2", "all", "demo.txt", {
      caseSensitive: false,
      wholeWord: false,
    })
    expect(result.matches.map((item) => item.lineNumber)).toEqual([2])
  })

  it("lọc lại kết quả theo whole word", () => {
    const result = searchLegendEntries(entries, "Lưu Bị", "vietnamese", "demo.txt", {
      caseSensitive: false,
      wholeWord: false,
    })
    const filtered = filterLegendSearchResult(result, {
      caseSensitive: false,
      wholeWord: true,
    })
    expect(filtered.matches).toHaveLength(1)
  })
})
