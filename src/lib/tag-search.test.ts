import { describe, expect, it } from "vitest"
import type { QaIssue } from "@/lib/app-types"
import {
  createTextMatcher,
  filterTagSearchResult,
  findTextMatchRanges,
  replaceTextMatches,
  searchDemoTags,
  truncateText,
} from "@/lib/tag-search"

const sampleIssues: QaIssue[] = [
  {
    id: "qa-1",
    severity: "error",
    rule: "Mất token",
    file: "DLC/AbilityText.xml",
    tag: "LOC_ABILITY_TURTLE",
    source: "Gain Combat Strength.",
    target: "Nhận Sức mạnh Chiến đấu.",
  },
  {
    id: "qa-2",
    severity: "warning",
    rule: "Còn tiếng Anh",
    file: "Base/TutorialText.xml",
    tag: "LOC_TUTORIAL_01",
    source: "Select a Commander.",
    target: "Chọn một Chỉ huy.",
  },
]

describe("searchDemoTags", () => {
  it("finds matches by tag scope", () => {
    const result = searchDemoTags(sampleIssues, "LOC_ABILITY", "tag")
    expect(result.totalMatches).toBe(1)
    expect(result.matches[0]?.tag).toBe("LOC_ABILITY_TURTLE")
  })

  it("finds matches by english scope", () => {
    const result = searchDemoTags(sampleIssues, "commander", "english")
    expect(result.totalMatches).toBe(1)
    expect(result.matches[0]?.tag).toBe("LOC_TUTORIAL_01")
  })

  it("supports case-sensitive matching", () => {
    expect(
      searchDemoTags(sampleIssues, "commander", "english", 500, {
        caseSensitive: true,
        wholeWord: false,
      }).totalMatches,
    ).toBe(0)
    expect(
      searchDemoTags(sampleIssues, "Commander", "english", 500, {
        caseSensitive: true,
        wholeWord: false,
      }).totalMatches,
    ).toBe(1)
  })

  it("supports whole-word matching", () => {
    expect(
      searchDemoTags(sampleIssues, "Combat", "english", 500, {
        caseSensitive: false,
        wholeWord: true,
      }).totalMatches,
    ).toBe(1)
    expect(
      searchDemoTags(sampleIssues, "Com", "english", 500, {
        caseSensitive: false,
        wholeWord: true,
      }).totalMatches,
    ).toBe(0)
    expect(
      searchDemoTags(sampleIssues, "LOC_ABILITY", "tag", 500, {
        caseSensitive: false,
        wholeWord: true,
      }).totalMatches,
    ).toBe(0)
  })

  it("returns empty result for blank query", () => {
    const result = searchDemoTags(sampleIssues, "  ", "all")
    expect(result.totalMatches).toBe(0)
    expect(result.matches).toEqual([])
  })
})

describe("createTextMatcher", () => {
  it("matches consistently across multiple values without lastIndex drift", () => {
    const matcher = createTextMatcher("test", {
      caseSensitive: true,
      wholeWord: false,
    })
    expect(matcher("prefix test suffix")).toBe(true)
    expect(matcher("another test here")).toBe(true)
    expect(matcher("no match")).toBe(false)
  })

  it("respects case-sensitive matching", () => {
    const matcher = createTextMatcher("Commander", {
      caseSensitive: true,
      wholeWord: false,
    })
    expect(matcher("Select a Commander.")).toBe(true)
    expect(matcher("Select a commander.")).toBe(false)
  })

  it("respects whole-word matching", () => {
    const matcher = createTextMatcher("LOC", {
      caseSensitive: true,
      wholeWord: true,
    })
    expect(matcher("LOC LOC_ABILITY")).toBe(true)
    expect(matcher("LOC_ABILITY")).toBe(false)
  })

  it("respects Vietnamese case-sensitive matching", () => {
    const matcher = createTextMatcher("lãnh đục", {
      caseSensitive: true,
      wholeWord: false,
    })
    expect(matcher("Lãnh đục")).toBe(false)
    expect(matcher("lãnh đục")).toBe(true)
  })
})

describe("filterTagSearchResult", () => {
  it("drops case-insensitive-only matches when case-sensitive is enabled", () => {
    const filtered = filterTagSearchResult(
      {
        query: "lãnh đục",
        scope: "vietnamese",
        scannedFiles: 1,
        totalMatches: 2,
        truncated: false,
        matches: [
          {
            id: "1",
            file: "Text.xml",
            tag: "LOC_A",
            entryType: "Row",
            english: "Leader",
            vietnamese: "Lãnh đục",
          },
          {
            id: "2",
            file: "Text.xml",
            tag: "LOC_B",
            entryType: "Row",
            english: "Leader",
            vietnamese: "lãnh đục",
          },
        ],
      },
      { caseSensitive: true, wholeWord: false },
    )

    expect(filtered.totalMatches).toBe(1)
    expect(filtered.matches[0]?.vietnamese).toBe("lãnh đục")
  })
})

describe("truncateText", () => {
  it("keeps short strings unchanged", () => {
    expect(truncateText("abc")).toBe("abc")
  })

  it("truncates long strings", () => {
    expect(truncateText("a".repeat(150))).toHaveLength(120)
  })
})

describe("findTextMatchRanges", () => {
  it("finds every case-insensitive occurrence", () => {
    expect(
      findTextMatchRanges("Commander and commander", "commander", {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toEqual([
      { start: 0, end: 9 },
      { start: 14, end: 23 },
    ])
  })

  it("respects case-sensitive and whole-word options", () => {
    expect(
      findTextMatchRanges("LOC LOC_ABILITY loc", "LOC", {
        caseSensitive: true,
        wholeWord: true,
      }),
    ).toEqual([{ start: 0, end: 3 }])
  })

  it("handles Vietnamese word boundaries", () => {
    expect(
      findTextMatchRanges("Sức mạnh và sức", "sức", {
        caseSensitive: false,
        wholeWord: true,
      }),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 12, end: 15 },
    ])
  })
})

describe("replaceTextMatches", () => {
  it("replaces the first occurrence only when limited", () => {
    expect(
      replaceTextMatches(
        "Combat Strength and Combat",
        "Combat",
        "Battle",
        { caseSensitive: true, wholeWord: true },
        1,
      ),
    ).toEqual({ text: "Battle Strength and Combat", count: 1 })
  })

  it("replaces all occurrences", () => {
    expect(
      replaceTextMatches("sức mạnh và sức", "sức", "lực", {
        caseSensitive: false,
        wholeWord: true,
      }),
    ).toEqual({ text: "lực mạnh và lực", count: 2 })
  })
})
