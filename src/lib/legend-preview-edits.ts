import type {
  LegendPreviewEdit,
  LegendQaIssue,
  LegendTermSuggestion,
  LegendTranslationDiff,
  LegendTranslationPreview,
} from "@/lib/legend-types"

/** Khóa phiên preview: không đổi khi dịch lại/sửa dòng (previewId/revision thì có). */
export function legendPreviewSessionKey(
  preview:
    | Pick<LegendTranslationPreview, "sourceFingerprint" | "mode" | "createdAt">
    | null
    | undefined,
): string {
  if (!preview) return ""
  return `${preview.sourceFingerprint}:${preview.mode}:${preview.createdAt}`
}

export function isLegendPreviewEditDirty(
  diff: LegendTranslationDiff,
  edit: LegendPreviewEdit,
): boolean {
  return (
    edit.selected !== diff.selected ||
    (edit.editedAfter ?? undefined) !== (diff.editedAfter ?? undefined)
  )
}

export function mergeLegendPreviewEdits(
  diffs: LegendTranslationDiff[],
  edits: Record<number, LegendPreviewEdit>,
): LegendTranslationDiff[] {
  if (Object.keys(edits).length === 0) return diffs
  return diffs.map((diff) => {
    const edit = edits[diff.lineNumber]
    if (!edit) return diff
    const selected = edit.selected
    const editedAfter = edit.editedAfter
    const effective = selected ? (editedAfter ?? diff.after) : diff.before
    return {
      ...diff,
      selected,
      editedAfter,
      effectiveTarget: effective,
      effectiveAfter: effective,
      status: !selected ? "rejected" : editedAfter ? "edited" : diff.status,
    }
  })
}

export function pendingLegendPreviewEdits(
  edits: Record<number, LegendPreviewEdit>,
): LegendPreviewEdit[] {
  return Object.values(edits)
}

export function unsavedLegendTextLines(
  diffs: LegendTranslationDiff[],
  edits: Record<number, LegendPreviewEdit>,
): Set<number> {
  const lines = new Set<number>()
  if (Object.keys(edits).length === 0) return lines
  const byLine = new Map(diffs.map((diff) => [diff.lineNumber, diff]))
  for (const edit of Object.values(edits)) {
    const diff = byLine.get(edit.lineNumber)
    if ((edit.editedAfter ?? undefined) !== (diff?.editedAfter ?? undefined)) {
      lines.add(edit.lineNumber)
    }
  }
  return lines
}

export function hasPendingLegendTextEdits(
  diffs: LegendTranslationDiff[],
  edits: Record<number, LegendPreviewEdit>,
): boolean {
  return unsavedLegendTextLines(diffs, edits).size > 0
}

export type LegendSelectionBulk = {
  selected: boolean
  lines: Set<number>
}

export type LegendSelectionMask = {
  bulks: LegendSelectionBulk[]
  extras: Map<number, boolean>
  originals: Map<number, boolean>
}

export const EMPTY_LEGEND_SELECTION_MASK: LegendSelectionMask = {
  bulks: [],
  extras: new Map(),
  originals: new Map(),
}

export function isLegendSelectionMaskEmpty(mask: LegendSelectionMask): boolean {
  return mask.bulks.length === 0 && mask.extras.size === 0
}

export function resolveLegendSelected(
  diff: Pick<LegendTranslationDiff, "lineNumber" | "selected">,
  mask: LegendSelectionMask,
): boolean {
  const extra = mask.extras.get(diff.lineNumber)
  if (extra !== undefined) return extra
  for (let index = mask.bulks.length - 1; index >= 0; index -= 1) {
    const bulk = mask.bulks[index]
    if (bulk?.lines.has(diff.lineNumber)) return bulk.selected
  }
  return diff.selected
}

