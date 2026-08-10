import type { ReactNode } from "react"

export function formatJsonPrimitive(value: unknown): ReactNode {
  if (value === null) {
    return <span className="text-violet-600 dark:text-violet-400">null</span>
  }
  if (typeof value === "boolean") {
    return (
      <span className="text-violet-600 dark:text-violet-400">
        {value ? "true" : "false"}
      </span>
    )
  }
  if (typeof value === "number") {
    return (
      <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>
    )
  }
  if (typeof value === "string") {
    const display =
      value.length > 240 ? `${JSON.stringify(value.slice(0, 240))}…` : JSON.stringify(value)
    return (
      <span
        className="break-all text-emerald-600 dark:text-emerald-400"
        title={value.length > 240 ? value : undefined}
      >
        {display}
      </span>
    )
  }
  return <span>{String(value)}</span>
}

const TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[[{}\],]/g

export function highlightJsonLine(line: string, keyPrefix = "line"): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let tokenIndex = 0

  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      nodes.push(line.slice(lastIndex, index))
    }

    const [token, quoted, colon] = match
    if (quoted && colon) {
      nodes.push(
        <span key={`${keyPrefix}-${tokenIndex++}`} className="text-sky-600 dark:text-sky-400">
          {quoted}
        </span>,
        colon,
      )
    } else if (quoted) {
      nodes.push(
        <span key={`${keyPrefix}-${tokenIndex++}`} className="text-emerald-600 dark:text-emerald-400">
          {quoted}
        </span>,
      )
    } else if (token === "true" || token === "false" || token === "null") {
      nodes.push(
        <span key={`${keyPrefix}-${tokenIndex++}`} className="text-violet-600 dark:text-violet-400">
          {token}
        </span>,
      )
    } else if (/^-?\d/.test(token)) {
      nodes.push(
        <span key={`${keyPrefix}-${tokenIndex++}`} className="text-amber-600 dark:text-amber-400">
          {token}
        </span>,
      )
    } else {
      nodes.push(
        <span key={`${keyPrefix}-${tokenIndex++}`} className="text-muted-foreground">
          {token}
        </span>,
      )
    }

    lastIndex = index + token.length
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex))
  }

  return nodes.length > 0 ? nodes : [line]
}

export function formatJsonByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
