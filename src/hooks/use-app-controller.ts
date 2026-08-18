import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import type {
  ActiveJob,
  ApiKeyMeta,
  AppConfig,
  AppState,
  JobEvent,
  JobEventEnvelope,
  StepId,
} from "@/lib/app-types"
import { demoState } from "@/lib/demo-state"
import { formatAppStateDates, formatDateTime } from "@/lib/format-date"
import { resolveJobEventText } from "@/lib/job-event-text"
import {
  acquireJobStartLock,
  getInFlightJobStart,
  holdJobStartLock,
  isDuplicateJobStartError,
  isJobStartLocked,
  releaseJobStartLock,
  setInFlightJobStart,
} from "@/lib/job-start-lock"
import {
  getJobProgressSnapshot,
  publishJobProgress,
  syncJobProgress,
} from "@/lib/job-progress-store"
import {
  applyTranslateKeyUsage,
  resolveActiveTranslateKey,
  resolveTranslateKeyId,
} from "@/lib/translate-session"
import {
  normalizePipelineGates,
  STATE_SYNC_EVENT_TYPES,
} from "@/lib/pipeline-gates"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"
import { toastTerminalJobOutcome } from "@/lib/terminal-toast"

const cloneDemoState = () => structuredClone(demoState)

const EVENT_DETAIL_HEAVY_KEYS = new Set([
  "actions",
  "changes",
  "copiedFiles",
  "createdInGame",
  "skippedExtraFiles",
  "unchangedFiles",
  "english",
  "vietnamese",
  "diff",
])

function compactEventDetail(detail: unknown): unknown {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return detail
  }
  const record = { ...(detail as Record<string, unknown>) }
  for (const key of EVENT_DETAIL_HEAVY_KEYS) {
    delete record[key]
  }
  return Object.keys(record).length > 0 ? record : undefined
}

function sanitizeAppState(state: AppState): AppState {
  return {
    ...state,
    events: state.events.map((event) => ({
      ...event,
      detail:
        event.detail === undefined
          ? undefined
          : (compactEventDetail(event.detail) as JobEvent["detail"]),
    })),
  }
}

function preparePersistedState(state: AppState): AppState {
  return normalizePipelineGates(formatAppStateDates(sanitizeAppState(state)))
}

function currentStepLabel(step: StepId): string | undefined {
  return demoState.steps.find((item) => item.id === step)?.title
}

/** Progress tick — chỉ cập nhật external store, không đụng AppState. */
function patchJobProgress(
  job: ActiveJob,
  apiKeys: ApiKeyMeta[],
  event: JobEventEnvelope,
): { job: ActiveJob; apiKeys?: ApiKeyMeta[] } | null {
  const payload = event.payload
  const progress = Math.round(Number(payload.progress ?? job.progress))
  const batchProgress = Math.round(
    Number(payload.batchProgress ?? job.batchProgress),
  )
  const currentFile = String(payload.currentFile ?? job.currentFile)
  const processed = Number(payload.processed ?? job.processed)
  const total = Number(payload.total ?? job.total)
  const model = payload.model ? String(payload.model) : job.model
  const keyIndex =
    payload.keyIndex !== undefined ? Number(payload.keyIndex) : job.keyIndex
  const resolvedKeyId =
    payload.keyId !== undefined
      ? String(payload.keyId)
      : (resolveTranslateKeyId(apiKeys, {
          ...job,
          keyIndex,
          keyId: job.keyId,
        }) ?? job.keyId)
  const countRequest = payload.phase === "api"

  if (
    job.progress === progress &&
    job.batchProgress === batchProgress &&
    job.currentFile === currentFile &&
    job.processed === processed &&
    job.total === total &&
    job.model === model &&
    job.keyId === resolvedKeyId &&
    job.keyIndex === keyIndex
  ) {
    return null
  }

  let nextApiKeys = apiKeys
  if (resolvedKeyId && (resolvedKeyId !== job.keyId || countRequest)) {
    nextApiKeys = applyTranslateKeyUsage(apiKeys, resolvedKeyId, {
      countRequest,
    })
  }

  const nextJob: ActiveJob = {
    ...job,
    progress,
    batchProgress,
    currentFile,
    processed,
    total,
    model,
    keyId: resolvedKeyId,
    keyIndex,
  }

  return nextApiKeys === apiKeys
    ? { job: nextJob }
    : { job: nextJob, apiKeys: nextApiKeys }
}

