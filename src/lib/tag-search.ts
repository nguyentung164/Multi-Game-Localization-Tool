import type {
  QaIssue,
  TagListResult,
  TagSearchMatch,
  TagSearchOptions,
  TagSearchResult,
  TagSearchScope,
} from "@/lib/app-types"
import { formatLocDisplayText } from "@/lib/loc-text"

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildMatchRegExp(
  query: string,
  options: TagSearchOptions,
  global = true,
): RegExp | null {
  if (!query) return null
  const escaped = escapeRegExp(query)
  const flags = `${options.caseSensitive ? "u" : "iu"}${global ? "g" : ""}`
  if (options.wholeWord) {
    return new RegExp(
      `(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`,
      flags,
    )
  }
  return new RegExp(escaped, flags)
}

export interface TextMatchRange {
  start: number
  end: number
}

export function findTextMatchRanges(
  value: string,
  query: string,
  options: TagSearchOptions,
): TextMatchRange[] {
  if (!value || !query) return []
  const expression = buildMatchRegExp(query, options)
  if (!expression) return []
  const ranges: TextMatchRange[] = []

  if (options.wholeWord) {
    for (const match of value.matchAll(expression)) {
      const prefixLength = match[1]?.length ?? 0
      const matchedText = match[2]
      if (!matchedText || match.index === undefined) continue
      const start = match.index + prefixLength
      ranges.push({ start, end: start + matchedText.length })
    }
    return ranges
  }

  for (const match of value.matchAll(expression)) {
    if (!match[0] || match.index === undefined) continue
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return ranges
}

/** Thay thế các lần khớp trong chuỗi (giống Find/Replace của VS Code). */
export function replaceTextMatches(
  value: string,
  query: string,
  replacement: string,
  options: TagSearchOptions,
  maxReplacements?: number,
): { text: string; count: number } {
  const ranges = findTextMatchRanges(value, query, options)
  if (ranges.length === 0) return { text: value, count: 0 }

  const selected =
    maxReplacements === undefined
      ? ranges
      : ranges.slice(0, Math.max(0, maxReplacements))
  if (selected.length === 0) return { text: value, count: 0 }

  let text = value
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const range = selected[index]!
    text = `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`
  }
  return { text, count: selected.length }
}

export function createTextMatcher(
  query: string,
  options: TagSearchOptions,
): (value: string) => boolean {
  const expression = buildMatchRegExp(query, options, false)
  if (!expression) return () => false
  return (value) => Boolean(value && expression.test(value))
}

function searchableFieldText(value: string, field: "loc" | "plain"): string {
  if (!value) return value
  return field === "loc" ? formatLocDisplayText(value) : value
}

function matchesQuery(
  scope: TagSearchScope,
  match: Pick<
    TagSearchMatch,
    "file" | "tag" | "english" | "vietnamese" | "timing"
  >,
  matchesText: (value: string) => boolean,
): boolean {
  const file = normalizeFile(match.file)
  const english = searchableFieldText(match.english, "loc")
  const vietnamese = searchableFieldText(match.vietnamese, "loc")
  const fields: Record<TagSearchScope, string[]> = {
    all: [file, match.tag, english, vietnamese, match.timing ?? ""],
    tag: [match.tag, match.timing ?? ""],
    english: [english],
    vietnamese: [vietnamese],
    file: [file],
  }

  return fields[scope].some((value) => value && matchesText(value))
}

/** Lọc lại kết quả theo options hiện tại (đảm bảo khớp với highlight/replace). */
export function filterTagSearchResult(
  result: TagSearchResult,
  options: TagSearchOptions,
): TagSearchResult {
  const trimmed = result.query.trim()
  if (!trimmed) return result

  const matcher = createTextMatcher(trimmed, options)
  const matches = result.matches.filter((match) =>
    matchesQuery(result.scope, match, matcher),
  )

  return {
    ...result,
    matches,
    totalMatches: matches.length,
  }
}

function issueToMatch(issue: QaIssue, index: number): TagSearchMatch {
  return {
    id: `demo-match-${index}`,
    file: normalizeFile(issue.file),
    tag: issue.tag,
    entryType: "Row",
    english: issue.source,
    vietnamese: issue.target,
  }
}

export function searchDemoTags(
  issues: QaIssue[],
  query: string,
  scope: TagSearchScope,
  maxResults = 500,
  options: TagSearchOptions = { caseSensitive: false, wholeWord: false },
): TagSearchResult {
  const trimmed = query.trim()
  if (!trimmed) {
    return {
      query: "",
      scope,
      scannedFiles: 0,
      totalMatches: 0,
      truncated: false,
      matches: [],
    }
  }

  const matchesText = createTextMatcher(trimmed, options)
  const matches = issues
    .map(issueToMatch)
    .filter((match) => matchesQuery(scope, match, matchesText))
    .slice(0, maxResults)

  return {
    query: trimmed,
    scope,
    scannedFiles: new Set(issues.map((issue) => normalizeFile(issue.file)))
      .size,
    totalMatches: matches.length,
    truncated: matches.length >= maxResults,
    matches,
  }
}

export function listDemoTags(issues: QaIssue[]): TagListResult {
  const matches = issues.map(issueToMatch)
  return {
    scannedFiles: new Set(issues.map((issue) => normalizeFile(issue.file)))
      .size,
    totalMatches: matches.length,
    truncated: false,
    matches,
  }
}

export function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}
