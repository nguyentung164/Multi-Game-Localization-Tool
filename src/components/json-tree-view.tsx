import { useMemo, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { formatJsonPrimitive } from "@/lib/json-highlight"
import { cn } from "@/lib/utils"

const INDENT_PX = 16
const MAX_EXPANDED_CHILDREN = 150

function isCollection(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object"
}

function collectionPreview(value: Record<string, unknown> | unknown[]) {
  return Array.isArray(value)
    ? `Array(${value.length})`
    : `Object(${Object.keys(value).length})`
}

function JsonTreeNode({
  label,
  value,
  depth,
  defaultExpandedDepth,
}: {
  label?: string
  value: unknown
  depth: number
  defaultExpandedDepth: number
}) {
  const [open, setOpen] = useState(depth < defaultExpandedDepth)
  const collection = isCollection(value)
  const entries = useMemo(() => {
    if (!collection) return [] as readonly (readonly [string, unknown])[]
    return Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value)
  }, [collection, value])

  if (!collection) {
    return (
      <div
        className="flex min-w-0 items-start gap-1 py-0.5 font-mono text-xs leading-relaxed"
        style={{ paddingLeft: depth * INDENT_PX }}
      >
        {label !== undefined && (
          <>
            <span className="shrink-0 text-sky-600 dark:text-sky-400">
              {JSON.stringify(label)}:
            </span>
            <span className="text-muted-foreground"> </span>
          </>
        )}
        {formatJsonPrimitive(value)}
      </div>
    )
  }

  const visibleEntries = open ? entries.slice(0, MAX_EXPANDED_CHILDREN) : []
  const hiddenCount = open ? Math.max(0, entries.length - MAX_EXPANDED_CHILDREN) : 0

  return (
    <div className="font-mono text-xs leading-relaxed">
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-sm py-0.5 text-left hover:bg-muted/60",
        )}
        style={{ paddingLeft: depth * INDENT_PX }}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {label !== undefined && (
          <span className="shrink-0 text-sky-600 dark:text-sky-400">
            {JSON.stringify(label)}:
          </span>
        )}
        <span className="truncate text-muted-foreground">{collectionPreview(value)}</span>
      </button>
      {open &&
        visibleEntries.map(([entryLabel, entryValue]) => (
          <JsonTreeNode
            key={`${depth}-${entryLabel}`}
            label={entryLabel}
            value={entryValue}
            depth={depth + 1}
            defaultExpandedDepth={defaultExpandedDepth}
          />
        ))}
      {open && hiddenCount > 0 && (
        <p
          className="py-1 text-muted-foreground"
          style={{ paddingLeft: (depth + 1) * INDENT_PX }}
        >
          … và {hiddenCount.toLocaleString("vi-VN")} mục nữa
        </p>
      )}
    </div>
  )
}

export function JsonTreeView({
  value,
  defaultExpandedDepth = 1,
}: {
  value: unknown
  defaultExpandedDepth?: number
}) {
  if (!isCollection(value)) {
    return (
      <div className="p-3 font-mono text-xs">
        {formatJsonPrimitive(value)}
      </div>
    )
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value)

  return (
    <div className="p-3">
      {entries.map(([label, entryValue]) => (
        <JsonTreeNode
          key={label}
          label={label}
          value={entryValue}
          depth={0}
          defaultExpandedDepth={defaultExpandedDepth}
        />
      ))}
    </div>
  )
}
