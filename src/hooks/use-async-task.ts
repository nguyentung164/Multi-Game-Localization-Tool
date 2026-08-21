import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type TransitionStartFunction,
} from "react"
import type { AsyncLoadingPhase } from "@/components/async-loading-overlay"
import {
  formatSyncProgressLabel,
  listenToSyncProgress,
  syncProgressPercent,
  type SyncProgressEvent,
} from "@/lib/sync-progress"
import { yieldToMainThread } from "@/lib/yield-to-main-thread"

export type AsyncTaskRunOptions<T> = {
  task: () => Promise<T>
  title?: string
  description?: string
  phase?: AsyncLoadingPhase
  phaseLabel?: string
  syncCommand?: string | string[]
  onSuccess?: (value: T) => void
  renderResult?: (value: T) => void
}

export type AsyncTaskState = {
  loading: boolean
  fetching: boolean
  isRendering: boolean
  title: string
  description: string | undefined
  phase: AsyncLoadingPhase | null
  phaseLabel: string | null
  progress: number | null
}

const defaultTitle = "Đang xử lý…"

export function useAsyncTask(initial?: {
  title?: string
  description?: string
}) {
  const [fetching, setFetching] = useState(false)
  const [isRendering, startTransition] = useTransition()
  const [title, setTitle] = useState(initial?.title ?? defaultTitle)
  const [description, setDescription] = useState<string | undefined>(
    initial?.description,
  )
  const [phase, setPhase] = useState<AsyncLoadingPhase | null>(null)
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const runIdRef = useRef(0)
  const unlistenRef = useRef<(() => void) | null>(null)

  const stopSyncProgress = useCallback(() => {
    unlistenRef.current?.()
    unlistenRef.current = null
  }, [])

  useEffect(() => () => stopSyncProgress(), [stopSyncProgress])

  const applySyncProgress = useCallback((event: SyncProgressEvent) => {
    setPhaseLabel(formatSyncProgressLabel(event))
    setProgress(syncProgressPercent(event))
  }, [])

  const run = useCallback(
    async <T,>(options: AsyncTaskRunOptions<T>): Promise<T | undefined> => {
      const runId = ++runIdRef.current
      setFetching(true)
      setPhase(options.phase ?? "fetching")
      setPhaseLabel(options.phaseLabel ?? null)
      setProgress(null)
      if (options.title) setTitle(options.title)
      setDescription(options.description)

      stopSyncProgress()
      if (options.syncCommand) {
        void listenToSyncProgress((event) => {
          if (runId !== runIdRef.current) return
          applySyncProgress(event)
        }, options.syncCommand).then((unlisten) => {
          if (runId !== runIdRef.current) {
            unlisten()
            return
          }
          unlistenRef.current = unlisten
        })
      }

      await yieldToMainThread()
      try {
        const value = await options.task()
        if (runId !== runIdRef.current) return undefined

        const commit = () => {
          options.renderResult?.(value)
          options.onSuccess?.(value)
        }

        if (options.renderResult || options.onSuccess) {
          setPhase("rendering")
          await yieldToMainThread()
          startTransition(commit)
        } else {
          commit()
        }
        return value
      } finally {
        if (runId === runIdRef.current) {
          stopSyncProgress()
          setFetching(false)
          setPhase(null)
          setPhaseLabel(null)
          setProgress(null)
        }
      }
    },
    [applySyncProgress, startTransition, stopSyncProgress],
  )

  const loading = fetching || isRendering

  return {
    run,
    loading,
    fetching,
    isRendering,
    title,
    description,
    phase,
    phaseLabel,
    progress,
    setTitle,
    setDescription,
    startTransition: startTransition as TransitionStartFunction,
  }
}

export type PageLoadingState = {
  loading: boolean
  title: string
  description: string | undefined
  phase: AsyncLoadingPhase | null
  phaseLabel: string | null
  progress: number | null
}

export type PageLoadingInput = {
  syncOverlay?: {
    loading: boolean
    title?: string
    description?: string | undefined
    phase?: AsyncLoadingPhase | null
    phaseLabel?: string | null
    progress?: number | null
  }
  forceEstimateLoading?: boolean
  estimateLoading?: boolean
  previewRowsLoading?: boolean
  inspectRowsLoading?: boolean
  savingPreview?: boolean
}

const idlePageLoading: PageLoadingState = {
  loading: false,
  title: defaultTitle,
  description: undefined,
  phase: null,
  phaseLabel: null,
  progress: null,
}

/** Merge page-local loading flags by priority (sync overlay → force estimate → …). */
export function resolvePageLoadingState(
  input: PageLoadingInput,
): PageLoadingState {
  const sync = input.syncOverlay
  if (sync?.loading) {
    return {
      loading: true,
      title: sync.title ?? defaultTitle,
      description: sync.description,
      phase: sync.phase ?? null,
      phaseLabel: sync.phaseLabel ?? null,
      progress: sync.progress ?? null,
    }
  }
  if (input.forceEstimateLoading) {
    return {
      loading: true,
      title: "Đang ước lượng dịch lại…",
      description: "Engine đang đếm câu cần dịch lại toàn bộ.",
      phase: "fetching",
      phaseLabel: null,
      progress: null,
    }
  }
  if (input.estimateLoading) {
    return {
      loading: true,
      title: "Đang ước lượng…",
      description: "Engine đang đếm câu chưa Việt hóa.",
      phase: "fetching",
      phaseLabel: null,
      progress: null,
    }
  }
  if (input.previewRowsLoading) {
    return {
      loading: true,
      title: "Đang tải bảng diff…",
      description: undefined,
      phase: "fetching",
      phaseLabel: null,
      progress: null,
    }
  }
  if (input.inspectRowsLoading) {
    return {
      loading: true,
      title: "Đang tải dòng kiểm tra…",
      description: undefined,
      phase: "fetching",
      phaseLabel: null,
      progress: null,
    }
  }
  if (input.savingPreview) {
    return {
      loading: true,
      title: "Đang lưu preview…",
      description: undefined,
      phase: "saving",
      phaseLabel: null,
      progress: null,
    }
  }
  return idlePageLoading
}