export function applyJobEvent(
  state: AppState,
  event: JobEventEnvelope,
): AppState {
  const payload = event.payload
  const command =
    typeof payload.command === "string" ? payload.command : undefined
  const level =
    event.type === "failed"
      ? "error"
      : event.type === "warning" || event.type === "paused"
        ? "warning"
        : event.type === "completed"
          ? "success"
          : "info"
  const timelineEvent: JobEvent = {
    id: `${event.jobId}-${event.seq}`,
    seq: event.seq,
    timestamp: formatDateTime(event.timestamp),
    level,
    ...resolveJobEventText(event.type, payload),
    step: event.step,
    detail:
      payload.detail === undefined
        ? undefined
        : (compactEventDetail(payload.detail) as JobEvent["detail"]),
  }

  const events = state.events.some((item) => item.id === timelineEvent.id)
    ? state.events
    : [timelineEvent, ...state.events].slice(0, 500)

  let steps = state.steps
  let selectedStep = state.selectedStep
  let activeJob = state.activeJob

  if (event.type === "started") {
    steps = state.steps.map((item) =>
      item.id === event.step ? { ...item, status: "running" as const } : item,
    )
    selectedStep = event.step
    activeJob = {
      id: event.jobId,
      step: event.step,
      status: "running",
      startedAt: formatDateTime(event.timestamp),
      elapsed: "00:00",
      progress: 0,
      batchProgress: 0,
      currentFile: "",
      processed: 0,
      total: Number(payload.total ?? 0),
      throughput: "Đang đo",
    }
  }

  if (event.type === "completed") {
    steps = state.steps.map((item) => {
      if (item.id !== event.step) return item
      const hasWarnings =
        Boolean(payload.hasWarnings) || (item.summary.warnings ?? 0) > 0
      return {
        ...item,
        status: hasWarnings ? ("warning" as const) : ("success" as const),
        lastRun: "Vừa xong",
      }
    })
    activeJob = null
  }

  if (event.type === "failed") {
    steps = state.steps.map((item) =>
      item.id === event.step ? { ...item, status: "failed" as const } : item,
    )
    if (activeJob?.id === event.jobId) {
      activeJob = { ...activeJob, status: "failed" }
    }
  }

  if (event.type === "paused") {
    steps = state.steps.map((item) =>
      item.id === event.step ? { ...item, status: "paused" as const } : item,
    )
    if (activeJob?.id === event.jobId) {
      activeJob = { ...activeJob, status: "paused" }
    }
  }

  let deployApplied = state.deployApplied
  let syncApplied = state.syncApplied
  let deployChanges = state.deployChanges
  if (
    event.type === "completed" &&
    event.step === "deploy" &&
    command === "deploy-apply"
  ) {
    deployApplied = true
  }
  if (
    event.type === "completed" &&
    event.step === "sync" &&
    command === "sync-apply"
  ) {
    syncApplied = true
  }
  if (event.type === "started") {
    if (
      event.step === "export" ||
      event.step === "inspect" ||
      event.step === "sync"
    ) {
      syncApplied = false
      deployApplied = false
    } else if (event.step === "translate") {
      deployApplied = false
    } else if (event.step === "deploy") {
      deployApplied = false
      deployChanges = []
    }
  }

  const next: AppState = {
    ...state,
    steps,
    events,
    selectedStep,
    activeJob,
    deployApplied,
    syncApplied,
    deployChanges,
  }

  if (STATE_SYNC_EVENT_TYPES.has(event.type)) {
    return normalizePipelineGates(next)
  }

  return next
}

