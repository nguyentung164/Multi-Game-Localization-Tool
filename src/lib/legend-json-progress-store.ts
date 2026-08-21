import { useSyncExternalStore } from "react"

/** Progress tick — tách khỏi hook JSON Pipeline để table không re-render mỗi tick. */
export type LegendJsonJobProgress = {
  jobId: string | null
  processed: number
  total: number
  file?: string
  progress: number
}

type Listener = () => void

let snapshot: LegendJsonJobProgress | null = null
const listeners = new Set<Listener>()

export function getLegendJsonProgressSnapshot(): LegendJsonJobProgress | null {
  return snapshot
}

function notify() {
  for (const listener of listeners) listener()
}

export function buildLegendJsonProgress(input: {
  jobId: string | null
  processed: number
  total: number
  file?: string
}): LegendJsonJobProgress {
  return {
    jobId: input.jobId,
    processed: input.processed,
    total: input.total,
    file: input.file,
    progress: input.total > 0 ? (input.processed / input.total) * 100 : 0,
  }
}

function isSameProgress(
  left: LegendJsonJobProgress | null,
  right: LegendJsonJobProgress,
): boolean {
  return (
    left !== null &&
    left.jobId === right.jobId &&
    left.processed === right.processed &&
    left.total === right.total &&
    left.file === right.file &&
    left.progress === right.progress
  )
}

export function syncLegendJsonProgress(next: LegendJsonJobProgress | null) {
  if (next === null) {
    if (snapshot === null) return
    snapshot = null
    notify()
    return
  }
  if (isSameProgress(snapshot, next)) return
  snapshot = next
  notify()
}

export function publishLegendJsonProgress(next: LegendJsonJobProgress) {
  if (isSameProgress(snapshot, next)) return
  snapshot = next
  notify()
}

export function clearLegendJsonProgress() {
  if (snapshot === null) return
  snapshot = null
  notify()
}

function subscribeLegendJsonProgress(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useLegendJsonProgress(): LegendJsonJobProgress | null {
  return useSyncExternalStore(
    subscribeLegendJsonProgress,
    getLegendJsonProgressSnapshot,
    getLegendJsonProgressSnapshot,
  )
}
