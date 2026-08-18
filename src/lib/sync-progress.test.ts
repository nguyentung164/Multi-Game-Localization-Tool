import { describe, expect, it } from "vitest"
import {
  formatSyncProgressLabel,
  syncProgressPercent,
} from "@/lib/sync-progress"

describe("sync-progress", () => {
  it("formats file scan progress", () => {
    const label = formatSyncProgressLabel({
      command: "list-tags",
      step: "list-tags",
      payload: { processed: 12, total: 45, file: "UI_Text.xml" },
    })
    expect(label).toContain("12")
    expect(label).toContain("45")
    expect(label).toContain("UI_Text.xml")
  })

  it("shows basename instead of full path", () => {
    const label = formatSyncProgressLabel({
      command: "list-tags",
      step: "list-tags",
      payload: {
        processed: 3,
        total: 45,
        file: "B:\\SteamLibrary\\steamapps\\common\\CIV7\\Localization\\UI_Text.xml",
      },
    })
    expect(label).toContain("UI_Text.xml")
    expect(label).not.toContain("SteamLibrary")
  })

  it("prefers explicit progress percent from engine", () => {
    const percent = syncProgressPercent({
      command: "list-tags",
      step: "list-tags",
      payload: { processed: 540, total: 1072, progress: 50 },
    })
    expect(percent).toBe(50)
  })

  it("formats replace progress percent", () => {
    const percent = syncProgressPercent({
      command: "replace-tags",
      step: "replace-tags",
      payload: { replaced: 25, replaceTotal: 100 },
    })
    expect(percent).toBe(25)
  })

  it("returns null when processed exceeds total (mixed units)", () => {
    const percent = syncProgressPercent({
      command: "list-tags",
      step: "list-tags",
      payload: { processed: 34955, total: 1072 },
    })
    expect(percent).toBeNull()
  })

  it("derives percent from valid processed/total when progress missing", () => {
    const percent = syncProgressPercent({
      command: "list-tags",
      step: "list-tags",
      payload: { processed: 536, total: 1072 },
    })
    expect(percent).toBe(50)
  })
})
