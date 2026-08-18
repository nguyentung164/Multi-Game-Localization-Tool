import type { EventLevel } from "@/lib/app-types"
import { formatDateTime } from "@/lib/format-date"
import { resolveJobEventText } from "@/lib/job-event-text"
import type { LegendJobEvent, LegendJobEventType } from "@/lib/legend-types"

export const LEGEND_CONSOLE_MAX_EVENTS = 500

const HEAVY_DETAIL_KEYS = [
  "diffs",
  "sample",
  "entries",
  "qa",
  "lockedGlossary",
  "items",
  "warnings",
] as const

export interface LegendConsoleEvent {
  id: string
  seq: number
  timestamp: string
  level: EventLevel
  title: string
  description: string
  detail?: unknown
}

export function legendConsoleEventLevel(
  type: LegendJobEventType,
): EventLevel {
  if (type === "failed") return "error"
  if (type === "warning" || type === "paused") return "warning"
  if (type === "completed") return "success"
  return "info"
}

export function shouldKeepLegendConsoleEvent(type: LegendJobEventType): boolean {
  return type !== "progress"
}

function compactDetail(detail: unknown): unknown {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return detail
  }
  const record = { ...(detail as Record<string, unknown>) }
  for (const key of HEAVY_DETAIL_KEYS) {
    delete record[key]
  }
  return Object.keys(record).length > 0 ? record : undefined
}

export function toLegendConsoleEvent(event: LegendJobEvent): LegendConsoleEvent {
  const text = resolveJobEventText(event.type, event.payload)
  return {
    id: `${event.jobId}-${event.seq}`,
    seq: event.seq,
    timestamp: formatDateTime(event.timestamp),
    level: legendConsoleEventLevel(event.type),
    title: text.title,
    description: text.description,
    detail: compactDetail(event.payload),
  }
}

export function localLegendConsoleEvent(
  level: EventLevel,
  title: string,
  description: string,
  detail?: unknown,
): LegendConsoleEvent {
  const now = Date.now()
  return {
    id: `local-${now}-${title}`,
    seq: now,
    timestamp: formatDateTime(new Date(now).toISOString()),
    level,
    title,
    description,
    detail,
  }
}

export function appendLegendConsoleEvent(
  events: LegendConsoleEvent[],
  next: LegendConsoleEvent,
): LegendConsoleEvent[] {
  if (events.some((item) => item.id === next.id)) return events
  return [next, ...events].slice(0, LEGEND_CONSOLE_MAX_EVENTS)
}
