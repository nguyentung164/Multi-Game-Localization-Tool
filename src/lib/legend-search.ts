import type { TagSearchOptions } from "@/lib/app-types"
import { createTextMatcher } from "@/lib/tag-search"
import type {
  LegendFileEntry,
  LegendSearchMatch,
  LegendSearchResult,
  LegendSearchScope,
} from "@/lib/legend-types"

export const LEGEND_SEARCH_MAX = 500

const emptyResult = (
  scope: LegendSearchScope,
  sourcePath = "",
): LegendSearchResult => ({
  query: "",
  scope,
  sourcePath,
  scannedLines: 0,
  totalMatches: 0,
  truncated: false,
  matches: [],
})

export function emptyLegendSearchResult(
  scope: LegendSearchScope,
  sourcePath = "",
): LegendSearchResult {
  return emptyResult(scope, sourcePath)
}

function matchesScope(
  scope: LegendSearchScope,
  match: LegendSearchMatch,
  matchesText: (value: string) => boolean,
): boolean {
  const line = String(match.lineNumber)
  if (scope === "chinese") return matchesText(match.source)
  if (scope === "vietnamese") return matchesText(match.currentTarget)
  if (scope === "line") return matchesText(line)
  return (
    matchesText(match.source) ||
    matchesText(match.currentTarget) ||
    matchesText(line)
  )
}

export function filterLegendSearchResult(
  result: LegendSearchResult,
  options: TagSearchOptions,
): LegendSearchResult {
  const trimmed = result.query.trim()
  if (!trimmed) return result
  const matcher = createTextMatcher(trimmed, options)
  const matches = result.matches.filter((match) =>
    matchesScope(result.scope, match, matcher),
  )
  return {
    ...result,
    matches,
    totalMatches: matches.length,
  }
}

export function searchLegendEntries(
  entries: LegendFileEntry[],
  query: string,
  scope: LegendSearchScope,
  sourcePath: string,
  options: TagSearchOptions,
  maxResults = LEGEND_SEARCH_MAX,
): LegendSearchResult {
  const trimmed = query.trim()
  const matcher = trimmed ? createTextMatcher(trimmed, options) : () => true
  const matches: LegendSearchMatch[] = []
  let totalMatches = 0
  for (const entry of entries) {
    if (entry.kind && entry.kind !== "entry") continue
    const match: LegendSearchMatch = {
      id: `legend-line-${entry.lineNumber}`,
      lineNumber: entry.lineNumber,
      source: entry.source,
      currentTarget: entry.currentTarget,
    }
    if (trimmed && !matchesScope(scope, match, matcher)) continue
    totalMatches += 1
    if (matches.length < maxResults) matches.push(match)
  }
  return {
    query: trimmed,
    scope,
    sourcePath,
    scannedLines: entries.filter((entry) => !entry.kind || entry.kind === "entry")
      .length,
    totalMatches,
    truncated: totalMatches > maxResults,
    matches,
  }
}
