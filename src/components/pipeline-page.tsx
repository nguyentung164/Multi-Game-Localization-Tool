import { useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowRightIcon,
  BarChart3Icon,
  BracesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  Clock3Icon,
  DatabaseBackupIcon,
  FileCheck2Icon,
  FileDiffIcon,
  FileTextIcon,
  FilterIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  LanguagesIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  CircleStopIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalSquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadCloudIcon,
  ZapIcon,
} from "lucide-react"
import { toast } from "sonner"
import { ApiManagerDialog } from "@/components/api-manager-dialog"
import { JobEventDetailDialog } from "@/components/job-event-detail-dialog"
import { PhaseFade } from "@/components/presence-fade"
import { JobProgressBar } from "@/components/job-progress-bar"
import { InspectPreview } from "@/components/inspect-preview"
import {
  DEFAULT_TABLE_PAGE_SIZE_OPTIONS,
  SYNC_TABLE_PAGE_SIZE_OPTIONS,
  TablePaginator,
} from "@/components/table-paginator"
import {
  Metric,
  PageHeader,
  StatusBadge,
  formatNumber,
  pageContainerClass,
  pageShellClass,
} from "@/components/product-ui"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  actionBtn,
  pipelineFooterActionVariant,
} from "@/lib/action-button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AppController } from "@/hooks/use-app-controller"
import { useJobProgress } from "@/lib/job-progress-store"
import type {
  AppConfig,
  AppView,
  DeployChange,
  EventLevel,
  JobEvent,
  QaIssue,
  StepId,
  SyncChange,
} from "@/lib/app-types"
import { STEP_ORDER } from "@/lib/app-types"
import {
  deploySkippedAfterEmptyPreview,
  DEPLOY_SKIP_NOTHING_TO_WRITE,
  isStepComplete,
  syncApplyPending,
  translateSkippedAfterDeleteOnlySync,
  TRANSLATE_SKIP_AFTER_DELETE_SYNC,
} from "@/lib/pipeline-gates"
import { isDuplicateJobStartError } from "@/lib/job-start-lock"
import { formatInvokeError, ipc } from "@/lib/tauri-ipc"
import { formatRelativeTime } from "@/lib/format-date"
import { formatLocDisplayText } from "@/lib/loc-text"
import { cn } from "@/lib/utils"

import { resolveModFilePath } from "@/lib/path-utils"
import { qaRuleLabel } from "@/lib/qa-labels"
import {
  getTranslateKeyOrder,
  getTranslateModelChain,
  resolveTranslateKeyId,
} from "@/lib/translate-session"

const INITIAL_EVENT_LIMIT = 50
const EVENT_LIMIT_STEP = 50
const EVENT_TIMELINE_ESTIMATE_PX = 56

type PipelineRenderPhase = "shell" | "details" | "full"