export function pushLegendSelection(
  mask: LegendSelectionMask,
  scope: Pick<LegendTranslationDiff, "lineNumber" | "selected">[],
  selectedFor: (row: { lineNumber: number; selected: boolean }) => boolean,
): LegendSelectionMask {
  if (scope.length === 0) return mask
  const extras = new Map(mask.extras)
  const originals = new Map(mask.originals)
  const trueLines = new Set<number>()
  const falseLines = new Set<number>()
  for (const row of scope) {
    extras.delete(row.lineNumber)
    if (!originals.has(row.lineNumber)) {
      originals.set(row.lineNumber, row.selected)
    }
    if (
      selectedFor({
        lineNumber: row.lineNumber,
        selected: resolveLegendSelected(row, mask),
      })
    ) {
      trueLines.add(row.lineNumber)
    } else {
      falseLines.add(row.lineNumber)
    }
  }
  const bulks = mask.bulks.slice()
  if (falseLines.size === 0) {
    bulks.push({ selected: true, lines: trueLines })
  } else if (trueLines.size === 0) {
    bulks.push({ selected: false, lines: falseLines })
  } else {
    bulks.push({ selected: false, lines: falseLines })
    bulks.push({ selected: true, lines: trueLines })
  }
  return { bulks, extras, originals }
}

export function setLegendRowSelected(
  mask: LegendSelectionMask,
  lineNumber: number,
  selected: boolean,
  original = mask.originals.get(lineNumber) ?? selected,
): LegendSelectionMask {
  const extras = new Map(mask.extras)
  extras.set(lineNumber, selected)
  const originals = new Map(mask.originals)
  if (!originals.has(lineNumber)) originals.set(lineNumber, original)
  return { bulks: mask.bulks, extras, originals }
}

export function overlayLegendDiff(
  diff: LegendTranslationDiff,
  edit: LegendPreviewEdit | undefined,
  mask: LegendSelectionMask,
): LegendTranslationDiff {
  const selected = resolveLegendSelected(diff, mask)
  const editedAfter = edit?.editedAfter ?? diff.editedAfter
  if (
    selected === diff.selected &&
    (editedAfter ?? undefined) === (diff.editedAfter ?? undefined)
  ) {
    return diff
  }
  const effective = selected ? (editedAfter ?? diff.after) : diff.before
  return {
    ...diff,
    selected,
    editedAfter,
    effectiveTarget: effective,
    effectiveAfter: effective,
    status: !selected ? "rejected" : editedAfter ? "edited" : diff.status,
  }
}

export function collectLegendPreviewEdits(
  diffs: LegendTranslationDiff[],
  pendingEdits: Record<number, LegendPreviewEdit>,
  mask: LegendSelectionMask,
): LegendPreviewEdit[] {
  const byLine = new Map(diffs.map((diff) => [diff.lineNumber, diff]))
  const lines = new Set<number>(byLine.keys())
  for (const key of Object.keys(pendingEdits)) {
    lines.add(Number(key))
  }
  for (const line of mask.extras.keys()) lines.add(line)
  for (const bulk of mask.bulks) {
    for (const line of bulk.lines) lines.add(line)
  }
  const edits: LegendPreviewEdit[] = []
  for (const lineNumber of lines) {
    const diff = byLine.get(lineNumber)
    const text = pendingEdits[lineNumber]
    const originalSelected =
      diff?.selected ?? mask.originals.get(lineNumber) ?? true
    const selected = resolveLegendSelected(
      { lineNumber, selected: originalSelected },
      mask,
    )
    const editedAfter = text?.editedAfter ?? diff?.editedAfter
    if (
      selected === originalSelected &&
      (editedAfter ?? undefined) === (diff?.editedAfter ?? undefined)
    ) {
      continue
    }
    edits.push({
      lineNumber,
      selected,
      editedAfter,
    })
  }
  return edits
}

export function legendSelectedCount(
  headerSelected: number,
  mask: LegendSelectionMask,
): number {
  if (isLegendSelectionMaskEmpty(mask)) return headerSelected
  let count = headerSelected
  const lines = new Set<number>(mask.extras.keys())
  for (const bulk of mask.bulks) {
    for (const line of bulk.lines) lines.add(line)
  }
  for (const line of lines) {
    const original = mask.originals.get(line)
    if (original === undefined) continue
    const resolved = resolveLegendSelected(
      { lineNumber: line, selected: original },
      mask,
    )
    if (resolved !== original) count += resolved ? 1 : -1
  }
  return Math.max(0, count)
}

export function legendSelectedLineNumbers(
  diffs: Pick<LegendTranslationDiff, "lineNumber" | "selected">[],
  mask: LegendSelectionMask,
): number[] {
  const lines = new Set<number>()
  for (const diff of diffs) {
    if (resolveLegendSelected(diff, mask)) lines.add(diff.lineNumber)
  }
  for (const line of mask.extras.keys()) {
    const original = mask.originals.get(line) ?? true
    if (resolveLegendSelected({ lineNumber: line, selected: original }, mask)) {
      lines.add(line)
    } else {
      lines.delete(line)
    }
  }
  for (const bulk of mask.bulks) {
    for (const line of bulk.lines) {
      const original = mask.originals.get(line) ?? true
      if (resolveLegendSelected({ lineNumber: line, selected: original }, mask)) {
        lines.add(line)
      } else {
        lines.delete(line)
      }
    }
  }
  return [...lines]
}

