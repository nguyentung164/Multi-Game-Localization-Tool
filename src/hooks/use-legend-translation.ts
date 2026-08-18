import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  appendLegendConsoleEvent,
  localLegendConsoleEvent,
  shouldKeepLegendConsoleEvent,
  toLegendConsoleEvent,
  type LegendConsoleEvent,
} from "@/lib/legend-console"
import type {
  LegendDedupeResult,
  LegendFileInspection,
  LegendJobEvent,
  LegendPreviewEdit,
  LegendPreviewSummary,
  LegendTranslationApplyResult,
  LegendTranslationEstimate,
  LegendTranslationPreview,
} from "@/lib/legend-types"
import { displayWindowsPath } from "@/lib/path-utils"
import {
  formatInvokeError,
  invokeErrorCode,
  ipc,
  isTauriRuntime,
} from "@/lib/tauri-ipc"
import { toastTerminalJobOutcome } from "@/lib/terminal-toast"
import { useAsyncTask } from "@/hooks/use-async-task"

function withDisplaySourcePath<T extends { sourcePath: string }>(value: T): T {
  const sourcePath = displayWindowsPath(value.sourcePath)
  return sourcePath === value.sourcePath ? value : { ...value, sourcePath }
}

export type LegendPhase =
  | "idle"
  | "inspecting"
  | "ready"
  | "starting"
  | "running"
  | "cancelling"
  | "review"
  | "applying"
  | "applied"
  | "error"

export interface LegendProgress {
  progress: number
  processed: number
  total: number
  currentItem: string
  model?: string
  keyIndex?: number
  workers?: number
}

const emptyProgress: LegendProgress = {
  progress: 0,
  processed: 0,
  total: 0,
  currentItem: "",
}

function stripHanForDemo(text: string): string {
  const next = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, "")
  return next.trim() || "Đã dịch lại"
}

function pushLocalConsoleEvent(
  setEvents: (updater: (current: LegendConsoleEvent[]) => LegendConsoleEvent[]) => void,
  level: "error" | "warning" | "info" | "success",
  title: string,
  description: string,
) {
  setEvents((current) =>
    appendLegendConsoleEvent(
      current,
      localLegendConsoleEvent(level, title, description),
    ),
  )
}