function usePipelineRenderPhase(active: boolean) {
  const [phase, setPhase] = useState<PipelineRenderPhase>("shell")
  const warmedRef = useRef(false)

  useEffect(() => {
    if (!active) {
      if (warmedRef.current) return
      let cancelled = false
      const warm = () => {
        requestAnimationFrame(() => {
          if (cancelled) return
          setPhase("details")
          requestAnimationFrame(() => {
            if (cancelled) return
            setPhase("full")
            warmedRef.current = true
          })
        })
      }
      const frameId = requestAnimationFrame(warm)
      return () => {
        cancelled = true
        cancelAnimationFrame(frameId)
      }
    }

    if (warmedRef.current) {
      setPhase("full")
      return
    }

    setPhase("shell")
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      if (cancelled) return
      setPhase("details")
      requestAnimationFrame(() => {
        if (cancelled) return
        setPhase("full")
        warmedRef.current = true
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [active])

  return phase
}

function PipelineDeferredSections({
  phase,
  controller,
  starting,
  onNavigate,
  onManageKeys,
}: {
  phase: PipelineRenderPhase
  controller: AppController
  starting: boolean
  onNavigate: (view: AppView) => void
  onManageKeys: () => void
}) {
  const { state } = controller
  const selectedStep = state.steps.find(
    (step) => step.id === state.selectedStep,
  )!

  return (
    <PhaseFade phaseKey={phase} className="flex flex-col gap-4">
      {phase === "shell" ? (
        <div className="grid gap-4">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-52 w-full" />
        </div>
      ) : (
        <>
          <StepCards controller={controller} onNavigate={onNavigate} />

          {selectedStep.lockedReason && (
            <Alert>
              <AlertCircleIcon />
              <AlertTitle>Bước này chưa thể chạy</AlertTitle>
              <AlertDescription>{selectedStep.lockedReason}</AlertDescription>
            </Alert>
          )}

          {translateSkippedAfterDeleteOnlySync(state) &&
            ["translate", "deploy"].includes(state.selectedStep) && (
              <Alert className="border-success/30 bg-success/10">
                <CheckCircle2Icon />
                <AlertTitle>Bước Dịch đã được bỏ qua</AlertTitle>
                <AlertDescription>
                  {TRANSLATE_SKIP_AFTER_DELETE_SYNC} Bạn có thể chuyển sang Deploy.
                </AlertDescription>
              </Alert>
            )}

          {deploySkippedAfterEmptyPreview(state) &&
            state.selectedStep === "deploy" && (
              <Alert className="border-success/30 bg-success/10">
                <CheckCircle2Icon />
                <AlertTitle>Bước Deploy đã được bỏ qua</AlertTitle>
                <AlertDescription>{DEPLOY_SKIP_NOTHING_TO_WRITE}</AlertDescription>
              </Alert>
            )}

          {phase === "full" ? (
            <>
              <StepPreviewPanel
                controller={controller}
                starting={starting}
                onManageKeys={onManageKeys}
              />
              <JobConsole controller={controller} />
            </>
          ) : (
            <div className="grid gap-4">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-96 w-full" />
            </div>
          )}
        </>
      )}
    </PhaseFade>
  )
}

function computeQaMetrics(issues: QaIssue[], skipped?: number) {
  const xmlRules = new Set([
    "invalid-file",
    "xml-structure",
    "vtt-structure",
    "missing-file",
    "extra-file",
  ])
  return {
    untranslated: issues.filter((issue) => issue.rule === "untranslated")
      .length,
    missingToken: issues.filter((issue) => issue.rule === "missing-token")
      .length,
    xmlErrors: issues.filter((issue) => xmlRules.has(issue.rule)).length,
    lengthIssues: 0,
    skipped: skipped ?? 0,
  }
}

function preventDialogClickThrough(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function stepWorkingDirectory(config: AppConfig, step: StepId): string | null {
  const path =
    step === "export" || step === "inspect"
      ? config.exportPath
      : step === "sync" || step === "translate"
        ? config.modPath
        : config.gamePath
  const trimmed = path.trim()
  return trimmed ? trimmed : null
}

const stepIcons = {
  export: UploadCloudIcon,
  inspect: FileCheck2Icon,
  sync: RefreshCwIcon,
  translate: LanguagesIcon,
  deploy: RocketIcon,
}

const deployKindLabels: Record<DeployChange["kind"], string> = {
  copy: "Ghi đè",
  create: "Tạo mới",
  skip: "Bỏ qua",
  unchanged: "Không đổi",
}

const eventIcons = {
  info: ActivityIcon,
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  error: AlertCircleIcon,
}

const eventLevelIconStyles: Record<JobEvent["level"], string> = {
  info: "bg-surface-gradient text-info",
  success: "bg-surface-gradient text-success",
  warning: "bg-surface-gradient text-warning-foreground dark:text-warning",
  error: "bg-surface-gradient text-destructive",
}

const eventLevelCardStyles: Record<JobEvent["level"], string> = {
  info: "border-info/35 bg-info/5",
  success: "border-success/35 bg-success/5",
  warning: "border-warning/35 bg-warning/5",
  error: "border-destructive/30 bg-destructive/5",
}

const changeLabels: Record<SyncChange["kind"], string> = {
  add: "Thêm",
  delete: "Xóa",
  update: "Cập nhật",
  vtt: "VTT",
  warning: "Cảnh báo",
}

/** Text sync: undefined = không áp dụng; "" = tag trống. */
function syncTextCell(value: string | undefined) {
  if (value === undefined) return "—"
  if (value.trim() === "") return "(trống)"
  return value
}

function isSyncDelete(change: SyncChange): boolean {
  if (change.kind === "delete") return true
  if (
    change.kind === "vtt" &&
    change.before !== undefined &&
    change.after === undefined
  ) {
    return true
  }
  return false
}

function resolveSyncText(change: SyncChange): string | undefined {
  if (change.text !== undefined) return change.text
  if (isSyncDelete(change)) return change.before
  return change.after
}

/** Mỗi dòng preview chỉ có một phía text có nghĩa — không phải diff Trước/Sau. */
function syncChangeContent(change: SyncChange): { text: string; note: string } {
  const raw = resolveSyncText(change)
  if (raw === undefined) {
    return { text: "—", note: "Chưa có text · chạy lại dry-run Đồng bộ" }
  }
  return {
    text: syncTextCell(raw),
    note: isSyncDelete(change) ? "Đã VH · sẽ mất" : "Chưa VH · sẽ thêm",
  }
}

type SyncFileGroup = {
  file: string
  items: SyncChange[]
}

function groupSyncChangesByFile(changes: SyncChange[]): SyncFileGroup[] {
  const groups = new Map<string, SyncChange[]>()
  for (const change of changes) {
    const list = groups.get(change.file)
    if (list) list.push(change)
    else groups.set(change.file, [change])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([file, items]) => ({ file, items }))
}

function PipelineStepper({ controller }: { controller: AppController }) {
  const { state, actions } = controller
  return (
    <nav aria-label="Tiến trình pipeline" className="overflow-x-auto pb-1 pt-1">
      <ol className="grid w-full min-w-0 grid-cols-5">
        {state.steps.map((step, index) => {
          const Icon = stepIcons[step.id]
          const selected = state.selectedStep === step.id
          const completed =
            step.status === "success" || step.status === "warning"
          return (
            <li key={step.id} className="relative">
              {index < state.steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-8 left-[calc(50%+1.25rem)] h-px w-[calc(100%-2.5rem)]",
                    completed ? "bg-success" : "bg-border",
                  )}
                />
              )}
              <button
                type="button"
                aria-current={selected ? "step" : undefined}
                onClick={() => actions.selectStep(step.id)}
                className="group relative flex w-full flex-col items-center gap-2 rounded-lg px-2 py-1 text-center outline-none transition-[transform,opacity] focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-14 items-center justify-center">
                  <span
                    className={cn(
                      "relative flex size-10 items-center justify-center rounded-full bg-surface-gradient transition-[box-shadow,filter]",
                      selected &&
                      "shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_25%,transparent)]",
                      step.status === "success" && "text-success",
                      step.status === "warning" &&
                      "text-warning-foreground dark:text-warning",
                      step.status === "running" && "text-info",
                      step.status === "failed" && "text-destructive",
                      step.status === "locked" && "text-muted-foreground",
                      step.status === "ready" && "text-primary",
                      step.status === "paused" &&
                      "text-warning-foreground dark:text-warning",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    <span className="sr-only">Bước {index + 1}</span>
                  </span>
                </span>
                <span
                  className={cn(
                    "text-sm font-medium transition-colors",
                    selected ? "text-primary" : "text-foreground",
                  )}
                >
                  {step.shortTitle}
                </span>
                <span
                  className={cn(
                    "text-xs transition-colors",
                    selected ? "text-primary/70" : "text-muted-foreground",
                  )}
                >
                  {step.lastRun ?? `Bước ${index + 1}`}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function CurrentJobHero({ controller }: { controller: AppController }) {
  const { state } = controller
  const job = useJobProgress()
  const step = job
    ? state.steps.find((item) => item.id === job.step)
    : state.steps.find((item) => item.status === "ready")

  if (!job) {
    const Icon = step ? stepIcons[step.id] : CheckCircle2Icon
    return (
      <Card className="overflow-hidden border-primary/20 bg-linear-to-br from-primary/8 via-card to-accent/10">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Icon aria-hidden="true" />
            </span>
            <div>
              <CardDescription>Hành động tiếp theo</CardDescription>
              <CardTitle>{step?.title ?? "Pipeline đã hoàn tất"}</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {step?.description ??
              "Không còn tác vụ bắt buộc. Bạn có thể xem báo cáo hoặc chạy lại một bước."}
          </p>
        </CardContent>
      </Card>
    )
  }

  const Icon = stepIcons[job.step]
  return (
    <Card className="overflow-hidden border-info/25 bg-linear-to-br from-info/10 via-card to-primary/8">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-info text-info-foreground shadow-sm">
            <Icon aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <CardDescription>Tác vụ hiện tại · {job.id}</CardDescription>
            <CardTitle className="truncate">{step?.title}</CardTitle>
          </div>
        </div>
        <CardAction>
          <StatusBadge
            status={job.status === "running" ? "running" : job.status}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <JobProgressBar />
        {((job.workers ?? 0) > 0 || job.batchProgress > 0) && (
          <p className="truncate text-xs text-muted-foreground">
            {job.workers ? `${job.workers} luồng · ` : ""}
            {Math.round(job.batchProgress || job.progress)}%
            {job.model ? ` · ${job.model}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function StepCards({
  controller,
  onNavigate,
}: {
  controller: AppController
  onNavigate: (view: AppView) => void
}) {
  const { state, actions } = controller

  const openExportFolder = (event: MouseEvent) => {
    event.stopPropagation()
    const exportPath = stepWorkingDirectory(state.config, "export")
    if (!exportPath) {
      toast.error("Chưa cấu hình exportPath.")
      return
    }
    void ipc
      .openFile(exportPath)
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  const openSearch = (event: MouseEvent) => {
    event.stopPropagation()
    onNavigate("search")
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-5">
      {state.steps.map((step, index) => {
        const Icon = stepIcons[step.id]
        const selected = step.id === state.selectedStep
        const completed = isStepComplete(step.status)
        const showExportFolder =
          step.id === "export" &&
          completed &&
          Boolean(stepWorkingDirectory(state.config, "export"))
        const showEditorShortcut = step.id === "translate" && completed
        return (
          <Card
            key={step.id}
            className={cn(
              "h-full cursor-pointer transition-[filter] hover:brightness-[1.02]",
              selected && "interactive-surface-active",
            )}
            onClick={() => actions.selectStep(step.id)}
          >
            <CardHeader>
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary-soft-gradient text-primary">
                <Icon aria-hidden="true" className="size-4" />
              </div>
              <CardAction>
                <StatusBadge status={step.status} />
              </CardAction>
              <CardTitle className="text-base">
                {index + 1}. {step.title}
              </CardTitle>
              <CardDescription>{step.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {step.summary.files !== undefined && (
                  <span>{formatNumber(step.summary.files)} file</span>
                )}
                {step.summary.changes !== undefined && (
                  <span>{formatNumber(step.summary.changes)} thay đổi</span>
                )}
                {step.summary.translated !== undefined && (
                  <span>{formatNumber(step.summary.translated)} đã dịch</span>
                )}
                {step.summary.warnings !== undefined && (
                  <span>{formatNumber(step.summary.warnings)} cảnh báo</span>
                )}
              </div>
            </CardContent>
            <CardFooter className="mt-auto justify-between gap-2 px-(--card-spacing) py-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {step.lastRun ?? "Chưa chạy"}
              </span>
              <div className="flex shrink-0 items-center">
                {showExportFolder && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-label="Mở thư mục export"
                        onClick={openExportFolder}
                      >
                        <FolderOpenIcon className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Mở thư mục export</TooltipContent>
                  </Tooltip>
                )}
                {showEditorShortcut && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-label="Mở Tra cứu"
                        onClick={openSearch}
                      >
                        <SearchIcon className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Mở Tra cứu</TooltipContent>
                  </Tooltip>
                )}
                {!showExportFolder && !showEditorShortcut && (
                  <ArrowRightIcon aria-hidden="true" className="size-4" />
                )}
              </div>
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}

function EventTimelineItem({
  event,
  showConnector,
}: {
  event: JobEvent
  showConnector: boolean
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const Icon = eventIcons[event.level]
  return (
    <div className="relative flex gap-2">
      {showConnector && (
        <span
          aria-hidden="true"
          className="absolute top-5 bottom-0 left-2.5 w-px bg-border"
        />
      )}
      <span
        className={cn(
          "relative mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          eventLevelIconStyles[event.level],
        )}
      >
        <Icon aria-hidden="true" className="size-3" />
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-md bg-card-surface p-2",
          eventLevelCardStyles[event.level],
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            <p className="text-xs font-medium leading-snug">{event.title}</p>
            {event.detail !== undefined && (
              <>
                <Button
                  className="h-6 shrink-0 px-1.5"
                  size="xs"
                  variant="ghost"
                  onClick={() => setDetailOpen(true)}
                >
                  <BracesIcon data-icon="inline-start" />
                  Chi tiết kỹ thuật
                </Button>
                {detailOpen && (
                  <JobEventDetailDialog
                    open={detailOpen}
                    onOpenChange={setDetailOpen}
                    title={event.title}
                    timestamp={event.timestamp}
                    detail={event.detail}
                  />
                )}
              </>
            )}
            {event.count && (
              <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
                Lặp lại {event.count} lần
              </Badge>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {event.timestamp}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {event.description || "Không có mô tả chi tiết."}
        </p>
      </div>
    </div>
  )
}

function EventTimeline({
  events,
  autoScroll,
}: {
  events: JobEvent[]
  autoScroll: boolean
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => EVENT_TIMELINE_ESTIMATE_PX,
    overscan: 6,
  })

  const firstEventId = events[0]?.id
  useEffect(() => {
    if (!autoScroll || events.length === 0) return
    const node = parentRef.current
    if (!node) return
    const frameId = window.requestAnimationFrame(() => {
      if (typeof node.scrollTo === "function") {
        node.scrollTo({ top: 0 })
      } else {
        node.scrollTop = 0
      }
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [autoScroll, events.length, firstEventId])

  return (
    <div ref={parentRef} className="h-64 overflow-auto pr-1">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const event = events[virtualRow.index]
          if (!event) return null
          return (
            <div
              key={event.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute top-0 left-0 w-full pb-1"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <EventTimelineItem
                event={event}
                showConnector={virtualRow.index < events.length - 1}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

const JobConsole = function JobConsole({
  controller,
}: {
  controller: AppController
}) {
  const { state, actions } = controller
  const [level, setLevel] = useState<EventLevel | "all">("all")
  const [autoScroll, setAutoScroll] = useState(true)
  const [eventLimit, setEventLimit] = useState(INITIAL_EVENT_LIMIT)
  const stepEvents = useMemo(
    () => state.events.filter((event) => event.step === state.selectedStep),
    [state.events, state.selectedStep],
  )
  const filteredEvents = useMemo(
    () =>
      stepEvents.filter((event) => level === "all" || event.level === level),
    [stepEvents, level],
  )
  const displayEvents = useMemo(
    () => filteredEvents.slice(0, eventLimit),
    [filteredEvents, eventLimit],
  )
  const hiddenEventCount = Math.max(
    0,
    filteredEvents.length - displayEvents.length,
  )

  const eventLimitResetKey = `${state.selectedStep}:${level}`
  const [trackedEventLimitKey, setTrackedEventLimitKey] =
    useState(eventLimitResetKey)
  if (eventLimitResetKey !== trackedEventLimitKey) {
    setTrackedEventLimitKey(eventLimitResetKey)
    setEventLimit(INITIAL_EVENT_LIMIT)
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <TerminalSquareIcon aria-hidden="true" className="size-4" />
          </span>
          <div>
            <CardTitle>Job Console</CardTitle>
            <CardDescription>
              Dòng hoạt động có cấu trúc · raw log mặc định được ẩn
            </CardDescription>
          </div>
        </div>
        <CardAction className="flex items-center gap-1">
          <Select
            value={level}
            onValueChange={(value) => setLevel(value as EventLevel | "all")}
          >
            <SelectTrigger size="sm" aria-label="Lọc mức độ">
              <ListFilterIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="info">Thông tin</SelectItem>
                <SelectItem value="success">Thành công</SelectItem>
                <SelectItem value="warning">Cảnh báo</SelectItem>
                <SelectItem value="error">Lỗi</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={autoScroll}
                onPressedChange={setAutoScroll}
                aria-label="Tự cuộn"
              >
                <ArrowRightIcon className="rotate-90" />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>Tự cuộn theo sự kiện mới</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="destructive"
                aria-label="Xóa nhật ký"
                disabled={stepEvents.length === 0}
                onClick={() => {
                  setEventLimit(INITIAL_EVENT_LIMIT)
                  void actions
                    .clearJobEvents(state.selectedStep)
                    .then(() => toast.success("Đã xóa nhật ký bước này."))
                    .catch((error) => toast.error(formatInvokeError(error)))
                }}
              >
                <Trash2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Xóa nhật ký bước này</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent>
        {stepEvents.length > 0 ? (
          <div className="flex flex-col gap-2">
            <EventTimeline events={displayEvents} autoScroll={autoScroll} />
            {hiddenEventCount > 0 && (
              <Button
                variant="outline"
                size="xs"
                className="self-center"
                onClick={() =>
                  setEventLimit((current) => current + EVENT_LIMIT_STEP)
                }
              >
                Xem thêm{" "}
                {formatNumber(Math.min(EVENT_LIMIT_STEP, hiddenEventCount))} sự
                kiện
              </Button>
            )}
          </div>
        ) : (
          <div className="flex h-28 flex-col items-center justify-center gap-1 text-center">
            <ActivityIcon
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            <p className="text-xs font-medium">Chưa có hoạt động cho bước này</p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Sự kiện có cấu trúc sẽ xuất hiện khi tác vụ bắt đầu.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TranslationMonitor({
  controller,
  onManageKeys,
}: {
  controller: AppController
  onManageKeys: () => void
}) {
  const { state, activeKey } = controller
  if (state.selectedStep !== "translate") return null
  const running = state.activeJob?.status === "running"
  const liveModel =
    (running ? state.activeJob?.model : undefined) ?? state.config.model
  const liveKeyId = resolveTranslateKeyId(state.apiKeys, state.activeJob)
  const translateKeyOrder = getTranslateKeyOrder(state.apiKeys)
  const keyIndex = liveKeyId
    ? translateKeyOrder.findIndex((key) => key.id === liveKeyId) + 1
    : activeKey
      ? state.apiKeys.findIndex((key) => key.id === activeKey.id) + 1
      : 0
  const modelChain = getTranslateModelChain(state.config)
  const displayKey = liveKeyId
    ? (state.apiKeys.find((key) => key.id === liveKeyId) ?? activeKey)
    : activeKey
  const activeKeys = translateKeyOrder.filter((key) => key.status === "active")
  const spareKeys = translateKeyOrder.filter(
    (key) =>
      key.enabled &&
      key.status !== "active" &&
      key.status !== "quota-exhausted" &&
      key.status !== "invalid",
  )
  const runningWorkers =
    state.activeJob?.workers ?? (running ? Math.max(1, activeKeys.length) : 0)
  const showCollapsedKeys = translateKeyOrder.length >= 8
  const visibleKeys = showCollapsedKeys
    ? [
      ...activeKeys,
      ...translateKeyOrder.filter(
        (key) =>
          key.status === "quota-exhausted" || key.status === "rate-limited",
      ),
    ].filter(
      (key, index, list) => list.findIndex((item) => item.id === key.id) === index,
    )
    : translateKeyOrder
  const hiddenKeyCount = Math.max(
    0,
    translateKeyOrder.length - visibleKeys.length,
  )
  return (
    <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-lg bg-success-soft-gradient text-success">
              <KeyRoundIcon aria-hidden="true" className="size-4" />
            </span>
            <div>
              <CardTitle>API đang sử dụng</CardTitle>
              <CardDescription>
                {running
                  ? `Đang chạy ${runningWorkers} · Dự phòng ${spareKeys.length}`
                  : "Credential được che ở mọi lớp giao diện"}
              </CardDescription>
            </div>
          </div>
          <CardAction>
            <Button size="sm" variant={actionBtn.manageApi} onClick={onManageKeys}>
              <KeyRoundIcon data-icon="inline-start" />
              Quản lý API
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {displayKey ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {running && liveKeyId === displayKey.id ? (
                  <span className="relative flex size-3">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex size-3 rounded-full bg-success" />
                  </span>
                ) : (
                  <span className="inline-flex size-3 rounded-full bg-success" />
                )}
                <p className="font-semibold">{displayKey.label}</p>
                <Badge variant="outline">
                  Key {keyIndex}/
                  {translateKeyOrder.length || state.apiKeys.length}
                </Badge>
                <code className="text-xs text-muted-foreground">
                  {displayKey.maskedSuffix}
                </code>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric
                  icon={SparklesIcon}
                  label={running ? "Model đang chạy" : "Model"}
                  value={liveModel}
                />
                <Metric
                  icon={ZapIcon}
                  label="Request cục bộ"
                  value={`${displayKey.localRequests} hôm nay`}
                />
                <Metric
                  icon={Clock3Icon}
                  label="Bắt đầu dùng"
                  value={
                    running && liveKeyId === displayKey.id
                      ? (displayKey.activeSince ??
                        state.activeJob?.startedAt ??
                        "Vừa bắt đầu")
                      : (displayKey.activeSince ?? "Chưa dùng")
                  }
                />
              </div>
            </>
          ) : (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Không có API khả dụng</AlertTitle>
              <AlertDescription>
                Thêm hoặc bật lại API key để tiếp tục tác vụ dịch.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chuỗi fallback</CardTitle>
          <CardDescription>
            Model fallback trên từng key; hết quota ngày thì worker lấy key dự
            phòng
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Thứ tự model
            </p>
            <ol className="flex flex-wrap items-center gap-1.5">
              {modelChain.map((model, index, models) => {
                const isLive = running && model === liveModel
                return (
                  <li
                    key={`${model}-${index}`}
                    className="flex items-center gap-1.5"
                  >
                    <Badge
                      variant="outline"
                      className={cn(
                        isLive &&
                        "font-medium text-primary shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_22%,transparent)]",
                        !isLive &&
                        index === 0 &&
                        !running &&
                        "text-primary",
                      )}
                    >
                      {model}
                      {isLive && " · đang chạy"}
                    </Badge>
                    {index < models.length - 1 && (
                      <span className="text-xs text-muted-foreground">→</span>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              API key theo ưu tiên
            </p>
            <ol className="flex flex-wrap items-center gap-1.5">
              {visibleKeys.map((key) => {
                const isLive = running && key.status === "active"
                const statusHint = isLive
                  ? " · đang chạy"
                  : key.status === "rate-limited"
                    ? " · rate limit"
                    : key.status === "quota-exhausted"
                      ? " · hết quota"
                      : !running && key.id === translateKeyOrder[0]?.id
                        ? " · ưu tiên"
                        : ""
                return (
                  <li key={key.id} className="flex items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className={cn(
                        isLive &&
                        "font-medium text-success shadow-[0_0_0_2px_color-mix(in_oklch,var(--success)_22%,transparent)]",
                        !isLive &&
                        key.status === "quota-exhausted" &&
                        "text-destructive",
                        !isLive &&
                        key.status === "rate-limited" &&
                        "text-warning-foreground dark:text-warning",
                        !isLive &&
                        !running &&
                        key.id === translateKeyOrder[0]?.id &&
                        "text-primary",
                        !isLive &&
                        running &&
                        spareKeys.some((spare) => spare.id === key.id) &&
                        "opacity-60",
                      )}
                    >
                      {key.label}
                      {statusHint}
                    </Badge>
                  </li>
                )
              })}
              {hiddenKeyCount > 0 && (
                <li>
                  <Badge variant="outline" className="opacity-70">
                    +{hiddenKeyCount} key
                  </Badge>
                </li>
              )}
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SyncPreview({ controller }: { controller: AppController }) {
  const { state } = controller
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<"all" | SyncChange["kind"]>("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(
    SYNC_TABLE_PAGE_SIZE_OPTIONS[1],
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [detail, setDetail] = useState<SyncChange | null>(null)

  const filtered = useMemo(
    () =>
      state.syncChanges.filter(
        (change) =>
          (kind === "all" || change.kind === kind) &&
          `${change.file} ${change.tag}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
      ),
    [state.syncChanges, kind, query],
  )
  const deferredFiltered = useDeferredValue(filtered)
  const fileGroups = useMemo(
    () => groupSyncChangesByFile(deferredFiltered),
    [deferredFiltered],
  )
  const totalPages = Math.max(1, Math.ceil(fileGroups.length / pageSize))
  const syncFilterKey = `${kind}:${query}:${pageSize}`
  const [trackedSyncFilterKey, setTrackedSyncFilterKey] = useState(syncFilterKey)
  const syncFiltersChanged = syncFilterKey !== trackedSyncFilterKey
  if (syncFiltersChanged) {
    setTrackedSyncFilterKey(syncFilterKey)
    setExpanded(new Set())
  }
  const safePage = syncFiltersChanged ? 1 : Math.min(page, totalPages)
  if (page !== safePage) {
    setPage(safePage)
  }
  const pageGroups = fileGroups.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  )
  const changeRowNumbers = useMemo(() => {
    const numbers = new Map<string, number>()
    filtered.forEach((change, index) => {
      numbers.set(change.id, index + 1)
    })
    return numbers
  }, [filtered])

  if (state.selectedStep !== "sync") return null

  const affectedFiles = new Set(
    state.syncChanges.map((change) => change.file.toLowerCase()),
  ).size
  const syncPreview = state.syncPreview
  const tabs = [
    ["all", "Tất cả"],
    ["add", "Thêm"],
    ["delete", "Xóa"],
    ["update", "Cập nhật"],
    ["vtt", "VTT"],
    ["warning", "Cảnh báo"],
  ] as const

  const toggleFile = (file: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Xem trước đồng bộ</CardTitle>
            <CardDescription>
              Chỉ thêm/xóa file & dòng theo cấu trúc EN · tag đã khớp giữ nguyên
              bản dịch VH · fingerprint còn hiệu lực
            </CardDescription>
          </div>
          <CardAction>
            <Badge variant="outline" className="text-success">
              <DatabaseBackupIcon data-icon="inline-start" />
              Sẽ tạo backup
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              icon={FileDiffIcon}
              label="Tổng thay đổi"
              value={formatNumber(
                state.steps.find((step) => step.id === "sync")?.summary
                  .changes ?? state.syncChanges.length,
              )}
            />
            <Metric
              icon={FileTextIcon}
              label="File bị ảnh hưởng"
              value={formatNumber(affectedFiles)}
            />
            <Metric
              icon={ShieldCheckIcon}
              label="Snapshot"
              value={syncPreview ? "Hợp lệ" : "Chưa có"}
              hint={
                syncPreview
                  ? `Tạo ${formatRelativeTime(syncPreview.createdAt)}`
                  : "Chạy dry-run để tạo preview"
              }
            />
          </div>
          <div className="relative max-w-md">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm theo file hoặc Tag…"
              aria-label="Tìm thay đổi đồng bộ"
            />
          </div>
          <Tabs
            value={kind}
            onValueChange={(value) => setKind(value as typeof kind)}
          >
            <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
              {tabs.map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={kind} className="flex flex-col gap-3">
              <div className="max-h-[min(28rem,50vh)] overflow-auto rounded-lg border">
                <Table
                  className="table-fixed"
                  containerClassName="overflow-visible"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10 whitespace-normal text-center">
                        No
                      </TableHead>
                      <TableHead className="w-28">Loại</TableHead>
                      <TableHead className="w-[32%]">Tag</TableHead>
                      <TableHead className="whitespace-normal">
                        Nội dung
                      </TableHead>
                      <TableHead className="w-20">Chi tiết</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageGroups.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-sm text-muted-foreground"
                        >
                          Không có thay đổi phù hợp.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pageGroups.flatMap((group) => {
                        const isExpanded = expanded.has(group.file)
                        const header = (
                          <TableRow
                            key={`file-${group.file}`}
                            className="bg-muted-gradient hover:brightness-105"
                          >
                            <TableCell colSpan={5} className="p-0">
                              <button
                                type="button"
                                className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-[filter] hover:brightness-105"
                                aria-expanded={isExpanded}
                                onClick={() => toggleFile(group.file)}
                              >
                                <ChevronDownIcon
                                  className={cn(
                                    "size-4 shrink-0 text-muted-foreground transition-transform",
                                    !isExpanded && "-rotate-90",
                                  )}
                                />
                                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                  {group.file}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="shrink-0 tabular-nums"
                                >
                                  {formatNumber(group.items.length)} tag
                                </Badge>
                              </button>
                            </TableCell>
                          </TableRow>
                        )
                        if (!isExpanded) return [header]
                        return [
                          header,
                          ...group.items.map((change) => {
                            const content = syncChangeContent(change)
                            return (
                              <TableRow key={change.id}>
                                <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                                  {changeRowNumbers.get(change.id)}
                                </TableCell>
                                <TableCell className="text-center">
                                  <Badge
                                    variant={
                                      change.kind === "delete"
                                        ? "destructive"
                                        : "secondary"
                                    }
                                  >
                                    {changeLabels[change.kind]}
                                  </Badge>
                                </TableCell>
                                <TableCell className="max-w-0 whitespace-normal pl-9">
                                  <p className="truncate text-xs font-medium leading-tight">
                                    {change.tag}
                                  </p>
                                </TableCell>
                                <TableCell className="max-w-0 whitespace-normal">
                                  <p className="truncate text-xs leading-tight">
                                    {content.text}
                                  </p>
                                  {/* <p className="truncate text-[10px] text-muted-foreground">
                                    {content.note}
                                  </p> */}
                                </TableCell>
                                <TableCell className="text-center">
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => setDetail(change)}
                                  >
                                    Xem
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          }),
                        ]
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
              <TablePaginator
                page={safePage}
                totalPages={totalPages}
                totalItems={fileGroups.length}
                pageSize={pageSize}
                pageSizeOptions={SYNC_TABLE_PAGE_SIZE_OPTIONS}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                pageSizeLabel="file / trang"
                summary={`${formatNumber(filtered.length)} tag`}
                className="pt-2"
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Dialog open={Boolean(detail)} onOpenChange={() => setDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chi tiết thay đổi</DialogTitle>
            <DialogDescription className="break-all">
              {detail?.file} · {detail?.tag}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/30 p-3">
            {detail &&
              (() => {
                const content = syncChangeContent(detail)
                return (
                  <>
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">
                      {content.note.toUpperCase()}
                    </p>
                    <p className="text-sm">{content.text}</p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {detail.kind === "delete"
                        ? "Tag không còn trong cấu trúc EN — bản dịch VH hiện tại sẽ bị xóa khỏi mod."
                        : "Tag mới từ EN — copy sang mod VH, chưa dịch. Tag đã khớp trước đó không hiện ở đây vì bản dịch được giữ nguyên."}
                    </p>
                  </>
                )
              })()}
          </div>
          <Button
            variant="outline"
            onClick={() => {
              if (detail) void navigator.clipboard?.writeText(detail.file)
              toast.success("Đã sao chép đường dẫn.")
            }}
          >
            <ClipboardCopyIcon data-icon="inline-start" />
            Sao chép đường dẫn
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}

const DeployResult = function DeployResult({
  controller,
}: {
  controller: AppController
}) {
  const { state } = controller
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<"all" | DeployChange["kind"]>("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(
    SYNC_TABLE_PAGE_SIZE_OPTIONS[1],
  )

  const deployStep = state.steps.find((step) => step.id === "deploy")
  const hasResult = Boolean(
    state.deployApplied && deployStep && isStepComplete(deployStep.status),
  )
  const actionableCount =
    deployStep?.summary.changes ??
    state.deployChanges.filter(
      (change) => change.kind === "copy" || change.kind === "create",
    ).length

  const filtered = useMemo(
    () =>
      state.deployChanges.filter(
        (change) =>
          (kind === "all" || change.kind === kind) &&
          change.file.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    [state.deployChanges, kind, query],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const deployFilterKey = `${kind}:${query}:${pageSize}`
  const [trackedDeployFilterKey, setTrackedDeployFilterKey] =
    useState(deployFilterKey)
  const deployFiltersChanged = deployFilterKey !== trackedDeployFilterKey
  if (deployFiltersChanged) {
    setTrackedDeployFilterKey(deployFilterKey)
  }
  const safePage = deployFiltersChanged ? 1 : Math.min(page, totalPages)
  if (page !== safePage) {
    setPage(safePage)
  }

  const paginatedChanges = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, safePage, pageSize])

  if (state.selectedStep !== "deploy") return null

  const tabs = [
    ["all", "Tất cả"],
    ["copy", "Ghi đè"],
    ["create", "Tạo mới"],
    ["skip", "Bỏ qua"],
    ["unchanged", "Không đổi"],
  ] as const
  const resultTruncated =
    state.deployChanges.length >= 10_000 &&
    (deployStep?.summary.files ?? 0) > state.deployChanges.length

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Kết quả triển khai</CardTitle>
          <CardDescription>
            {hasResult
              ? `Đã xử lý ${formatNumber(deployStep?.summary.files ?? 0)} file · mod → Steam`
              : "Kết quả copy file Việt hóa vào thư mục game"}
          </CardDescription>
        </div>
        <CardAction>
          <Badge
            variant="outline"
            className={hasResult ? "text-success" : undefined}
          >
            <DatabaseBackupIcon data-icon="inline-start" />
            {hasResult
              ? state.config.deployBackup
                ? "Backup đã bật"
                : "Không tạo backup"
              : state.config.deployBackup
                ? "Sẽ backup file game"
                : "Backup đang tắt"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasResult ? (
          <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            Chưa có kết quả. Bấm “Triển khai vào game” để bắt đầu copy file.
          </div>
        ) : (
          <>
            {resultTruncated && (
              <Alert className="border-warning/30 bg-warning/10">
                <TriangleAlertIcon />
                <AlertTitle>Danh sách kết quả bị rút gọn</AlertTitle>
                <AlertDescription>
                  Hiển thị tối đa 10.000 mục — số liệu tổng hợp vẫn đầy đủ.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                icon={FileDiffIcon}
                label="Đã ghi thành công"
                value={formatNumber(actionableCount)}
              />
              <Metric
                icon={FileTextIcon}
                label="Đã bỏ qua"
                value={formatNumber(deployStep?.summary.skipped ?? 0)}
              />
              <Metric
                icon={TriangleAlertIcon}
                label="Lỗi"
                value={formatNumber(deployStep?.summary.warnings ?? 0)}
              />
              <Metric
                icon={ShieldCheckIcon}
                label="Tổng đã xử lý"
                value={formatNumber(
                  deployStep?.summary.files ?? state.deployChanges.length,
                )}
              />
            </div>
            <div className="relative max-w-md">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm theo đường dẫn file…"
                aria-label="Tìm file triển khai"
              />
            </div>
            <Tabs
              value={kind}
              onValueChange={(value) => setKind(value as typeof kind)}
            >
              <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
                {tabs.map(([value, label]) => (
                  <TabsTrigger key={value} value={value}>
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {kind === "unchanged" ? (
                <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                  File trùng khớp game không được liệt kê từng dòng để tránh làm
                  chậm UI.
                  {deployStep?.summary.files != null && (
                    <>
                      {" "}
                      Tổng đã xử lý {formatNumber(
                        deployStep.summary.files,
                      )}{" "}
                      file —{formatNumber(actionableCount)} file đã được ghi.
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="max-h-[min(28rem,50vh)] overflow-auto rounded-lg border">
                    <Table
                      className="table-fixed"
                      containerClassName="overflow-visible"
                    >
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-28">Loại</TableHead>
                          <TableHead className="whitespace-normal">
                            Đường dẫn (mod → game)
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {paginatedChanges.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={2}
                              className="text-center text-sm text-muted-foreground"
                            >
                              Không có file phù hợp trong kết quả triển khai.
                            </TableCell>
                          </TableRow>
                        ) : (
                          paginatedChanges.map((change) => (
                            <TableRow key={change.id}>
                              <TableCell className="text-center">
                                <Badge
                                  variant={
                                    change.kind === "copy"
                                      ? "default"
                                      : change.kind === "create"
                                        ? "secondary"
                                        : "outline"
                                  }
                                >
                                  {deployKindLabels[change.kind]}
                                </Badge>
                              </TableCell>
                              <TableCell className="max-w-0 truncate text-xs leading-tight">
                                {change.file}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  <TablePaginator
                    page={safePage}
                    totalPages={totalPages}
                    totalItems={filtered.length}
                    pageSize={pageSize}
                    pageSizeOptions={SYNC_TABLE_PAGE_SIZE_OPTIONS}
                    onPageChange={setPage}
                    onPageSizeChange={setPageSize}
                    pageSizeLabel="file / trang"
                    className="pt-2"
                  />
                </>
              )}
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function TranslateWarningAlert({ controller }: { controller: AppController }) {
  const { state } = controller
  const translateStep = state.steps.find((step) => step.id === "translate")
  if (!translateStep || translateStep.status !== "warning") return null
  const issueCount = state.qaIssues.length
  const warningCount = translateStep.summary.warnings ?? issueCount
  return (
    <Alert className="border-warning/30 bg-warning/10">
      <TriangleAlertIcon />
      <AlertTitle>Bước Dịch hoàn tất với cảnh báo</AlertTitle>
      <AlertDescription>
        {warningCount > 0
          ? `Có ${warningCount.toLocaleString("vi-VN")} cảnh báo QA${issueCount > 0
            ? ` — xem chi tiết trong bảng QA và Job Console bên dưới.`
            : " — xem Job Console để biết sự kiện trong lúc chạy."
          }`
          : "Có sự kiện cảnh báo trong Job Console — xem mô tả từng dòng bên dưới."}
      </AlertDescription>
    </Alert>
  )
}

function QaTable({ controller }: { controller: AppController }) {
  const { state } = controller
  const [severity, setSeverity] = useState<"all" | QaIssue["severity"]>("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(
    DEFAULT_TABLE_PAGE_SIZE_OPTIONS[1],
  )

  const issues = useMemo(
    () =>
      state.qaIssues.filter(
        (issue) => severity === "all" || issue.severity === severity,
      ),
    [state.qaIssues, severity],
  )
  const totalPages = Math.max(1, Math.ceil(issues.length / pageSize))
  const qaFilterKey = `${severity}:${pageSize}`
  const [trackedQaFilterKey, setTrackedQaFilterKey] = useState(qaFilterKey)
  const qaFiltersChanged = qaFilterKey !== trackedQaFilterKey
  if (qaFiltersChanged) {
    setTrackedQaFilterKey(qaFilterKey)
  }
  const safePage = qaFiltersChanged ? 1 : Math.min(page, totalPages)
  if (page !== safePage) {
    setPage(safePage)
  }

  const paginatedIssues = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return issues.slice(start, start + pageSize)
  }, [issues, safePage, pageSize])

  if (state.selectedStep !== "translate") return null
  const translateStep = state.steps.find((step) => step.id === "translate")
  const metrics = computeQaMetrics(issues, translateStep?.summary.skipped)

  const openIssueFile = (issue: QaIssue) => {
    const modPath = state.config.modPath.trim()
    if (!modPath || !issue.file.trim()) {
      toast.error("Không xác định được file cần mở.")
      return
    }
    const path = resolveModFilePath(modPath, issue.file)
    void ipc
      .openFile(path)
      .catch((error) => toast.error(formatInvokeError(error)))
  }
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>QA sau dịch</CardTitle>
          <CardDescription>
            Chỉ kiểm tra, không tự sửa nội dung bản dịch
          </CardDescription>
        </div>
        <CardAction>
          <Select
            value={severity}
            onValueChange={(value) =>
              setSeverity(value as "all" | QaIssue["severity"])
            }
          >
            <SelectTrigger size="sm">
              <FilterIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Mọi mức độ</SelectItem>
                <SelectItem value="error">Lỗi nghiêm trọng</SelectItem>
                <SelectItem value="warning">Cảnh báo</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Metric
            icon={LanguagesIcon}
            label="Còn tiếng Anh"
            value={String(metrics.untranslated)}
          />
          <Metric
            icon={BracesIcon}
            label="Token/plural lỗi"
            value={String(metrics.missingToken)}
          />
          <Metric
            icon={AlertCircleIcon}
            label="XML lỗi"
            value={String(metrics.xmlErrors)}
          />
          <Metric
            icon={BarChart3Icon}
            label="Quá ngắn/dài"
            value={String(metrics.lengthIssues)}
          />
          <Metric
            icon={PauseIcon}
            label="Giữ nguyên"
            value={String(metrics.skipped)}
          />
        </div>
        <div className="max-h-[min(28rem,50vh)] overflow-auto rounded-lg border">
          <Table className="table-fixed" containerClassName="overflow-visible">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 whitespace-normal text-center">
                  No
                </TableHead>
                <TableHead className="w-28">Mức độ</TableHead>
                <TableHead className="w-[22%] whitespace-normal">
                  Quy tắc / File
                </TableHead>
                <TableHead className="w-[28%]">Nguồn</TableHead>
                <TableHead className="w-[28%]">Bản dịch</TableHead>
                <TableHead className="w-24">Tác vụ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedIssues.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-sm text-muted-foreground"
                  >
                    Không có vấn đề QA phù hợp.
                  </TableCell>
                </TableRow>
              ) : (
                paginatedIssues.map((issue, index) => {
                  const rowNo = (safePage - 1) * pageSize + index + 1
                  return (
                    <TableRow key={issue.id}>
                      <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                        {rowNo}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant={
                            issue.severity === "error"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {issue.severity === "error" ? "Lỗi" : "Cảnh báo"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-0 whitespace-normal">
                        <p className="truncate font-medium leading-tight">
                          {qaRuleLabel(issue.rule)}
                        </p>
                        <p className="truncate text-xs leading-tight text-muted-foreground">
                          {issue.file}
                        </p>
                        <p className="truncate text-xs leading-tight text-muted-foreground">
                          {issue.tag}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-0 truncate text-xs leading-tight whitespace-normal">
                        {issue.source
                          ? formatLocDisplayText(issue.source)
                          : "—"}
                      </TableCell>
                      <TableCell className="max-w-0 truncate text-xs leading-tight whitespace-normal">
                        {issue.target
                          ? formatLocDisplayText(issue.target)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Sao chép Tag"
                            onClick={() => {
                              void navigator.clipboard?.writeText(issue.tag)
                              toast.success("Đã sao chép Tag.")
                            }}
                          >
                            <ClipboardCopyIcon />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Mở file"
                            disabled={!issue.file.trim()}
                            onClick={() => openIssueFile(issue)}
                          >
                            <FolderOpenIcon />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
        <TablePaginator
          page={safePage}
          totalPages={totalPages}
          totalItems={issues.length}
          pageSize={pageSize}
          pageSizeOptions={DEFAULT_TABLE_PAGE_SIZE_OPTIONS}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          className="pt-2"
        />
      </CardContent>
    </Card>
  )
}

function PipelineActionRail({
  controller,
  starting,
  onRun,
  onStop,
  onApply,
  shortcutsDisabled = false,
  peerJobActive = false,
}: {
  controller: AppController
  starting: boolean
  onRun: () => void
  onStop: () => void
  onApply: () => void
  shortcutsDisabled?: boolean
  peerJobActive?: boolean
}) {
  const { state } = controller
  const liveJob = useJobProgress()
  const step = state.steps.find((item) => item.id === state.selectedStep)!
  const running = state.activeJob?.status === "running"
  const busy = running || starting
  const locked = step.status === "locked"
  const translateNotNeeded =
    state.selectedStep === "translate" &&
    translateSkippedAfterDeleteOnlySync(state)
  const deploySelected = state.selectedStep === "deploy"
  const previewReady =
    state.selectedStep === "sync" &&
    syncApplyPending(state) &&
    isStepComplete(step.status)
  const action = starting
    ? {
      label: "Đang khởi động…",
      icon: LoaderCircleIcon,
      handler: () => undefined,
    }
    : running
      ? { label: "Dừng tác vụ", icon: CircleStopIcon, handler: onStop }
      : step.status === "paused"
        ? { label: "Tiếp tục", icon: PlayIcon, handler: onRun }
        : deploySelected
          ? {
            label: "Triển khai vào game",
            icon: ShieldCheckIcon,
            handler: onRun,
          }
          : previewReady
            ? {
              label: "Áp dụng đồng bộ",
              icon: ShieldCheckIcon,
              handler: onApply,
            }
            : step.status === "success" || step.status === "warning"
              ? {
                label: translateNotNeeded ? "Không cần dịch" : "Chạy lại",
                icon: translateNotNeeded ? CheckCircle2Icon : RotateCcwIcon,
                handler: onRun,
              }
              : { label: "Chạy bước này", icon: PlayIcon, handler: onRun }
  const Icon = action.icon
  const latestReport = state.reports.find(
    (report) => report.step === state.selectedStep,
  )
  const workingDirectory = stepWorkingDirectory(
    state.config,
    state.selectedStep,
  )

  const openLatestReport = () => {
    void (async () => {
      try {
        if (latestReport) {
          await ipc.openReport(latestReport.id)
          return
        }
        await ipc.openReportsFolder()
        toast.message("Chưa có báo cáo cho bước này — đã mở thư mục báo cáo.")
      } catch (error) {
        toast.error(formatInvokeError(error))
      }
    })()
  }

  const openWorkingDirectory = () => {
    if (!workingDirectory) {
      toast.error("Chưa cấu hình đường dẫn cho bước này.")
      return
    }
    void ipc
      .openFile(workingDirectory)
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  useEffect(() => {
    const handler = previewReady ? onApply : running ? onStop : onRun
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.ctrlKey || event.repeat) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return
      }
      if (locked || translateNotNeeded || starting) return
      if (shortcutsDisabled) return
      event.preventDefault()
      handler()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    locked,
    onApply,
    onRun,
    onStop,
    previewReady,
    running,
    starting,
    shortcutsDisabled,
    translateNotNeeded,
  ])

  const isRerun =
    !running &&
    !deploySelected &&
    !previewReady &&
    step.status !== "paused" &&
    (step.status === "success" || step.status === "warning")
  const actionVariant = pipelineFooterActionVariant({
    running,
    deploySelected,
    previewReady,
    stepStatus: step.status,
    isRerun,
  })

  return (
    <footer
      className={cn(
        "shrink-0 border-t bg-background",
        shortcutsDisabled && "pointer-events-none",
      )}
    >
      <div
        className={cn(
          pageShellClass,
          "flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between",
        )}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${locked
                ? "bg-muted-foreground/50"
                : running
                  ? "bg-info"
                  : "bg-success"
                }`}
            />
            <p className="truncate text-sm font-medium">{step.title}</p>
            {running && liveJob && (
              <Badge variant="outline" className="hidden sm:inline-flex">
                {Math.round(liveJob.progress)}%
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
            {locked
              ? (step.lockedReason ?? "Hoàn tất bước trước để mở khóa.")
              : translateNotNeeded
                ? TRANSLATE_SKIP_AFTER_DELETE_SYNC
                : busy
                  ? "Tác vụ đang chạy. Dừng sẽ lưu cache trước khi tạm ngưng."
                  : "Phím tắt: Ctrl + Enter"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            variant={actionBtn.report}
            size="sm"
            onClick={openLatestReport}
          >
            <FileTextIcon data-icon="inline-start" />
            Mở báo cáo
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!workingDirectory}
            onClick={openWorkingDirectory}
          >
            <FolderOpenIcon data-icon="inline-start" />
            Mở thư mục
          </Button>
          <Button
            size="sm"
            variant={actionVariant}
            disabled={locked || translateNotNeeded || starting || peerJobActive}
            onClick={action.handler}
          >
            <Icon
              data-icon="inline-start"
              className={starting ? "animate-spin" : undefined}
            />
            {action.label}
          </Button>
        </div>
      </div>
    </footer>
  )
}

function StepPreviewPanel({
  controller,
  starting,
  onManageKeys,
}: {
  controller: AppController
  starting: boolean
  onManageKeys: () => void
}) {
  const running = controller.state.activeJob?.status === "running"
  if (starting) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Đang khởi động tác vụ</CardTitle>
          <CardDescription>
            Giao diện đã nhường quyền xử lý; engine sẽ báo tiến trình ngay khi
            bắt đầu quét file.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          Đang chuẩn bị copy vào thư mục game…
        </CardContent>
      </Card>
    )
  }
  // Progress đã có ở CurrentJobHero (panel trên) — không lặp lại ở đây.
  if (running) return null

  switch (controller.state.selectedStep) {
    case "translate":
      return (
        <>
          <TranslationMonitor
            controller={controller}
            onManageKeys={onManageKeys}
          />
          <TranslateWarningAlert controller={controller} />
          <QaTable controller={controller} />
        </>
      )
    case "inspect":
      return <InspectPreview controller={controller} />
    case "sync":
      return <SyncPreview controller={controller} />
    case "deploy":
      return <DeployResult controller={controller} />
    default:
      return null
  }
}

export function PipelinePage({
  controller,
  onNavigate,
  active,
  onReadyChange,
  peerJobActive = false,
}: {
  controller: AppController
  onNavigate: (view: AppView) => void
  active: boolean
  onReadyChange?: (ready: boolean) => void
  peerJobActive?: boolean
}) {
  const { state, actions } = controller
  const renderPhase = usePipelineRenderPhase(active)

  useEffect(() => {
    onReadyChange?.(renderPhase === "full")
  }, [onReadyChange, renderPhase])
  const [apiOpen, setApiOpen] = useState(false)
  const [runConfirm, setRunConfirm] = useState(false)
  const [stopConfirm, setStopConfirm] = useState(false)
  const [applyConfirm, setApplyConfirm] = useState(false)
  const [starting, setStarting] = useState(false)
  const runLaunchRef = useRef(false)
  const blockRunUi =
    starting || state.activeJob?.status === "running" || peerJobActive
  const selectedStep = state.steps.find(
    (step) => step.id === state.selectedStep,
  )!
  const selectedIndex = STEP_ORDER.indexOf(state.selectedStep)
  const invalidatedSteps = state.steps
    .slice(selectedIndex + 1)
    .map((step) => step.shortTitle)

  const launchPipelineJob = (
    step: StepId,
    mode: "run" | "dry-run" | "resume",
  ) => {
    if (runLaunchRef.current) return
    runLaunchRef.current = true
    setRunConfirm(false)
    setApplyConfirm(false)
    setStarting(true)

    // Trả quyền render trước khi gọi IPC để dialog/preview nặng được gỡ khỏi DOM.
    window.setTimeout(() => {
      void actions
        .startJob(step, mode)
        .then((result) => {
          if (result) return
          toast.error(
            "Không khởi động được tác vụ. Có thể đang có job khác chạy — thử lại sau vài giây.",
          )
        })
        .catch((error) => {
          const message = formatInvokeError(error)
          if (
            isDuplicateJobStartError(error) ||
            message.includes("một thời điểm")
          ) {
            toast.error("Đang có tác vụ khác — đợi vài giây rồi thử lại.")
            return
          }
          toast.error(message)
        })
        .finally(() => {
          setStarting(false)
          runLaunchRef.current = false
        })
    }, 16)
  }

  const runSelected = () => {
    const mode =
      selectedStep.status === "paused"
        ? "resume"
        : selectedStep.id === "sync"
          ? "dry-run"
          : "run"
    launchPipelineJob(selectedStep.id, mode)
  }

  const needsRerunConfirm =
    selectedStep.id !== "deploy" &&
    (selectedStep.status === "success" || selectedStep.status === "warning")

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={pageContainerClass}>
          <PageHeader
            eyebrow="Trung tâm vận hành"
            title="Pipeline bản địa hóa"
            description="Năm bước tuần tự có kiểm soát, backup và khả năng tiếp tục an toàn. Chọn một bước để xem kết quả gần nhất."
            action={
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-success">
                  <ShieldCheckIcon data-icon="inline-start" />
                  Dữ liệu được bảo vệ
                </Badge>
              </div>
            }
          />
          <PipelineStepper controller={controller} />
          <CurrentJobHero controller={controller} />
          <PipelineDeferredSections
            phase={renderPhase}
            controller={controller}
            starting={starting}
            onNavigate={onNavigate}
            onManageKeys={() => setApiOpen(true)}
          />
        </div>
      </div>

      <PipelineActionRail
        controller={controller}
        starting={starting}
        peerJobActive={peerJobActive}
        shortcutsDisabled={
          runConfirm || stopConfirm || applyConfirm || blockRunUi
        }
        onRun={() => (needsRerunConfirm ? setRunConfirm(true) : runSelected())}
        onStop={() => setStopConfirm(true)}
        onApply={() => setApplyConfirm(true)}
      />

      <ApiManagerDialog
        open={apiOpen}
        onOpenChange={setApiOpen}
        controller={controller}
      />

      <AlertDialog open={runConfirm} onOpenChange={setRunConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chạy lại {selectedStep.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              Kết quả cũ của bước này sẽ được thay thế.
              {invalidatedSteps.length > 0 &&
                ` Các bước bị vô hiệu hóa: ${invalidatedSteps.join(", ")}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Giữ kết quả hiện tại</AlertDialogCancel>
            <Button
              type="button"
              variant={actionBtn.retry}
              onPointerDown={preventDialogClickThrough}
              onClick={(event) => {
                preventDialogClickThrough(event)
                runSelected()
              }}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Chạy lại
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={stopConfirm} onOpenChange={setStopConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dừng tác vụ đang chạy?</AlertDialogTitle>
            <AlertDialogDescription>
              Ứng dụng sẽ yêu cầu engine lưu cache rồi chuyển sang trạng thái
              tạm dừng. Không tắt ứng dụng cho đến khi việc lưu hoàn tất.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Tiếp tục chạy</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void actions.cancelJob()
                setStopConfirm(false)
              }}
            >
              <CircleStopIcon data-icon="inline-start" />
              Dừng an toàn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={applyConfirm} onOpenChange={setApplyConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Áp dụng{" "}
              {formatNumber(
                state.steps.find((step) => step.id === "sync")?.summary
                  .changes ?? state.syncChanges.length,
              )}{" "}
              thay đổi?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Ứng dụng sẽ kiểm tra lại fingerprint, tạo backup rồi ghi atomic.
              Các mục bị xóa đã được đánh dấu trong preview.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Alert className="border-warning/30 bg-warning/10">
            <Trash2Icon />
            <AlertTitle>Có thay đổi phá hủy</AlertTitle>
            <AlertDescription>
              Các mục xóa đã được đánh dấu trong preview. Bạn có thể khôi phục
              từ Backup Center.
            </AlertDescription>
          </Alert>
          <AlertDialogFooter>
            <AlertDialogCancel>Quay lại xem</AlertDialogCancel>
            <Button
              type="button"
              variant={actionBtn.deploy}
              onPointerDown={preventDialogClickThrough}
              onClick={(event) => {
                preventDialogClickThrough(event)
                launchPipelineJob("sync", "run")
              }}
            >
              <ShieldCheckIcon data-icon="inline-start" />
              Tạo backup và áp dụng
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
