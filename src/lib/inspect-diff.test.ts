import { describe, expect, it } from "vitest"
import {
  countInspectByStatus,
  filterInspectDiffs,
  formatInspectDeltaLabel,
} from "@/lib/inspect-diff"
import type { InspectDiff } from "@/lib/app-types"

const sampleDiffs: InspectDiff[] = [
  {
    id: "1",
    file: "Base/Text.xml",
    status: "english-only",
  },
  {
    id: "2",
    file: "DLC/Text.xml",
    status: "different",
    missingInVietnamese: [{ type: "Row", tag: "LOC_A", count: 1 }],
  },
]

describe("inspect-diff helpers", () => {
  it("filters by status and query", () => {
    const filtered = filterInspectDiffs(sampleDiffs, "dlc", "different")
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.id).toBe("2")
  })

  it("counts by status", () => {
    const counts = countInspectByStatus(sampleDiffs)
    expect(counts.all).toBe(2)
    expect(counts["english-only"]).toBe(1)
    expect(counts.different).toBe(1)
  })

  it("formats xml and vtt deltas", () => {
    expect(formatInspectDeltaLabel({ type: "Row", tag: "LOC_X", count: 2 })).toBe(
      "LOC_X ×2",
    )
    expect(
      formatInspectDeltaLabel({
        timing: "00:01:00.000 --> 00:01:05.000",
        count: 1,
      }),
    ).toContain("00:01:00")
  })
})