export function legendDiffDraftText(
  diff: Pick<
    LegendTranslationDiff,
    "editedAfter" | "effectiveAfter" | "effectiveTarget" | "after"
  >,
): string {
  if (typeof diff.editedAfter === "string") return diff.editedAfter
  return diff.effectiveAfter || diff.effectiveTarget || diff.after
}

export function applyLegendTermSuggestion(
  text: string,
  phrase: string,
  reading: string,
  replace?: string,
): string {
  if (!reading) return text
  if (phrase && text.includes(phrase)) return text.split(phrase).join(reading)
  if (replace && text.includes(replace)) return text.split(replace).join(reading)
  if (!text.trim()) return reading
  return text
}

export function applyLegendSuggestion(
  text: string,
  suggestion: Pick<LegendTermSuggestion, "source" | "reading" | "replace">,
): string {
  return applyLegendTermSuggestion(
    text,
    suggestion.source,
    suggestion.reading,
    suggestion.replace,
  )
}

export function legendTermSuggestionApplies(
  text: string,
  suggestion: Pick<LegendTermSuggestion, "source" | "reading" | "replace">,
): boolean {
  return applyLegendSuggestion(text, suggestion) !== text
}

export function collectLegendTermSuggestions(
  issues: Iterable<Pick<LegendQaIssue, "suggestions">>,
): LegendTermSuggestion[] {
  const bySource = new Map<string, LegendTermSuggestion>()
  for (const issue of issues) {
    for (const suggestion of issue.suggestions ?? []) {
      if (
        !suggestion.source ||
        !suggestion.reading ||
        bySource.has(suggestion.source)
      ) {
        continue
      }
      bySource.set(suggestion.source, {
        source: suggestion.source,
        reading: suggestion.reading,
        ...(suggestion.replace ? { replace: suggestion.replace } : {}),
      })
    }
  }
  return [...bySource.values()].sort(
    (left, right) => right.source.length - left.source.length,
  )
}

export function applyLegendTermSuggestions(
  text: string,
  suggestions: readonly LegendTermSuggestion[],
): { text: string; applied: LegendTermSuggestion[] } {
  const unique = collectLegendTermSuggestions([{ suggestions: [...suggestions] }])
  if (unique.length === 0) return { text, applied: [] }
  if (!text.trim()) {
    if (unique.length !== 1) return { text, applied: [] }
    const [only] = unique
    if (!only) return { text, applied: [] }
    const next = applyLegendSuggestion(text, only)
    return next === text ? { text, applied: [] } : { text: next, applied: [only] }
  }
  let next = text
  const applied: LegendTermSuggestion[] = []
  for (const suggestion of unique) {
    const replaced = applyLegendSuggestion(next, suggestion)
    if (replaced === next) continue
    next = replaced
    applied.push(suggestion)
  }
  return { text: next, applied }
}

export function legendSelectedSuggestionStats(
  diffs: readonly LegendTranslationDiff[],
  pendingEdits: Record<number, LegendPreviewEdit | undefined>,
  mask: LegendSelectionMask,
  issuesByLine: Map<number, readonly Pick<LegendQaIssue, "suggestions">[]>,
): {
  lines: number
  replacements: number
  selectedWithSuggestions: number
} {
  let lines = 0
  let replacements = 0
  let selectedWithSuggestions = 0
  for (const diff of diffs) {
    const overlaid = overlayLegendDiff(diff, pendingEdits[diff.lineNumber], mask)
    if (!overlaid.selected) continue
    const suggestions = collectLegendTermSuggestions(
      issuesByLine.get(diff.lineNumber) ?? [],
    )
    if (suggestions.length === 0) continue
    selectedWithSuggestions += 1
    const result = applyLegendTermSuggestions(
      legendDiffDraftText(overlaid),
      suggestions,
    )
    if (result.applied.length === 0) continue
    lines += 1
    replacements += result.applied.length
  }
  return { lines, replacements, selectedWithSuggestions }
}