export function useAppController() {
  const [state, setState] = useState<AppState>(cloneDemoState)
  const stateRef = useRef(state)
  const [, startTransition] = useTransition()

  const [loading, setLoading] = useState(isTauriRuntime())
  const [busyAction, setBusyAction] = useState<{
    title: string
    description?: string
    phase?: "fetching" | "rendering" | "saving" | "applying"
  } | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const jobStartPendingRef = useRef(false)
  const activeJobRunningRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const running = state.activeJob?.status === "running"
    const wasRunning = activeJobRunningRef.current
    activeJobRunningRef.current = running
    if (wasRunning && !running) {
      releaseJobStartLock()
    }
  }, [state.activeJob?.status])

  useEffect(() => {
    syncJobProgress(state.activeJob)
  }, [state.activeJob])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    async function initialize() {
      if (!isTauriRuntime()) return
      try {
        const persisted = await ipc.getState()
        if (!active) return
        setState(preparePersistedState(persisted))

        const stop = await ipc.listenToJobEvents((event) => {
          if (!active) return
          if (event.protocolVersion !== 1) {
            setConnectionError(
              `Phiên bản giao thức ${event.protocolVersion} chưa được hỗ trợ.`,
            )
            return
          }
          if (event.type === "progress") {
            const job =
              getJobProgressSnapshot() ?? stateRef.current.activeJob ?? null
            if (!job || job.id !== event.jobId) return

            const patch = patchJobProgress(job, stateRef.current.apiKeys, event)
            if (!patch) return

            publishJobProgress(patch.job)
            if (patch.apiKeys) {
              setState((current) => ({ ...current, apiKeys: patch.apiKeys! }))
            }
            return
          }

          const isTerminal =
            event.type === "completed" ||
            event.type === "failed" ||
            event.type === "paused"
          const applyEvent = () =>
            setState((current) => applyJobEvent(current, event))
          if (isTerminal) {
            startTransition(applyEvent)
          } else {
            applyEvent()
          }

          if (event.type === "completed") {
            const stepTitle = currentStepLabel(event.step) ?? event.step
            toastTerminalJobOutcome("civ7", "completed", `Hoàn tất ${stepTitle}.`)
          } else if (event.type === "failed") {
            const message =
              typeof event.payload.message === "string"
                ? event.payload.message
                : "Tác vụ thất bại."
            toastTerminalJobOutcome("civ7", "failed", message)
          } else if (event.type === "paused") {
            const message =
              typeof event.payload.message === "string"
                ? event.payload.message
                : "Tác vụ đã tạm dừng hoặc bị hủy."
            toastTerminalJobOutcome("civ7", "paused", message)
          }

          if (isTerminal) {
            void ipc
              .getState()
              .then((persisted) => {
                if (active) {
                  startTransition(() => setState(preparePersistedState(persisted)))
                }
              })
              .catch((error) => {
                if (active) setConnectionError(formatInvokeError(error))
              })
          }
        })

        if (!active) {
          stop()
          return
        }
        unlisten = stop
      } catch (error) {
        if (active) {
          setConnectionError(formatInvokeError(error))
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void initialize()
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  const selectStep = useCallback((step: StepId) => {
    setState((current) => ({ ...current, selectedStep: step }))
    if (isTauriRuntime() && step === "sync") {
      void ipc
        .getState()
        .then((nextState) => {
          startTransition(() => {
            setState((current) =>
              current.selectedStep !== step
                ? current
                : preparePersistedState({ ...nextState, selectedStep: step }),
            )
          })
        })
        .catch((error) => setConnectionError(formatInvokeError(error)))
    }
  }, [startTransition])

  const startJob = useCallback(
    (
      step: StepId,
      mode: "run" | "dry-run" | "resume" = "run",
    ): Promise<{ jobId: string } | null> => {
      if (
        getInFlightJobStart() ||
        jobStartPendingRef.current ||
        activeJobRunningRef.current ||
        isJobStartLocked() ||
        !acquireJobStartLock()
      ) {
        return Promise.resolve(null)
      }

      jobStartPendingRef.current = true

      const promise = (async (): Promise<{ jobId: string } | null> => {
        try {
          if (isTauriRuntime()) {
            const result = await ipc.startJob(step, mode)
            if (!result) {
              holdJobStartLock(1500)
              return null
            }
            holdJobStartLock(1500)
            return result
          }
          setState((current) => ({
            ...current,
            selectedStep: step,
            steps: current.steps.map((item) =>
              item.id === step ? { ...item, status: "running" } : item,
            ),
            activeJob: {
              id: `DEMO-${Date.now()}`,
              step,
              status: "running",
              startedAt: formatDateTime(new Date()),
              elapsed: "00:01",
              progress: 8,
              batchProgress: 24,
              currentFile: "Đang chuẩn bị dữ liệu…",
              processed: 0,
              total: 100,
              throughput: "Đang đo",
            },
          }))
          activeJobRunningRef.current = true
          holdJobStartLock(1500)
          return { jobId: "demo-job" }
        } catch (error) {
          if (isDuplicateJobStartError(error)) {
            holdJobStartLock(1500)
            return null
          }
          releaseJobStartLock()
          throw error
        } finally {
          jobStartPendingRef.current = false
          window.setTimeout(() => {
            if (getInFlightJobStart() === promise) {
              setInFlightJobStart(null)
            }
          }, 1500)
        }
      })()

      setInFlightJobStart(promise)
      return promise
    },
    [],
  )

  const cancelJob = useCallback(async () => {
    if (!state.activeJob) return
    if (isTauriRuntime()) await ipc.cancelJob(state.activeJob.id)
    setState((current) => ({
      ...current,
      activeJob: current.activeJob
        ? { ...current.activeJob, status: "paused", isSavingCache: true }
        : null,
      steps: current.steps.map((item) =>
        item.id === current.activeJob?.step
          ? { ...item, status: "paused" }
          : item,
      ),
    }))
  }, [state.activeJob])

  const saveConfig = useCallback(async (config: AppConfig, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setBusyAction({
        title: "Đang lưu cài đặt…",
        description: "Đang ghi cấu hình và cập nhật pipeline.",
        phase: "saving",
      })
    }
    try {
      if (isTauriRuntime()) {
        const updated = await ipc.saveConfig(config)
        if (options?.silent) {
          setState(formatAppStateDates(updated))
        } else {
          startTransition(() => setState(formatAppStateDates(updated)))
        }
        return
      }
      const apply = () =>
        setState((current) => ({
          ...current,
          config,
          setupComplete: true,
        }))
      if (options?.silent) {
        apply()
      } else {
        startTransition(apply)
      }
    } finally {
      if (!options?.silent) {
        setBusyAction(null)
      }
    }
  }, [startTransition])

  const addKey = useCallback(async (label: string, secret: string) => {
    const created = isTauriRuntime()
      ? await ipc.addApiKey(label, secret)
      : {
          id: `key-${Date.now()}`,
          label,
          maskedSuffix: `•••• ${secret.slice(-4).toUpperCase()}`,
          priority: 99,
          enabled: true,
          status: "unknown" as const,
          localRequests: 0,
        }
    setState((current) => ({
      ...current,
      apiKeys: [...current.apiKeys, created].map((key, index) => ({
        ...key,
        priority: index + 1,
      })),
    }))
  }, [])

  const updateKey = useCallback((key: ApiKeyMeta) => {
    setState((current) => ({
      ...current,
      apiKeys: current.apiKeys.map((item) => (item.id === key.id ? key : item)),
    }))
  }, [])

  const testKey = useCallback(
    async (key: ApiKeyMeta) => {
      const tested = isTauriRuntime()
        ? await ipc.testApiKey(key.id)
        : { ...key, status: "valid" as const, lastUsed: "Vừa kiểm tra" }
      updateKey(tested)
    },
    [updateKey],
  )

  const toggleKey = useCallback(
    async (key: ApiKeyMeta, enabled: boolean) => {
      const updated = isTauriRuntime()
        ? await ipc.setApiKeyEnabled(key.id, enabled)
        : { ...key, enabled }
      updateKey(updated)
    },
    [updateKey],
  )

  const renameKey = useCallback(
    async (key: ApiKeyMeta, label: string) => {
      const updated = isTauriRuntime()
        ? await ipc.renameApiKey(key.id, label)
        : { ...key, label }
      updateKey(updated)
    },
    [updateKey],
  )

  const moveKey = useCallback(
    async (keyId: string, direction: -1 | 1) => {
      const currentIndex = state.apiKeys.findIndex((key) => key.id === keyId)
      const nextIndex = currentIndex + direction
      if (
        currentIndex < 0 ||
        nextIndex < 0 ||
        nextIndex >= state.apiKeys.length
      )
        return
      const reordered = [...state.apiKeys]
      const [moved] = reordered.splice(currentIndex, 1)
      reordered.splice(nextIndex, 0, moved)
      const normalized = reordered.map((key, index) => ({
        ...key,
        priority: index + 1,
      }))
      if (isTauriRuntime()) {
        const persisted = await ipc.reorderApiKeys(
          normalized.map((key) => key.id),
        )
        setState((current) => ({
          ...current,
          apiKeys: persisted,
        }))
        return
      }
      setState((current) => ({ ...current, apiKeys: normalized }))
    },
    [state.apiKeys],
  )

  const deleteKey = useCallback(async (keyId: string) => {
    if (isTauriRuntime()) await ipc.deleteApiKey(keyId)
    setState((current) => ({
      ...current,
      apiKeys: current.apiKeys
        .filter((item) => item.id !== keyId)
        .map((item, index) => ({ ...item, priority: index + 1 })),
    }))
  }, [])

  const restoreBackup = useCallback(async (backupId: string) => {
    setBusyAction({
      title: "Đang khôi phục backup…",
      description: "Đang sao chép file mod và đồng bộ trạng thái pipeline.",
      phase: "applying",
    })
    try {
      if (isTauriRuntime()) {
        if (backupId.startsWith("legend:")) {
          await ipc.restoreLegendBackup(backupId.slice("legend:".length))
          const persisted = await ipc.getState()
          startTransition(() => setState(formatAppStateDates(persisted)))
          return
        }
        const updated = await ipc.restoreBackup(backupId)
        startTransition(() => setState(formatAppStateDates(updated)))
        return
      }
      startTransition(() =>
        setState((current) => ({
          ...current,
          selectedStep: "inspect",
          steps: current.steps.map((step) =>
            step.id === "translate"
              ? {
                  ...step,
                  status: "locked",
                  lockedReason: "Cần chạy lại Đồng bộ sau khi khôi phục.",
                }
              : step,
          ),
        })),
      )
    } finally {
      setBusyAction(null)
    }
  }, [startTransition])

  const deleteBackup = useCallback(async (backupId: string) => {
    setBusyAction({
      title: "Đang xóa backup…",
      description: "Đang cập nhật danh sách backup.",
      phase: "saving",
    })
    try {
      if (isTauriRuntime()) {
        if (backupId.startsWith("legend:")) {
          await ipc.deleteLegendBackup(backupId.slice("legend:".length))
          const persisted = await ipc.getState()
          startTransition(() => setState(formatAppStateDates(persisted)))
          return
        }
        const updated = await ipc.deleteBackup(backupId)
        startTransition(() => setState(formatAppStateDates(updated)))
        return
      }
      startTransition(() =>
        setState((current) => ({
          ...current,
          backups: current.backups.filter((backup) => backup.id !== backupId),
        })),
      )
    } finally {
      setBusyAction(null)
    }
  }, [startTransition])

  const clearReports = useCallback(async () => {
    setBusyAction({
      title: "Đang xóa báo cáo…",
      description: "Đang cập nhật danh sách báo cáo.",
      phase: "saving",
    })
    try {
      if (isTauriRuntime()) {
        const next = await ipc.clearReports()
        startTransition(() => setState(formatAppStateDates(next)))
        return
      }
      startTransition(() =>
        setState((current) => ({ ...current, reports: [] })),
      )
    } finally {
      setBusyAction(null)
    }
  }, [startTransition])

  const clearJobEvents = useCallback(async (step: StepId) => {
    setBusyAction({
      title: "Đang xóa sự kiện job…",
      description: "Đang cập nhật timeline pipeline.",
      phase: "saving",
    })
    try {
      if (isTauriRuntime()) {
        const next = await ipc.clearJobEvents(step)
        startTransition(() => setState(formatAppStateDates(next)))
        return
      }
      startTransition(() =>
        setState((current) => ({
          ...current,
          events: current.events.filter((event) => event.step !== step),
        })),
      )
    } finally {
      setBusyAction(null)
    }
  }, [startTransition])

  const activeKey = useMemo(
    () => resolveActiveTranslateKey(state),
    // resolveActiveTranslateKey chỉ đọc activeJob + apiKeys; giữ deps hẹp tránh recompute thừa.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional narrow deps
    [state.activeJob?.keyId, state.activeJob?.keyIndex, state.apiKeys],
  )

  return {
    state,
    setState,
    loading,
    busyAction,
    connectionError,
    isDesktop: isTauriRuntime(),
    activeKey,
    actions: {
      selectStep,
      startJob,
      cancelJob,
      saveConfig,
      addKey,
      testKey,
      toggleKey,
      renameKey,
      moveKey,
      deleteKey,
      restoreBackup,
      deleteBackup,
      clearReports,
      clearJobEvents,
    },
  }
}

export type AppController = ReturnType<typeof useAppController>
