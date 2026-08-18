import type { LegendTranslationDiff } from "@/lib/legend-types"

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

export function hasHan(text: string | null | undefined): boolean {
  return HAN_RE.test(text ?? "")
}

export function legendEffectiveTarget(
  diff: Pick<
    LegendTranslationDiff,
    "selected" | "before" | "after" | "editedAfter" | "effectiveTarget"
  >,
): string {
  if (!diff.selected) return diff.before
  if (typeof diff.editedAfter === "string") return diff.editedAfter
  return diff.effectiveTarget || diff.after
}

export function legendDiffsWithHan(
  diffs: LegendTranslationDiff[],
): LegendTranslationDiff[] {
  return diffs.filter((diff) => hasHan(legendEffectiveTarget(diff)))
}
