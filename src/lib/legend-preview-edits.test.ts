import { describe, expect, it } from "vitest"
import {
  EMPTY_LEGEND_SELECTION_MASK,
  applyLegendTermSuggestion,
  applyLegendTermSuggestions,
  collectLegendPreviewEdits,
  collectLegendTermSuggestions,
  hasPendingLegendTextEdits,
  isLegendPreviewEditDirty,
  legendPreviewSessionKey,
  legendSelectedCount,
  legendSelectedLineNumbers,
  legendSelectedSuggestionStats,
  legendTermSuggestionApplies,
  mergeLegendPreviewEdits,
  overlayLegendDiff,
  pushLegendSelection,
  resolveLegendSelected,
  setLegendRowSelected,
  unsavedLegendTextLines,
} from "@/lib/legend-preview-edits"
import type { LegendTranslationDiff } from "@/lib/legend-types"

const diff: LegendTranslationDiff = {
  lineNumber: 12,
  source: "黄巾",
  before: "Cũ",
  after: "Mới",
  effectiveTarget: "Mới",
  effectiveAfter: "Mới",
  selected: true,
  status: "pending",
}

describe("legend preview edits", () => {
  it("chỉ đánh dấu dirty khi chọn hoặc bản sửa đổi", () => {
    expect(
      isLegendPreviewEditDirty(diff, {
        lineNumber: 12,
        selected: true,
      }),
    ).toBe(false)
    expect(
      isLegendPreviewEditDirty(diff, {
        lineNumber: 12,
        selected: false,
      }),
    ).toBe(true)
    expect(
      isLegendPreviewEditDirty(diff, {
        lineNumber: 12,
        selected: true,
        editedAfter: "Sửa",
      }),
    ).toBe(true)
  })

  it("overlay bản sửa lên diff để xem trước khi lưu", () => {
    const [merged] = mergeLegendPreviewEdits([diff], {
      12: { lineNumber: 12, selected: true, editedAfter: "Sửa" },
    })
    expect(merged?.editedAfter).toBe("Sửa")
    expect(merged?.effectiveAfter).toBe("Sửa")
    expect(merged?.status).toBe("edited")
  })

  it("chỉ chặn dịch lại khi có sửa chữ, không phải khi chỉ đổi chọn", () => {
    expect(
      hasPendingLegendTextEdits([diff], {
        12: { lineNumber: 12, selected: false },
      }),
    ).toBe(false)
    expect(
      hasPendingLegendTextEdits([diff], {
        12: { lineNumber: 12, selected: true, editedAfter: "Sửa" },
      }),
    ).toBe(true)
    expect(
      unsavedLegendTextLines([diff], {
        12: { lineNumber: 12, selected: true, editedAfter: "Sửa" },
      }).has(12),
    ).toBe(true)
    expect(
      unsavedLegendTextLines([diff], {
        12: { lineNumber: 12, selected: false },
      }).has(12),
    ).toBe(false)
    expect(
      unsavedLegendTextLines([], {
        99: { lineNumber: 99, selected: true, editedAfter: "Sửa trang khác" },
      }).has(99),
    ).toBe(true)
    expect(
      hasPendingLegendTextEdits([], {
        99: { lineNumber: 99, selected: true, editedAfter: "Sửa trang khác" },
      }),
    ).toBe(true)
  })

  it("chọn/bỏ chọn hàng loạt không clone từng dòng", () => {
    const rows = [diff, { ...diff, lineNumber: 13, selected: true }]
    const cleared = pushLegendSelection(
      EMPTY_LEGEND_SELECTION_MASK,
      rows,
      () => false,
    )
    expect(resolveLegendSelected(rows[0]!, cleared)).toBe(false)
    expect(resolveLegendSelected(rows[1]!, cleared)).toBe(false)
    const one = setLegendRowSelected(cleared, 13, true)
    expect(resolveLegendSelected(rows[0]!, one)).toBe(false)
    expect(resolveLegendSelected(rows[1]!, one)).toBe(true)
    const overlaid = overlayLegendDiff(rows[0]!, undefined, one)
    expect(overlaid.selected).toBe(false)
    expect(overlaid.effectiveAfter).toBe("Cũ")
    expect(
      collectLegendPreviewEdits(rows, {}, one).map((edit) => edit.lineNumber),
    ).toEqual([12])
    expect(legendSelectedCount(2, one)).toBe(1)
  })

  it("đếm dòng đã chọn cả ngoài trang hiện tại qua mask", () => {
    const page = [diff]
    const cleared = pushLegendSelection(
      EMPTY_LEGEND_SELECTION_MASK,
      [
        diff,
        { lineNumber: 99, selected: true },
        { lineNumber: 100, selected: true },
      ],
      () => false,
    )
    expect(legendSelectedLineNumbers(page, cleared).sort((a, b) => a - b)).toEqual(
      [],
    )
    const selected = pushLegendSelection(cleared, [{ lineNumber: 99, selected: true }], () => true)
    expect(legendSelectedLineNumbers(page, selected)).toEqual([99])
  })

  it("giữ cùng phiên khi chỉ đổi previewId/revision", () => {
    const session = {
      sourceFingerprint: "src-1",
      mode: "full" as const,
      createdAt: "2026-08-17T00:00:00Z",
    }
    expect(legendPreviewSessionKey(session)).toBe(
      legendPreviewSessionKey({ ...session }),
    )
    expect(legendPreviewSessionKey(null)).toBe("")
    expect(
      legendPreviewSessionKey({
        ...session,
        createdAt: "2026-08-17T01:00:00Z",
      }),
    ).not.toBe(legendPreviewSessionKey(session))
  })

  it("thay chữ Hán trong ô Sau bằng bản Việt đề xuất", () => {
    expect(applyLegendTermSuggestion("theo 刘备 đánh", "刘备", "Lưu Bị")).toBe(
      "theo Lưu Bị đánh",
    )
    expect(applyLegendTermSuggestion("theo Lưu Bi đánh", "刘备", "Lưu Bị")).toBe(
      "theo Lưu Bi đánh",
    )
    expect(
      applyLegendTermSuggestion("theo Lưu Bi đánh", "刘备", "Lưu Bị", "Lưu Bi"),
    ).toBe("theo Lưu Bị đánh")
    expect(
      applyLegendTermSuggestion(
        "nhậm chức cho Lưu Biện. Sau khi Lưu Biện bệnh mất",
        "刘备",
        "Lưu Bị",
        "Lưu Biện",
      ),
    ).toBe("nhậm chức cho Lưu Bị. Sau khi Lưu Bị bệnh mất")
    expect(legendTermSuggestionApplies("theo 刘备 đánh", { source: "刘备", reading: "Lưu Bị" })).toBe(
      true,
    )
    expect(
      legendTermSuggestionApplies("Chém", { source: "[瞬]", reading: "[Tức]" }),
    ).toBe(false)
    expect(
      legendTermSuggestionApplies("theo Lưu Biện đánh", {
        source: "刘备",
        reading: "Lưu Bị",
        replace: "Lưu Biện",
      }),
    ).toBe(true)
    expect(applyLegendTermSuggestion("   ", "刘备", "Lưu Bị")).toBe("Lưu Bị")
    expect(applyLegendTermSuggestion("", "[瞬]", "[Tức]")).toBe("[Tức]")
    expect(
      legendTermSuggestionApplies("   ", { source: "刘备", reading: "Lưu Bị" }),
    ).toBe(true)
  })

  it("áp hàng loạt đề xuất, cụm dài trước, không đoán ô trống khi có nhiều gợi ý", () => {
    expect(
      collectLegendTermSuggestions([
        {
          suggestions: [
            { source: "刘备", reading: "Lưu Bị" },
            { source: "刘备", reading: "Lưu Bị" },
          ],
        },
        { suggestions: [{ source: "关羽", reading: "Quan Vũ" }] },
      ]),
    ).toEqual([
      { source: "刘备", reading: "Lưu Bị" },
      { source: "关羽", reading: "Quan Vũ" },
    ])
    expect(
      applyLegendTermSuggestions("theo 刘备 và 关羽", [
        { source: "关羽", reading: "Quan Vũ" },
        { source: "刘备", reading: "Lưu Bị" },
      ]).text,
    ).toBe("theo Lưu Bị và Quan Vũ")
    expect(
      applyLegendTermSuggestions("刘备军 đến", [
        { source: "刘备", reading: "Lưu Bị" },
        { source: "刘备军", reading: "quân Lưu Bị" },
      ]),
    ).toEqual({
      text: "quân Lưu Bị đến",
      applied: [{ source: "刘备军", reading: "quân Lưu Bị" }],
    })
    expect(
      applyLegendTermSuggestions("   ", [{ source: "刘备", reading: "Lưu Bị" }]),
    ).toEqual({
      text: "Lưu Bị",
      applied: [{ source: "刘备", reading: "Lưu Bị" }],
    })
    expect(
      applyLegendTermSuggestions("", [
        { source: "刘备", reading: "Lưu Bị" },
        { source: "关羽", reading: "Quan Vũ" },
      ]),
    ).toEqual({ text: "", applied: [] })
    expect(
      applyLegendTermSuggestions("nhậm chức cho Lưu Biện", [
        { source: "刘备", reading: "Lưu Bị", replace: "Lưu Biện" },
      ]),
    ).toEqual({
      text: "nhậm chức cho Lưu Bị",
      applied: [{ source: "刘备", reading: "Lưu Bị", replace: "Lưu Biện" }],
    })
    expect(
      applyLegendTermSuggestions("đã Việt hóa", [
        { source: "刘备", reading: "Lưu Bị" },
      ]),
    ).toEqual({ text: "đã Việt hóa", applied: [] })
  })

  it("đếm đề xuất trên dòng đang tick, kể cả khi ô Sau không còn chữ Hán", () => {
    const row: LegendTranslationDiff = {
      ...diff,
      lineNumber: 9128,
      source: "选择 <诸侯讨董>",
      before: "OLD",
      after: "Chọn <Chư Hầu Thảo Đổng>",
      effectiveAfter: "Chọn <Chư Hầu Thảo Đổng>",
      selected: true,
    }
    const issues = new Map([
      [
        9128,
        [
          {
            suggestions: [
              { source: "<诸侯讨董>", reading: "<Chư Hầu Thảo Đổng>" },
            ],
          },
        ],
      ],
    ])
    const leftover: LegendTranslationDiff = {
      ...row,
      lineNumber: 21,
      after: "giới thiệu 雪莹",
      effectiveAfter: "giới thiệu 雪莹",
    }
    issues.set(21, [
      { suggestions: [{ source: "雪莹", reading: "Tuyết Oánh" }] },
    ])
    expect(
      legendSelectedSuggestionStats(
        [row, leftover],
        {},
        EMPTY_LEGEND_SELECTION_MASK,
        issues,
      ),
    ).toEqual({
      lines: 1,
      replacements: 1,
      selectedWithSuggestions: 2,
    })
    const unchecked = setLegendRowSelected(
      EMPTY_LEGEND_SELECTION_MASK,
      21,
      false,
    )
    expect(
      legendSelectedSuggestionStats([row, leftover], {}, unchecked, issues)
        .selectedWithSuggestions,
    ).toBe(1)
  })
})
