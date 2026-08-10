import type { InspectDiff, InspectDiffStatus, InspectSnapshot } from "@/lib/app-types"

export function countInspectByStatus(
  diffs: InspectDiff[],
): Record<InspectDiffStatus | "all", number> {
  const counts: Record<InspectDiffStatus | "all", number> = {
    all: diffs.length,
    "english-only": 0,
    "vietnamese-only": 0,
    different: 0,
    invalid: 0,
  }
  for (const diff of diffs) {
    counts[diff.status] += 1
  }
  return counts
}

export function formatInspectDeltaLabel(delta: {
  type?: string
  tag?: string
  timing?: string
  count: number
}): string {
  if (delta.timing) {
    return `${delta.timing}${delta.count > 1 ? ` ×${delta.count}` : ""}`
  }
  const tag = delta.tag ?? delta.type ?? "?"
  return `${tag}${delta.count > 1 ? ` ×${delta.count}` : ""}`
}

export function filterInspectDiffs(
  diffs: InspectDiff[],
  query: string,
  status: "all" | InspectDiffStatus,
): InspectDiff[] {
  const normalized = query.trim().toLocaleLowerCase()
  return diffs.filter((diff) => {
    if (status !== "all" && diff.status !== status) return false
    if (!normalized) return true
    const haystack = [
      diff.file,
      diff.error ?? "",
      ...(diff.missingInVietnamese ?? []).flatMap((item) => [
        item.tag,
        item.type,
        item.timing,
      ]),
      ...(diff.extraInVietnamese ?? []).flatMap((item) => [
        item.tag,
        item.type,
        item.timing,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
    return haystack.includes(normalized)
  })
}

export function inspectSummaryMetrics(snapshot?: InspectSnapshot) {
  if (!snapshot) {
    return {
      englishFiles: 0,
      vietnameseFiles: 0,
      englishOnly: 0,
      vietnameseOnly: 0,
      differentFiles: 0,
      invalidCount: 0,
    }
  }
  return {
    englishFiles:
      (snapshot.english?.xmlFiles ?? 0) + (snapshot.english?.vttFiles ?? 0),
    vietnameseFiles:
      (snapshot.vietnamese?.xmlFiles ?? 0) + (snapshot.vietnamese?.vttFiles ?? 0),
    englishOnly: snapshot.englishOnly,
    vietnameseOnly: snapshot.vietnameseOnly,
    differentFiles: snapshot.differentFiles,
    invalidCount:
      (snapshot.english?.invalidCount ?? 0) +
      (snapshot.vietnamese?.invalidCount ?? 0),
  }
}
