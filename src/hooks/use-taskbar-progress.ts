import { useEffect, useRef } from "react"
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window"
import type { LegendPhase } from "@/hooks/use-legend-translation"
import { useLegendJsonProgress } from "@/lib/legend-json-progress-store"
import { isTauriRuntime } from "@/lib/tauri-ipc"

type TaskbarProgressInput = {
  civ7Progress?: number | null
  legendPhase?: LegendPhase
  legendProgress?: number
  civ7Running?: boolean
  legendJsonRunning?: boolean
  legendJsonProgress?: number | null
}

type TaskbarState = {
  status: ProgressBarStatus
  progress?: number
}

export function resolveTaskbarState(input: TaskbarProgressInput): TaskbarState {
  if (input.civ7Running) {
    return {
      status: ProgressBarStatus.Normal,
      progress: Math.round(input.civ7Progress ?? 0),
    }
  }
  if (input.legendPhase === "running") {
    return {
      status: ProgressBarStatus.Normal,
      progress: Math.round(input.legendProgress ?? 0),
    }
  }
  if (input.legendJsonRunning) {
    return {
      status: ProgressBarStatus.Normal,
      progress: Math.round(input.legendJsonProgress ?? 0),
    }
  }
  return { status: ProgressBarStatus.None }
}

function serializeTaskbarState(state: TaskbarState): string {
  return `${state.status}:${state.progress ?? ""}`
}

async function applyTaskbarProgress(state: TaskbarState) {
  if (state.status === ProgressBarStatus.None) {
    await getCurrentWindow().setProgressBar({ status: ProgressBarStatus.None })
    return
  }
  await getCurrentWindow().setProgressBar({
    status: state.status,
    progress: state.progress ?? 0,
  })
}

export function useTaskbarProgress(input: TaskbarProgressInput) {
  const lastKeyRef = useRef("")
  const jsonProgress = useLegendJsonProgress()

  useEffect(() => {
    if (!isTauriRuntime()) return
    void applyTaskbarProgress({ status: ProgressBarStatus.None })
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return

    const next = resolveTaskbarState({
      ...input,
      legendJsonProgress: jsonProgress?.progress ?? 0,
    })
    const key = serializeTaskbarState(next)
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key

    void applyTaskbarProgress(next)
  }, [
    input.civ7Progress,
    input.civ7Running,
    input.legendJsonRunning,
    input.legendPhase,
    input.legendProgress,
    jsonProgress?.progress,
  ])

  useEffect(() => {
    if (!isTauriRuntime()) return

    return () => {
      lastKeyRef.current = ""
      void applyTaskbarProgress({ status: ProgressBarStatus.None })
    }
  }, [])
}

/** Island: subscribe JSON progress here so App/table không rerender từng tick. */
export function TaskbarProgressSync(input: TaskbarProgressInput) {
  useTaskbarProgress(input)
  return null
}