function optionalNumberPayload(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function demoInspection(sourcePath: string): LegendFileInspection {
  return {
    sourcePath,
    fingerprint: "demo-legend-fingerprint",
    totalLines: 4,
    entryCount: 4,
    invalidLines: 0,
    duplicateSources: 0,
    uniqueSourceCount: 4,
    syntaxSourceCount: 2,
    encoding: "utf-8",
    newline: "crlf",
    hasBom: false,
    sample: [
      {
        lineNumber: 1,
        source: "大戟士统领(...)",
        currentTarget: "Đại kích sĩ thống lĩnh(...)",
      },
      {
        lineNumber: 2,
        source: "白马义从统领(...)",
        currentTarget: "Bạch Mã Nghĩa Tòng thống lĩnh(...)",
      },
      {
        lineNumber: 3,
        source: "黄巾渠帅",
        currentTarget: "Khăn vàng Cừ soái",
      },
    ],
    warnings: [],
  }
}

function demoPreview(sourcePath: string): LegendTranslationPreview {
  return {
    previewId: "demo-legend-preview",
    sourcePath,
    sourceFingerprint: "demo-legend-fingerprint",
    createdAt: new Date().toISOString(),
    diffs: [
      {
        lineNumber: 1,
        source: "大戟士统领(...)",
        before: "Đại kích sĩ thống lĩnh(...)",
        after: "Thống lĩnh Đại Kích Sĩ(...)",
        effectiveTarget: "Thống lĩnh Đại Kích Sĩ(...)",
        effectiveAfter: "Thống lĩnh Đại Kích Sĩ(...)",
        selected: true,
        status: "pending",
      },
      {
        lineNumber: 3,
        source: "黄巾渠帅",
        before: "Khăn vàng Cừ soái",
        after: "Cừ soái Khăn Vàng",
        effectiveTarget: "Cừ soái Khăn Vàng",
        effectiveAfter: "Cừ soái Khăn Vàng",
        selected: true,
        status: "pending",
      },
    ],
    diffCount: 2,
    selectedCount: 2,
    hanCount: 0,
    errorCount: 0,
    warningCount: 0,
    stats: {
      itemsTotal: 4,
      itemsTranslated: 4,
      cacheHits: 1,
      apiCalls: 1,
    },
    revision: 1,
    mode: "full",
    glossaryHash: "demo-glossary",
    coverageTranslated: 4,
    coverageTotal: 4,
    qa: {
      passed: true,
      blocking: false,
      revision: 1,
      errors: 0,
      warnings: 0,
      issues: [],
    },
    warnings: [],
  }
}

export function adaptLegendEstimate(
  base: LegendTranslationEstimate,
  nextItems: number,
): LegendTranslationEstimate {
  if (base.items <= 0 || base.items === nextItems) {
    return {
      ...base,
      items: nextItems,
      actionableItems:
        base.actionableItems ?? legendEstimateActionableItems(base),
    }
  }
  const ratio = nextItems / base.items
  const cachedItems = Math.round(base.cachedItems * ratio)
  const lockedItems = Math.round(base.lockedItems * ratio)
  const doneItems = Math.round((base.doneItems ?? 0) * ratio)
  const reusedItems = Math.round((base.reusedItems ?? 0) * ratio)
  const pendingItems = Math.max(
    0,
    nextItems - doneItems - reusedItems - cachedItems - lockedItems,
  )
  const estimatedBatches = Math.max(1, Math.round(base.estimatedBatches * ratio))
  const keyCount = (base.workersUsed ?? 0) + (base.spareKeys ?? 0)
  const workersUsed =
    pendingItems <= 0 || keyCount <= 0
      ? 0
      : Math.min(keyCount, Math.max(1, estimatedBatches))
  const next: LegendTranslationEstimate = {
    items: nextItems,
    doneItems,
    reusedItems,
    cachedItems,
    lockedItems,
    pendingItems,
    workersUsed,
    spareKeys: Math.max(0, keyCount - workersUsed),
    estimatedBatches,
    estimatedApiCalls: Math.max(1, Math.round(base.estimatedApiCalls * ratio)),
    estimatedSecondsMin: Math.round(base.estimatedSecondsMin * ratio),
    estimatedSecondsMax: Math.round(base.estimatedSecondsMax * ratio),
  }
  next.actionableItems = legendEstimateActionableItems(next)
  return next
}

export function estimateLegendTranslation(
  uniqueSourceCount: number,
  batchSize: number,
  enabledKeys = 1,
): LegendTranslationEstimate {
  const items = uniqueSourceCount
  const effectiveBatch = Math.max(1, batchSize)
  const estimatedBatches = Math.ceil(items / effectiveBatch)
  const keys = Math.max(0, enabledKeys)
  const workersUsed =
    items <= 0 || keys <= 0
      ? 0
      : Math.min(keys, Math.max(1, estimatedBatches))
  const spareKeys = Math.max(0, keys - workersUsed)
  return {
    items,
    doneItems: 0,
    reusedItems: 0,
    cachedItems: 0,
    lockedItems: 0,
    pendingItems: items,
    actionableItems: items,
    workersUsed,
    spareKeys,
    estimatedBatches,
    estimatedApiCalls: estimatedBatches,
    estimatedSecondsMin: estimatedBatches * 5,
    estimatedSecondsMax: estimatedBatches * 15,
  }
}

function formatEstimateCount(value: number): string {
  return value.toLocaleString("vi-VN")
}

/** Unique sources incremental translate will process (not just API pending). */
export function legendEstimateActionableItems(
  estimate: LegendTranslationEstimate,
): number {
  if (estimate.actionableItems != null) {
    return Math.max(0, estimate.actionableItems)
  }
  return Math.max(
    0,
    estimate.pendingItems +
      estimate.cachedItems +
      estimate.lockedItems +
      (estimate.reusedItems ?? 0),
  )
}

export function legendTranslateButtonLabel(
  estimate: LegendTranslationEstimate | null,
): string {
  if (estimate == null) {
    return "Dịch câu mới"
  }
  const actionable = legendEstimateActionableItems(estimate)
  if (actionable <= 0) {
    return "Không còn câu mới"
  }
  if (estimate.pendingItems > 0) {
    return `Dịch ${formatEstimateCount(estimate.pendingItems)} câu mới`
  }
  return "Tạo preview từ cache/khóa"
}

export function legendForceTranslateButtonLabel(): string {
  return "Dịch lại tất cả"
}

export function legendInspectEstimateTitle(options: {
  estimate: LegendTranslationEstimate | null
  loading: boolean
  failed: boolean
}): string {
  if (options.loading) {
    return "Đang đếm câu chưa dịch xong"
  }
  if (options.failed || !options.estimate) {
    return "Chưa ước tính được câu cần dịch"
  }
  const { estimate } = options
  const actionable = legendEstimateActionableItems(estimate)
  if (estimate.pendingItems > 0) {
    return `Cần dịch ${formatEstimateCount(estimate.pendingItems)} câu mới`
  }
  if (actionable > 0) {
    return `Còn ${formatEstimateCount(actionable)} câu tạo preview (không gọi API)`
  }
  return "Không còn câu mới cần xử lý"
}

export function legendEstimateSummary(options: {
  estimate: LegendTranslationEstimate | null
  uniqueSourceCount: number
  loading: boolean
  failed: boolean
}): string {
  if (options.loading) {
    return "Đang đếm câu chưa Việt hóa trong file. Câu đã Việt hoặc đã cache không tốn API."
  }
  if (options.failed || !options.estimate) {
    return "Chưa ước tính được số câu cần gọi API. Khi dịch, chỉ câu chưa xong mới gọi Gemini."
  }
  const { estimate } = options
  const minutesMin = Math.max(1, Math.ceil(estimate.estimatedSecondsMin / 60))
  const minutesMax = Math.max(
    minutesMin,
    Math.ceil(estimate.estimatedSecondsMax / 60),
  )
  const time =
    estimate.pendingItems <= 0
      ? "không gọi API"
      : minutesMin === minutesMax
        ? `khoảng ${formatEstimateCount(minutesMin)} phút`
        : `khoảng ${formatEstimateCount(minutesMin)}–${formatEstimateCount(minutesMax)} phút`
  const doneItems = estimate.doneItems ?? 0
  const reusedItems = estimate.reusedItems ?? 0
  const actionable = legendEstimateActionableItems(estimate)
  if (estimate.pendingItems <= 0 && actionable <= 0) {
    return `${formatEstimateCount(doneItems)} nguồn đã Việt. Không còn câu mới để tạo preview.`
  }
  if (estimate.pendingItems <= 0) {
    return `${formatEstimateCount(actionable)} câu sẽ vào preview từ cache/khóa/tái sử dụng · ${formatEstimateCount(doneItems)} đã Việt · ${formatEstimateCount(reusedItems)} tái sử dụng · ${formatEstimateCount(estimate.cachedItems)} cache · ${formatEstimateCount(estimate.lockedItems)} khóa · ${time}.`
  }
  return `Cần dịch ${formatEstimateCount(estimate.pendingItems)} câu mới · ${formatEstimateCount(doneItems)} đã Việt · ${formatEstimateCount(estimate.cachedItems)} cache · ${formatEstimateCount(estimate.lockedItems)} khóa · file có ${formatEstimateCount(options.uniqueSourceCount)} nguồn duy nhất · ${time}.`
}

export function useLegendTranslation(externalJobActive = false) {
  const desktop = isTauriRuntime()
  const [sourcePath, setSourcePath] = useState("")
  const [deployPath, setDeployPath] = useState("")
  const [phase, setPhase] = useState<LegendPhase>("idle")
  const [inspection, setInspection] = useState<LegendFileInspection | null>(
    null,
  )
  const [preview, setPreview] = useState<LegendTranslationPreview | null>(null)
  const [applyResult, setApplyResult] =
    useState<LegendTranslationApplyResult | null>(null)
  const [progress, setProgress] = useState<LegendProgress>(emptyProgress)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<LegendConsoleEvent[]>([])
  const [retranslating, setRetranslating] = useState(false)
  const [savedPreviews, setSavedPreviews] = useState<LegendPreviewSummary[]>([])
  const syncTask = useAsyncTask()
  const activeRef = useRef(true)
  const cancelAfterStartRef = useRef(false)
  const terminalJobsRef = useRef(new Set<string>())
  const isJobActive =
    phase === "starting" ||
    phase === "running" ||
    phase === "cancelling" ||
    phase === "applying" ||
    retranslating ||
    syncTask.loading
  const canMutatePreview =
    !externalJobActive &&
    !isJobActive &&
    !jobId &&
    phase === "review" &&
    preview?.mode === "full"
  const canApply =
    canMutatePreview &&
    Boolean(preview.glossaryHash) &&
    !preview.qaStaleReason &&
    preview.qa.revision === preview.revision &&
    !preview.qa.blocking

  const refreshSavedPreviews = useCallback(async (options?: { silent?: boolean }) => {
      if (!desktop) {
        setSavedPreviews([])
        return []
      }
      try {
        if (options?.silent) {
          const next = await ipc.listLegendPreviews()
          if (activeRef.current) {
            setSavedPreviews(next)
          }
          return next
        }
        const next = await syncTask.run({
          title: "Đang tải danh sách preview…",
          description: "Quét thư mục preview đã lưu.",
          task: () => ipc.listLegendPreviews(),
          renderResult: (value) => {
            if (activeRef.current) {
              setSavedPreviews(value)
            }
          },
        })
        return next ?? []
      } catch {
        if (activeRef.current) {
          setSavedPreviews([])
        }
        return []
      }
    }, [desktop, syncTask.run])

  const adoptPreviewFromPath = useCallback(
    async (previewPath: string) => {
      if (!desktop) return false
      setError(null)
      try {
        const next = await syncTask.run({
          title: "Đang tải preview đã lưu…",
          description: "Đọc diff từ file preview.",
          task: () => ipc.adoptLegendPreviewFromPath(previewPath),
          renderResult: (value) => {
            const preview = withDisplaySourcePath(value)
            setPreview(preview)
            setSourcePath(preview.sourcePath)
            setPhase("review")
          },
        })
        if (!next || !activeRef.current) return Boolean(next)
        await refreshSavedPreviews({ silent: true })
        return true
      } catch (reason) {
        const message = formatInvokeError(reason)
        if (activeRef.current) {
          setError(message)
          pushLocalConsoleEvent(
            setEvents,
            "error",
            "Không tải được preview đã lưu",
            message,
          )
        }
        return false
      }
    },
    [desktop, refreshSavedPreviews, syncTask.run],
  )

  const loadPreview = useCallback(async (options?: { silent?: boolean }): Promise<boolean> => {
      if (!desktop) return false
      const run = async () => {
        const next = await ipc.getLegendTranslationPreview()
        if (!activeRef.current) return Boolean(next)
        if (!next) {
          return false
        }
        startTransition(() => {
          const preview = withDisplaySourcePath(next)
          setSavedPreviews([])
          setPreview(preview)
          setSourcePath(preview.sourcePath)
          setPhase("review")
          setError(null)
        })
        return true
      }
      if (options?.silent) {
        try {
          return await run()
        } catch {
          return false
        }
      }
      try {
        return (
          (await syncTask.run({
            title: "Đang tải preview…",
            description: "Đọc diff dịch từ engine.",
            task: run,
          })) ?? false
        )
      } catch (reason) {
        const lastError = formatInvokeError(reason)
        if (activeRef.current) {
          setError(lastError)
          pushLocalConsoleEvent(
            setEvents,
            "error",
            "Không tải được preview Legend",
            lastError,
          )
        }
        return false
      }
    }, [desktop, syncTask.run])

  useEffect(() => {
    activeRef.current = true
    let unlisten: (() => void) | undefined

    async function initialize() {
      if (!desktop) return
      try {
        const persistedPath = await ipc.getLegendSourcePath()
        if (activeRef.current && persistedPath) {
          setSourcePath(displayWindowsPath(persistedPath))
        }
        const persistedDeployPath = await ipc.getLegendDeployPath()
        if (activeRef.current && persistedDeployPath) {
          setDeployPath(displayWindowsPath(persistedDeployPath))
        }
        unlisten = await ipc.listenToLegendJobEvents(
          (event: LegendJobEvent) => {
            if (!activeRef.current) return
            if (shouldKeepLegendConsoleEvent(event.type)) {
              setEvents((current) =>
                appendLegendConsoleEvent(current, toLegendConsoleEvent(event)),
              )
            }
            if (event.type === "progress") {
              const total =
                optionalNumberPayload(event.payload, "itemsTotal") ??
                optionalNumberPayload(event.payload, "total") ??
                0
              const processed =
                optionalNumberPayload(event.payload, "itemsProcessed") ??
                optionalNumberPayload(event.payload, "processed") ??
                0
              const explicit =
                optionalNumberPayload(event.payload, "itemProgress") ??
                optionalNumberPayload(event.payload, "progress") ??
                optionalNumberPayload(event.payload, "batchProgress")
              setProgress((current) => {
                const nextWorkers = optionalNumberPayload(
                  event.payload,
                  "workers",
                )
                return {
                  progress:
                    explicit ?? (total > 0 ? (processed / total) * 100 : 0),
                  processed,
                  total,
                  currentItem:
                    typeof event.payload.currentFile === "string"
                      ? event.payload.currentFile
                      : typeof event.payload.currentItem === "string"
                        ? event.payload.currentItem
                        : typeof event.payload.file === "string"
                          ? event.payload.file
                          : "",
                  model:
                    typeof event.payload.model === "string"
                      ? event.payload.model
                      : undefined,
                  keyIndex:
                    typeof event.payload.keyIndex === "number"
                      ? event.payload.keyIndex
                      : current.keyIndex,
                  workers:
                    nextWorkers !== undefined ? nextWorkers : current.workers,
                }
              })
              return
            }
            if (event.type === "result") {
              return
            }
            if (event.type === "completed") {
              terminalJobsRef.current.add(event.jobId)
              cancelAfterStartRef.current = false
              setJobId(null)
              setError(null)
              toastTerminalJobOutcome(
                "legend",
                "completed",
                typeof event.payload.message === "string"
                  ? event.payload.message
                  : "Hoàn tất dịch Legend.",
              )
              void (async () => {
                for (let attempt = 0; attempt < 4; attempt += 1) {
                  if (await loadPreview()) return
                  if (attempt < 3) {
                    await new Promise((resolve) =>
                      window.setTimeout(resolve, 200 * (attempt + 1)),
                    )
                  }
                }
                if (!activeRef.current) return
                setError(
                  "Dịch xong nhưng không tải được bảng diff. Hãy tải lại trang hoặc xem Job Console.",
                )
                setPhase("error")
              })().catch((reason) => {
                if (!activeRef.current) return
                setError(formatInvokeError(reason))
                setPhase("error")
              })
              return
            }
            if (event.type === "failed") {
              terminalJobsRef.current.add(event.jobId)
              cancelAfterStartRef.current = false
              setJobId(null)
              const message =
                typeof event.payload.message === "string"
                  ? event.payload.message
                  : "Tác vụ dịch thất bại."
              setError(message)
              setPhase("error")
              toastTerminalJobOutcome("legend", "failed", message)
              return
            }
            if (event.type === "paused") {
              terminalJobsRef.current.add(event.jobId)
              cancelAfterStartRef.current = false
              setJobId(null)
              setError(null)
              setPhase("ready")
              toastTerminalJobOutcome(
                "legend",
                "paused",
                typeof event.payload.message === "string"
                  ? event.payload.message
                  : "Tác vụ Legend đã tạm dừng hoặc bị hủy.",
              )
            }
          },
        )
      } catch (reason) {
        if (activeRef.current) {
          const message = formatInvokeError(reason)
          setError(message)
          setEvents((current) =>
            appendLegendConsoleEvent(
              current,
              localLegendConsoleEvent(
                "error",
                "Không khởi tạo được Legend",
                message,
              ),
            ),
          )
          setPhase("error")
        }
      }
    }

    void initialize()
    return () => {
      activeRef.current = false
      unlisten?.()
    }
  }, [desktop])

  const updateSourcePath = useCallback((path: string) => {
    const normalized = displayWindowsPath(path)
    setSourcePath(normalized)
    setInspection((current) =>
      current?.sourcePath === normalized ? current : null,
    )
    setPreview((current) =>
      current?.sourcePath === normalized ? current : null,
    )
    setApplyResult(null)
    setError(null)
    setPhase((current) => {
      if (
        current === "inspecting" ||
        current === "starting" ||
        current === "running" ||
        current === "cancelling" ||
        current === "applying"
      ) {
        return current
      }
      return "idle"
    })
  }, [])

  const inspect = useCallback(
    async (path = sourcePath) => {
      if (externalJobActive || isJobActive) {
        setError("Đang có tác vụ khác chạy. Hãy đợi tác vụ hoàn tất.")
        return
      }
      const normalized = displayWindowsPath(path)
      if (!normalized) return
      setSourcePath(normalized)
      setPhase("inspecting")
      setError(null)
      setApplyResult(null)
      try {
        await syncTask.run({
          title: "Đang kiểm tra file…",
          description: "Engine đang phân tích cú pháp XUnity.",
          task: async () => {
            const next = desktop
              ? await ipc.inspectLegendFile(normalized)
              : demoInspection(normalized)
            return withDisplaySourcePath(next)
          },
          renderResult: (next) => {
            setSourcePath(next.sourcePath)
            setInspection(next)
            setPreview(null)
            setPhase("ready")
          },
        })
      } catch (reason) {
        const message = formatInvokeError(reason)
        setError(message)
        pushLocalConsoleEvent(setEvents, "error", "Kiểm tra file thất bại", message)
        setPhase("error")
      }
    },
    [desktop, externalJobActive, isJobActive, sourcePath, syncTask.run],
  )

  const chooseFile = useCallback(async () => {
    const selected = await ipc.pickFile(sourcePath, [
      { name: "File bản dịch XUnity", extensions: ["txt"] },
    ])
    if (selected) updateSourcePath(selected)
  }, [sourcePath, updateSourcePath])

  const saveDeployPath = useCallback(async () => {
    if (!desktop) return
    try {
      const saved = await ipc.setLegendDeployPath(deployPath)
      if (saved) {
        setDeployPath(displayWindowsPath(saved))
      } else if (!deployPath.trim()) {
        setDeployPath("")
      }
    } catch (reason) {
      const message = formatInvokeError(reason)
      setError(message)
      pushLocalConsoleEvent(setEvents, "error", "Lưu thư mục deploy thất bại", message)
    }
  }, [deployPath, desktop])

  const chooseDeployFolder = useCallback(async () => {
    const selected = await ipc.pickDirectory(deployPath || undefined)
    if (!selected) return
    setDeployPath(displayWindowsPath(selected))
    if (!desktop) return
    try {
      const saved = await ipc.setLegendDeployPath(selected)
      if (saved) setDeployPath(displayWindowsPath(saved))
    } catch (reason) {
      const message = formatInvokeError(reason)
      setError(message)
      pushLocalConsoleEvent(setEvents, "error", "Lưu thư mục deploy thất bại", message)
    }
  }, [deployPath, desktop])

  const translate = useCallback(async (options?: { forceRetranslate?: boolean }) => {
      const inspectedPath = inspection?.sourcePath
      if (externalJobActive || isJobActive) {
        setError("Đang có tác vụ khác chạy. Hãy đợi tác vụ hoàn tất.")
        return
      }
      if (!inspectedPath || inspectedPath !== sourcePath.trim()) {
        setError("Đường dẫn đã thay đổi. Hãy kiểm tra lại file trước khi dịch.")
        setPhase("error")
        return
      }
      cancelAfterStartRef.current = false
      setError(null)
      setApplyResult(null)
      setPreview(null)
      setProgress(emptyProgress)
      setPhase("starting")
      try {
        if (!desktop) {
          await new Promise((resolve) => window.setTimeout(resolve, 250))
          if (cancelAfterStartRef.current) {
            cancelAfterStartRef.current = false
            setPhase("ready")
            return
          }
          setPreview(demoPreview(inspectedPath))
          setPhase("review")
          return
        }
        const started = await ipc.startLegendTranslation(inspectedPath, {
          forceRetranslate: options?.forceRetranslate ?? false,
        })
        if (terminalJobsRef.current.has(started.jobId)) return
        setJobId(started.jobId)
        if (cancelAfterStartRef.current) {
          setPhase("cancelling")
          try {
            await ipc.cancelJob(started.jobId)
          } catch (reason) {
            if (!terminalJobsRef.current.has(started.jobId)) throw reason
          }
          return
        }
        setPhase("running")
      } catch (reason) {
        cancelAfterStartRef.current = false
        const message = formatInvokeError(reason)
        setError(message)
        pushLocalConsoleEvent(setEvents, "error", "Không bắt đầu được dịch", message)
        setPhase("error")
      }
    }, [desktop, externalJobActive, inspection, isJobActive, sourcePath])

  const updatePreview = useCallback(
    async (edits: LegendPreviewEdit[]) => {
      if (!preview || !canMutatePreview) {
        setError("Preview đang bị khóa bởi một tác vụ khác.")
        return false
      }
      setError(null)
      try {
        const next = await syncTask.run({
          title: "Đang lưu preview…",
          description: "Engine đang ghi chỉnh sửa và chạy QA.",
          phase: "saving",
          task: async () =>
            desktop
              ? await ipc.updateLegendTranslationPreview(preview.previewId, edits)
              : {
                  ...preview,
                  revision: preview.revision + 1,
                  diffs: preview.diffs.map((diff) => {
                    const edit = edits.find(
                      (item) => item.lineNumber === diff.lineNumber,
                    )
                    return edit
                      ? (() => {
                          const effective =
                            edit.selected === false
                              ? diff.before
                              : (edit.editedAfter ?? diff.after)
                          return {
                            ...diff,
                            selected: edit.selected,
                            editedAfter: edit.editedAfter,
                            effectiveTarget: effective,
                            effectiveAfter: effective,
                            status: !edit.selected
                              ? ("rejected" as const)
                              : edit.editedAfter
                                ? ("edited" as const)
                                : ("accepted" as const),
                          }
                        })()
                      : diff
                  }),
                },
          renderResult: (value) => setPreview(value),
        })
        return Boolean(next)
      } catch (reason) {
        const message = formatInvokeError(reason)
        const stale =
          invokeErrorCode(reason) === "legend_preview_stale" ||
          invokeErrorCode(reason) === "stale_preview" ||
          message.includes("đã thay đổi") ||
          message.includes("tải lại")
        if (desktop && stale) {
          const latest = await ipc.getLegendTranslationPreview()
          if (latest) setPreview(latest)
        }
        const nextMessage = stale
          ? "Preview đã đổi revision; đã tải lại dữ liệu mới nhất."
          : message
        setError(nextMessage)
        pushLocalConsoleEvent(
          setEvents,
          stale ? "warning" : "error",
          stale ? "Preview đã cũ" : "Không lưu được chỉnh sửa",
          nextMessage,
        )
        return false
      }
    },
    [canMutatePreview, desktop, preview, syncTask.run],
  )

  const rebuildPreviewQa = useCallback(async () => {
    if (!preview || !canMutatePreview) {
      setError("Preview đang bị khóa bởi một tác vụ khác.")
      return false
    }
    setError(null)
    try {
      const next = await syncTask.run({
        title: "Đang rebuild preview + QA…",
        description: "Engine đang chạy lại QA với glossary hiện tại.",
        phase: "saving",
        task: async () =>
          desktop
            ? await ipc.updateLegendTranslationPreview(preview.previewId, [])
            : preview,
        renderResult: (value) => setPreview(value),
      })
      return Boolean(next)
    } catch (reason) {
      const message = formatInvokeError(reason)
      setError(message)
      pushLocalConsoleEvent(
        setEvents,
        "error",
        "Không rebuild được preview",
        message,
      )
      return false
    }
  }, [canMutatePreview, desktop, preview, syncTask.run])

  const syncLoadingRef = useRef(syncTask.loading)
  syncLoadingRef.current = syncTask.loading

  const runEstimate = useCallback(
    async (
      sourcePath: string,
      options?: { forceRetranslate?: boolean; silent?: boolean },
    ): Promise<LegendTranslationEstimate | undefined> => {
      if (!desktop) {
        return estimateLegendTranslation(
          inspection?.uniqueSourceCount ?? 0,
          50,
          1,
        )
      }
      const estimate = () =>
        ipc.estimateLegendTranslation(sourcePath, {
          forceRetranslate: options?.forceRetranslate ?? false,
        })
      if (options?.silent) {
        return estimate()
      }
      if (syncLoadingRef.current) return undefined
      return syncTask.run({
        title: options?.forceRetranslate
          ? "Đang ước lượng dịch lại…"
          : "Đang ước lượng…",
        description: "Engine đang đếm câu cần dịch.",
        task: estimate,
      })
    },
    [desktop, inspection?.uniqueSourceCount, syncTask.run],
  )

  const retranslateHan = useCallback(
    async (lineNumbers: number[]) => {
      if (!preview || !canMutatePreview) {
        setError("Preview đang bị khóa bởi một tác vụ khác.")
        return false
      }
      if (preview.mode !== "full") {
        setError("Không thể dịch lại preview này.")
        return false
      }
      if (lineNumbers.length === 0) {
        setError("Không có dòng còn chữ Hán để dịch lại.")
        return false
      }
      setError(null)
      setProgress(emptyProgress)
      pushLocalConsoleEvent(
        setEvents,
        "info",
        "Dịch lại chữ Hán",
        `Đang dịch lại ${lineNumbers.length} dòng; mỗi lần gửi tối đa 15 dòng, chạy đến hết.`,
      )
      try {
        const next = await syncTask.run({
          title: "Đang dịch lại chữ Hán…",
          description: "Engine đang gửi batch dịch lại.",
          phase: "fetching",
          task: async () => {
            if (desktop) {
              return ipc.retranslateLegendPreview(preview.previewId, lineNumbers)
            }
            return {
              ...preview,
              revision: preview.revision + 1,
              diffs: preview.diffs.map((diff) => {
                if (!lineNumbers.includes(diff.lineNumber)) return diff
                const after = stripHanForDemo(diff.editedAfter ?? diff.after)
                return {
                  ...diff,
                  after,
                  editedAfter: undefined,
                  selected: true,
                  effectiveTarget: after,
                  effectiveAfter: after,
                  status: "pending" as const,
                }
              }),
            }
          },
        })
        if (!next) return false
        setPreview(next)
        pushLocalConsoleEvent(
          setEvents,
          "success",
          "Đã dịch lại chữ Hán",
          `Đã cập nhật ${lineNumbers.length} dòng.`,
        )
        return true
      } catch (reason) {
        const message = formatInvokeError(reason)
        const stale =
          invokeErrorCode(reason) === "legend_preview_stale" ||
          invokeErrorCode(reason) === "stale_preview" ||
          message.includes("đã thay đổi") ||
          message.includes("tải lại")
        if (desktop && stale) {
          const latest = await ipc.getLegendTranslationPreview()
          if (latest) setPreview(latest)
        }
        const nextMessage = stale
          ? "Preview đã đổi revision; đã tải lại dữ liệu mới nhất."
          : message
        setError(nextMessage)
        pushLocalConsoleEvent(
          setEvents,
          stale ? "warning" : "error",
          stale ? "Preview đã cũ" : "Không dịch lại được chữ Hán",
          nextMessage,
        )
        return false
      }
    },
    [canMutatePreview, desktop, preview, syncTask.run],
  )

  const cancel = useCallback(async () => {
    if (!jobId) {
      if (phase === "starting") {
        cancelAfterStartRef.current = true
        setPhase("cancelling")
      }
      return
    }
    try {
      setPhase("cancelling")
      if (desktop) await ipc.cancelJob(jobId)
      else {
        setJobId(null)
        setPhase("ready")
      }
    } catch (reason) {
      if (jobId && terminalJobsRef.current.has(jobId)) return
      setError(formatInvokeError(reason))
      setPhase("running")
    }
  }, [desktop, jobId, phase])

  const dedupe = useCallback(async (): Promise<LegendDedupeResult | null> => {
    if (externalJobActive || isJobActive) {
      setError("Đang có tác vụ khác chạy. Hãy đợi tác vụ hoàn tất.")
      return null
    }
    const inspectedPath = inspection?.sourcePath
    if (!inspectedPath || inspectedPath !== sourcePath.trim()) {
      setError("Đường dẫn đã thay đổi. Hãy kiểm tra lại file trước khi xóa trùng.")
      return null
    }
    const previousPhase = phase
    setError(null)
    setPhase("inspecting")
    try {
      if (!desktop) {
        setInspection((current) =>
          current
            ? {
                ...current,
                duplicateSources: 0,
                entryCount: current.uniqueSourceCount,
              }
            : current,
        )
        setPreview(null)
        setPhase("ready")
        return {
          sourcePath: inspectedPath,
          removed: inspection.duplicateSources,
          remainingEntries: inspection.uniqueSourceCount,
        }
      }
      return await syncTask.run({
        title: "Đang xóa dòng trùng…",
        description: "Engine đang dedupe file nguồn.",
        phase: "applying",
        task: async () => {
          const result = await ipc.dedupeLegendFile(inspectedPath)
          const next = withDisplaySourcePath(
            await ipc.inspectLegendFile(result.sourcePath),
          )
          return { result, next }
        },
        renderResult: ({ next }) => {
          setSourcePath(next.sourcePath)
          setInspection(next)
          setPreview(null)
          setPhase("ready")
        },
      }).then((payload) => payload?.result ?? null)
    } catch (reason) {
      const message = formatInvokeError(reason)
      setError(message)
      pushLocalConsoleEvent(setEvents, "error", "Xóa trùng thất bại", message)
      if (
        message.includes("job_already_running") ||
        message.includes("tác vụ") ||
        message.includes("job đang")
      ) {
        setPhase(previousPhase)
      } else {
        setPhase("error")
      }
      return null
    }
  }, [
    desktop,
    externalJobActive,
    inspection,
    isJobActive,
    phase,
    sourcePath,
    syncTask.run,
  ])

  const apply = useCallback(async () => {
    if (!preview || !canApply) {
      setError("Preview chưa sẵn sàng để áp dụng.")
      return
    }
    const previousPhase = phase
    setError(null)
    setPhase("applying")
    try {
      await syncTask.run({
        title: "Đang áp dụng bản dịch…",
        description: "Engine đang backup và ghi file nguồn.",
        phase: "applying",
        task: async () => {
          const result = desktop
            ? await ipc.applyLegendTranslation(preview.previewId)
            : {
                previewId: preview.previewId,
                sourcePath,
                backupPath: `${sourcePath}.demo-backup`,
                updatedLines: preview.diffs.length,
              }
          let nextInspection: LegendFileInspection | null = null
          if (desktop) {
            nextInspection = withDisplaySourcePath(
              await ipc.inspectLegendFile(result.sourcePath),
            )
          }
          return { result, nextInspection }
        },
        renderResult: ({ result, nextInspection }) => {
          setApplyResult(result)
          setPreview(null)
          if (nextInspection) {
            setSourcePath(nextInspection.sourcePath)
            setInspection(nextInspection)
          }
          setPhase("applied")
        },
      })
    } catch (reason) {
      const message = formatInvokeError(reason)
      setError(message)
      pushLocalConsoleEvent(setEvents, "error", "Áp dụng thất bại", message)
      if (
        message.includes("job_already_running") ||
        message.includes("tác vụ") ||
        message.includes("job đang")
      ) {
        setPhase(previousPhase)
      } else {
        setPhase("error")
      }
    }
  }, [canApply, desktop, phase, preview, sourcePath, syncTask.run])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  const resetError = useCallback(() => {
    setError(null)
    setPhase(preview ? "review" : inspection ? "ready" : "idle")
  }, [inspection, preview])

  const loadingSavedPreviews =
    syncTask.loading && syncTask.title === "Đang tải danh sách preview…"
  const previewLoading =
    syncTask.loading &&
    (syncTask.title === "Đang tải preview…" ||
      syncTask.title === "Đang tải preview đã lưu…")

  return useMemo(
    () => ({
      sourcePath,
      setSourcePath: updateSourcePath,
      deployPath,
      setDeployPath,
      saveDeployPath,
      chooseDeployFolder,
      phase,
      inspection,
      preview,
      previewLoading,
      applyResult,
      progress,
      jobId,
      error,
      events,
      desktop,
      isJobActive,
      globalJobActive: externalJobActive || isJobActive,
      canMutatePreview,
      canApply,
      retranslating: retranslating || syncTask.loading,
      syncLoading: syncTask.loading,
      busyLabel: syncTask.loading ? syncTask.title : null,
      syncOverlay: {
        loading: syncTask.loading,
        title: syncTask.title,
        description: syncTask.description,
        phase: syncTask.phase,
        phaseLabel: syncTask.phaseLabel,
        progress: syncTask.progress,
      },
      chooseFile,
      inspect,
      translate,
      updatePreview,
      rebuildPreviewQa,
      runEstimate,
      runSyncTask: syncTask.run,
      loadPreview,
      retranslateHan,
      cancel,
      apply,
      dedupe,
      clearEvents,
      resetError,
      savedPreviews,
      loadingSavedPreviews,
      refreshSavedPreviews,
      adoptPreviewFromPath,
    }),
    [
      adoptPreviewFromPath,
      apply,
      clearEvents,
      dedupe,
      applyResult,
      cancel,
      chooseDeployFolder,
      chooseFile,
      deployPath,
      desktop,
      error,
      events,
      externalJobActive,
      isJobActive,
      canMutatePreview,
      canApply,
      inspect,
      inspection,
      jobId,
      loadPreview,
      loadingSavedPreviews,
      phase,
      preview,
      previewLoading,
      progress,
      refreshSavedPreviews,
      resetError,
      retranslateHan,
      retranslating,
      runEstimate,
      syncTask.loading,
      syncTask.run,
      syncTask.title,
      syncTask.description,
      syncTask.phase,
      syncTask.phaseLabel,
      syncTask.progress,
      saveDeployPath,
      savedPreviews,
      sourcePath,
      translate,
      updatePreview,
      rebuildPreviewQa,
      updateSourcePath,
    ],
  )
}

export type LegendTranslationController = ReturnType<
  typeof useLegendTranslation
>
