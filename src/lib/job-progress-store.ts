import { useSyncExternalStore } from "react"
import type { ActiveJob } from "@/lib/app-types"

/** Progress tick — tách khỏi AppState để copy/deploy không re-render cả app. */
type Listener = () => void

let snapshot: ActiveJob | null = null
const listeners = new Set<Listener>()

export function getJobProgressSnapshot(): ActiveJob | null {
  return snapshot
}

export function syncJobProgress(job: ActiveJob | null) {
  snapshot = job
  for (const listener of listeners) {
    listener()
  }
}

export function publishJobProgress(job: ActiveJob) {
  snapshot = job
  for (const listener of listeners) {
    listener()
  }
}

function subscribeJobProgress(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useJobProgress(): ActiveJob | null {
  return useSyncExternalStore(
    subscribeJobProgress,
    getJobProgressSnapshot,
    getJobProgressSnapshot,
  )
}
