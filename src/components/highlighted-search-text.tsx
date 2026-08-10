import type { ReactNode } from "react"
import type { TagSearchOptions } from "@/lib/app-types"
import { findTextMatchRanges } from "@/lib/tag-search"

export function HighlightedSearchText({
  text,
  query,
  caseSensitive,
  wholeWord,
}: {
  text: string
  query: string
  caseSensitive: boolean
  wholeWord: boolean
}) {
  const options: TagSearchOptions = { caseSensitive, wholeWord }
  const ranges = findTextMatchRanges(text, query.trim(), options)
  if (ranges.length === 0) return <span className="min-w-0">{text}</span>

  const content: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) {
      content.push(text.slice(cursor, range.start))
    }
    content.push(
      <mark
        key={`${range.start}-${range.end}`}
        className="rounded-sm bg-warning/35 text-inherit"
      >
        {text.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  }
  if (cursor < text.length) content.push(text.slice(cursor))
  return <span className="min-w-0">{content}</span>
}
