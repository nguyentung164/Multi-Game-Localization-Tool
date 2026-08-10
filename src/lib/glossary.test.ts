import { describe, expect, it } from "vitest"
import { entriesToRows, rowsToEntries, validateGlossaryRows } from "@/lib/glossary"

describe("glossary helpers", () => {
  it("converts entries and rows", () => {
    const rows = entriesToRows({ Alpha: "A", Beta: "B" })
    expect(rows).toHaveLength(2)
    expect(rowsToEntries(rows)).toEqual({ Alpha: "A", Beta: "B" })
  })

  it("validates empty and duplicate keys", () => {
    expect(
      validateGlossaryRows([
        { id: "1", key: "", value: "x" },
        { id: "2", key: "Dup", value: "a" },
        { id: "3", key: "dup", value: "b" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("EN trống"),
        expect.stringContaining("trùng"),
      ]),
    )
  })
})
