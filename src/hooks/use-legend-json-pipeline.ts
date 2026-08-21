import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import {
  appendLegendConsoleEvent,
  localLegendConsoleEvent,
  shouldKeepLegendConsoleEvent,
  toLegendConsoleEvent,
  type LegendConsoleEvent,
} from "@/lib/legend-console"
import {
  buildLegendJsonListConfig,
  inferLegendJsonPaths,
  isLegendJsonForceRestoreMessage,
  selectedHashesForRequest,
  type LegendJsonApplyResult,
  type LegendJsonBackup,
  type LegendJsonBackupList,
  type LegendJsonEntry,
  type LegendJsonEntryDetail,
  type LegendJsonEstimate,
  type LegendJsonListResult,
  type LegendJsonPaths,
  type LegendJsonPreview,
  type LegendJsonRestoreResult,
  type LegendJsonScanResult,
  type LegendJsonStatus,
} from "@/lib/legend-json-types"
import {
  buildLegendJsonProgress,
  clearLegendJsonProgress,
  publishLegendJsonProgress,
} from "@/lib/legend-json-progress-store"
import { formatInvokeError, invokeErrorCode, ipc } from "@/lib/tauri-ipc"

export type LegendJsonPipelinePhase = "idle" | "running" | "cancelling"

export function useLegendJsonPipeline(active = false) {
  const [paths, setPaths] = useState<LegendJsonPaths>(() =>
    inferLegendJsonPaths(),
  )
  const [hydrated, setHydrated] = useState(false)
  const [ready, setReady] = useState(false)
  const [scan, setScan] = useState<LegendJsonScanResult | null>(null)
  const [data, setData] = useState<LegendJsonListResult | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [status, setStatus] = useState<LegendJsonStatus>("New")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectAllMatching, setSelectAllMatching] = useState(true)
  const [preview, setPreview] = useState<LegendJsonPreview | null>(null)
  const [backups, setBackups] = useState<LegendJsonBackup[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [events, setEvents] = useState<LegendConsoleEvent[]>([])
  const [phase, setPhase] = useState<LegendJsonPipelinePhase>("idle")
  const [listEpoch, setListEpoch] = useState(0)

  const jobIdRef = useRef<string | null>(null)
  const phaseRef = useRef<LegendJsonPipelinePhase>(phase)
  const busyRef = useRef<string | null>(busy)
  const terminalJobIdsRef = useRef(new Set<string>())
  const listGenerationRef = useRef(0)
  const backupGenerationRef = useRef(0)
  const pageRef = useRef(page)
  const pageSizeRef = useRef(pageSize)
  const statusRef = useRef(status)
  const searchRef = useRef(search)

  phaseRef.current = phase
  busyRef.current = busy
  pageRef.current = page
  pageSizeRef.current = pageSize
  statusRef.current = status
  searchRef.current = search

  useEffect(() => {
    if (active) setHydrated(true)
  }, [active])

  const bumpList = useCallback(() => {
    setListEpoch((current) => current + 1)
  }, [])

  const changeStatusFilter = useCallback((nextStatus: LegendJsonStatus) => {
    setPage(1)
    setStatus(nextStatus)
    setSelected(new Set())
    setSelectAllMatching(true)
  }, [])

  const updatePath = useCallback((key: keyof LegendJsonPaths, value: string) => {
    setPaths((current) => ({ ...current, [key]: value }))
  }, [])

  const applySearch = useCallback((value: string) => {
    setPage(1)
    setSearch(value)
    setSelected(new Set())
    setSelectAllMatching(true)
  }, [])

  const revealEntry = useCallback((source: string) => {
    setPage(1)
    setStatus("All")
    setSearch(source)
    setSelected(new Set())
    setSelectAllMatching(true)
  }, [])

  const changePageSize = useCallback((value: number) => {
    setPage(1)
    setPageSize(value)
  }, [])

  const loadPage = useCallback(
    async (overrides?: {
      page?: number
      status?: LegendJsonStatus
      search?: string
    }) => {
      const generation = ++listGenerationRef.current
      const result = await ipc.runLegendJsonCommand<LegendJsonListResult>(
        "legend-json-list",
        buildLegendJsonListConfig(
          overrides?.page ?? pageRef.current,
          pageSizeRef.current,
          overrides?.status ?? statusRef.current,
          overrides?.search ?? searchRef.current,
        ),
      )
      if (generation !== listGenerationRef.current) return null
      setData(result)
      setReady(true)
      return result
    },
    [],
  )

  const loadBackups = useCallback(async () => {
    const generation = ++backupGenerationRef.current
    try {
      const result = await ipc.runLegendJsonCommand<LegendJsonBackupList>(
        "legend-json-list-backups",
        {},
      )
      if (generation !== backupGenerationRef.current) return
      setBackups(result.items ?? [])
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void ipc.getLegendDeployPath().then((deployPath) => {
      if (!mounted || !deployPath) return
      setPaths((current) => {
        if (current.sourceRoot || current.mainPath || current.runtimePath) {
          return current
        }
        return inferLegendJsonPaths(deployPath)
      })
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let mounted = true
    let unlisten: () => void = () => undefined
    void ipc
      .listenToLegendJobEvents((event) => {
        const command = event.payload.command
        if (
          !mounted ||
          typeof command !== "string" ||
          !command.startsWith("legend-json-")
        ) {
          return
        }
        if (terminalJobIdsRef.current.has(event.jobId)) return

        if (shouldKeepLegendConsoleEvent(event.type, event.payload)) {
          setEvents((current) =>
            appendLegendConsoleEvent(current, toLegendConsoleEvent(event)),
          )
        }

        if (command === "legend-json-translate" && event.type === "started") {
          jobIdRef.current = event.jobId
          setJobId(event.jobId)
          return
        }

        if (command === "legend-json-translate" && event.type === "progress") {
          if (phaseRef.current === "idle") return
          if (jobIdRef.current !== event.jobId) {
            jobIdRef.current = event.jobId
            setJobId(event.jobId)
          }
          const processed = Number(event.payload.processed ?? 0)
          const total = Number(event.payload.total ?? 0)
          if (Number.isFinite(processed) && Number.isFinite(total)) {
            publishLegendJsonProgress(
              buildLegendJsonProgress({
                jobId: event.jobId,
                processed,
                total,
                file:
                  typeof event.payload.file === "string"
                    ? event.payload.file
                    : undefined,
              }),
            )
          }
          return
        }

        if (
          command !== "legend-json-translate" ||
          (event.type !== "completed" &&
            event.type !== "failed" &&
            event.type !== "paused")
        ) {
          return
        }

        terminalJobIdsRef.current.add(event.jobId)
        jobIdRef.current = null
        clearLegendJsonProgress()
        const shouldFallbackReload =
          event.type !== "completed" && busyRef.current !== "translate"
        startTransition(() => {
          setJobId(null)
          setPhase("idle")
        })
        if (shouldFallbackReload) bumpList()
      })
      .then((cleanup) => {
        if (!mounted) {
          cleanup()
          return
        }
        unlisten = cleanup
      })
    return () => {
      mounted = false
      unlisten()
    }
  }, [bumpList])

  useEffect(() => {
    if (!hydrated) return
    const timer = window.setTimeout(() => {
      void loadPage().catch((error) => toast.error(formatInvokeError(error)))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [hydrated, page, pageSize, status, search, listEpoch, loadPage])

  useEffect(() => {
    if (!hydrated) return
    void loadBackups()
  }, [hydrated, loadBackups])

  const execute = useCallback(async <T,>(
    label: string,
    operation: () => Promise<T>,
  ) => {
    setBusy(label)
    try {
      return await operation()
    } catch (error) {
      if (invokeErrorCode(error) === "cancelled") return null
      const message = formatInvokeError(error)
      toast.error(message)
      setEvents((current) =>
        appendLegendConsoleEvent(
          current,
          localLegendConsoleEvent("error", `Không thể ${label}`, message),
        ),
      )
      return null
    } finally {
      setBusy(null)
    }
  }, [])

  const handleScan = useCallback(async () => {
    if (!paths.sourceRoot || !paths.mainPath) {
      toast.error(
        "Hãy chọn thư mục JSON và file AutoGeneratedTranslations.txt chính.",
      )
      return
    }
    const result = await execute("scan", () =>
      ipc.runLegendJsonCommand<LegendJsonScanResult>("legend-json-scan", {
        sourceRoot: paths.sourceRoot,
        mainPath: paths.mainPath,
        runtimePath: paths.runtimePath || null,
      }),
    )
    if (!result) return
    setScan(result)
    setPreview(null)
    setPage(1)
    setSelected(new Set())
    setSelectAllMatching(true)
    bumpList()
    toast.success(`Đã quét ${result.files.toLocaleString("vi-VN")} file JSON.`)
  }, [bumpList, execute, paths.mainPath, paths.runtimePath, paths.sourceRoot])

  const loadDetail = useCallback(
    async (entry: LegendJsonEntry) => {
      return execute("detail", () =>
        ipc.runLegendJsonCommand<LegendJsonEntryDetail>("legend-json-list", {
          sourceHash: entry.sourceHash,
        }),
      )
    },
    [execute],
  )

  const updateEntry = useCallback(
    async (payload: Record<string, unknown>) => {
      const result = await execute("update", () =>
        ipc.runLegendJsonCommand("legend-json-set-rule", payload),
      )
      if (!result) return false
      setPreview(null)
      bumpList()
      return true
    },
    [bumpList, execute],
  )

  const selectionConfig = useMemo(
    () => ({
      hashes: selectedHashesForRequest(selected, selectAllMatching),
      status: status === "All" ? "New" : status,
      search,
      forceRetranslate: status !== "All" && status !== "New",
    }),
    [search, selectAllMatching, selected, status],
  )

  const handleEstimate = useCallback(async () => {
    return execute("estimate", () =>
      ipc.runLegendJsonCommand<LegendJsonEstimate>(
        "legend-json-estimate",
        selectionConfig,
      ),
    )
  }, [execute, selectionConfig])

  const handleTranslate = useCallback(async () => {
    clearLegendJsonProgress()
    setPhase("running")
    const result = await execute("translate", () =>
      ipc.runLegendJsonCommand<{ translated: number; reused: number }>(
        "legend-json-translate",
        selectionConfig,
      ),
    )
    jobIdRef.current = null
    setJobId(null)
    setPhase("idle")
    clearLegendJsonProgress()
    bumpList()
    if (!result) return
    setPreview(null)
    changeStatusFilter("Translated")
    toast.success(
      `Đã dịch ${result.translated} mục, tái sử dụng ${result.reused} mục. Đang hiển thị mục đã dịch.`,
    )
  }, [bumpList, changeStatusFilter, execute, selectionConfig])

  const handlePreview = useCallback(async () => {
    const result = await execute("preview", () =>
      ipc.runLegendJsonCommand<LegendJsonPreview>("legend-json-preview", {
        sourceRoot: paths.sourceRoot,
        mainPath: paths.mainPath,
      }),
    )
    if (result) setPreview(result)
  }, [execute, paths.mainPath, paths.sourceRoot])

  const handleApply = useCallback(async (skipErrors = false) => {
    if (!preview) return
    const result = await execute("apply", () =>
      ipc.runLegendJsonCommand<LegendJsonApplyResult>("legend-json-apply", {
        previewId: preview.previewId,
        skipErrors,
      }),
    )
    if (!result) return
    setPreview(null)
    void loadBackups()
    toast.success(
      result.skippedCount
        ? `Đã Apply ${result.appliedCount.toLocaleString("vi-VN")} dòng OK, bỏ qua ${result.skippedCount.toLocaleString("vi-VN")} dòng lỗi. ${result.instruction}`
        : result.instruction,
    )
  }, [execute, loadBackups, preview])

  const handleRestore = useCallback(
    async (backupId: string, force = false) => {
      setBusy("restore")
      try {
        const result = await ipc.runLegendJsonCommand<LegendJsonRestoreResult>(
          "legend-json-restore",
          { backupId, force },
        )
        if (!result?.restored) {
          return { restored: false, needsForce: false }
        }
        setPreview(null)
        await loadBackups()
        toast.success("Đã phục hồi file chính từ backup.")
        return { restored: true, needsForce: false }
      } catch (error) {
        if (invokeErrorCode(error) === "cancelled") {
          return { restored: false, needsForce: false }
        }
        const message = formatInvokeError(error)
        if (!force && isLegendJsonForceRestoreMessage(message)) {
          return { restored: false, needsForce: true }
        }
        toast.error(message)
        setEvents((current) =>
          appendLegendConsoleEvent(
            current,
            localLegendConsoleEvent("error", "Không thể restore", message),
          ),
        )
        return { restored: false, needsForce: false }
      } finally {
        setBusy(null)
      }
    },
    [loadBackups],
  )

  const cancelTranslation = useCallback(async () => {
    const activeJobId = jobIdRef.current ?? jobId
    if (!activeJobId) return
    setPhase("cancelling")
    try {
      await ipc.cancelJob(activeJobId)
      toast.info("Đã gửi yêu cầu hủy job dịch.")
    } catch (error) {
      if (invokeErrorCode(error) === "cancelled") return
      setPhase("running")
      toast.error(formatInvokeError(error))
    }
  }, [jobId])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  const currentPageHashes = data?.items.map((entry) => entry.sourceHash) ?? []
  const currentPageSelected =
    currentPageHashes.length > 0 &&
    currentPageHashes.every((hash) => selected.has(hash))
  const currentPagePartiallySelected =
    !currentPageSelected &&
    currentPageHashes.some((hash) => selected.has(hash))

  const changePageSelection = useCallback(
    (checked: boolean) => {
      const hashes = data?.items.map((entry) => entry.sourceHash) ?? []
      setSelectAllMatching(false)
      setSelected((current) => {
        const next = selectAllMatching ? new Set<string>() : new Set(current)
        hashes.forEach((hash) =>
          checked ? next.add(hash) : next.delete(hash),
        )
        return next
      })
    },
    [data?.items, selectAllMatching],
  )

  const changeRowSelection = useCallback(
    (sourceHash: string, checked: boolean) => {
      setSelectAllMatching(false)
      setSelected((current) => {
        const next = selectAllMatching ? new Set<string>() : new Set(current)
        if (checked) next.add(sourceHash)
        else next.delete(sourceHash)
        return next
      })
    },
    [selectAllMatching],
  )

  const isJobActive =
    phase === "running" || phase === "cancelling" || busy === "translate"

  return useMemo(
    () => ({
      paths,
      ready,
      scan,
      data,
      page,
      pageSize,
      status,
      search,
      selected,
      selectAllMatching,
      preview,
      backups,
      busy,
      jobId,
      events,
      phase,
      isJobActive,
      totalPages,
      currentPageSelected,
      currentPagePartiallySelected,
      changeStatusFilter,
      updatePath,
      setPage,
      changePageSize,
      applySearch,
      revealEntry,
      setSelectAllMatching,
      setSelected,
      changePageSelection,
      changeRowSelection,
      handleScan,
      handleEstimate,
      handleTranslate,
      handlePreview,
      handleApply,
      handleRestore,
      cancelTranslation,
      loadDetail,
      updateEntry,
      clearEvents,
    }),
    [
      applySearch,
      backups,
      busy,
      cancelTranslation,
      revealEntry,
      changePageSelection,
      changePageSize,
      changeRowSelection,
      changeStatusFilter,
      clearEvents,
      currentPagePartiallySelected,
      currentPageSelected,
      data,
      events,
      handleApply,
      handleEstimate,
      handlePreview,
      handleRestore,
      handleScan,
      handleTranslate,
      isJobActive,
      jobId,
      loadDetail,
      page,
      pageSize,
      paths,
      phase,
      preview,
      ready,
      scan,
      search,
      selectAllMatching,
      selected,
      status,
      totalPages,
      updateEntry,
      updatePath,
    ],
  )
}

export type UseLegendJsonPipelineReturn = ReturnType<typeof useLegendJsonPipeline>
