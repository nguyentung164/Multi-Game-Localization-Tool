import { useCallback, useMemo, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  Loader2Icon,
  ReplaceAllIcon,
  ReplaceIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader, pageContainerClass } from "@/components/product-ui"
import { LoadingButtonLabel, PresenceAlert } from "@/components/presence-fade"
import { AsyncLoadingOverlay } from "@/components/async-loading-overlay"
import {
  shouldVirtualizeTableRows,
  useVirtualTableScrollRef,
  VirtualizedTableBody,
} from "@/components/virtualized-table-body"
import { useAsyncTask } from "@/hooks/use-async-task"
import { HighlightedSearchText } from "@/components/highlighted-search-text"
import {
  DEFAULT_TABLE_PAGE_SIZE_OPTIONS,
  TablePaginator,
} from "@/components/table-paginator"
import { SearchMatchOptions } from "@/components/search-match-options"
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { actionBtn } from "@/lib/action-button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { AppView, TagSearchOptions } from "@/lib/app-types"
import type { LegendTranslationController } from "@/hooks/use-legend-translation"
import {
  emptyLegendSearchResult,
  filterLegendSearchResult,
  searchLegendEntries,
} from "@/lib/legend-search"
import type {
  LegendLineEdit,
  LegendSearchMatch,
  LegendSearchResult,
  LegendSearchScope,
} from "@/lib/legend-types"
import {
  createTextMatcher,
  findTextMatchRanges,
  replaceTextMatches,
} from "@/lib/tag-search"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"

const scopeOptions: { value: LegendSearchScope; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "chinese", label: "Tiếng Trung" },
  { value: "vietnamese", label: "Tiếng Việt" },
  { value: "line", label: "Số dòng" },
]

const PAGE_SIZE_OPTIONS = DEFAULT_TABLE_PAGE_SIZE_OPTIONS
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]

type EditingState = {
  id: string
  value: string
  saving: boolean
}

const DEMO_ENTRIES = [
  {
    lineNumber: 1,
    source: "大戟士统领(...)",
    currentTarget: "Đại kích sĩ thống lĩnh(...)",
    kind: "entry" as const,
  },
  {
    lineNumber: 2,
    source: "白马义从统领(...)",
    currentTarget: "Bạch Mã Nghĩa Tòng thống lĩnh(...)",
    kind: "entry" as const,
  },
  {
    lineNumber: 3,
    source: "黄巾渠帅",
    currentTarget: "Khăn vàng Cừ soái",
    kind: "entry" as const,
  },
]

export function LegendSearchPage({
  legend,
  locked = false,
  onNavigate,
}: {
  legend: LegendTranslationController
  locked?: boolean
  onNavigate: (view: AppView) => void
}) {
  const [query, setQuery] = useState("")
  const [replaceValue, setReplaceValue] = useState("")
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [scope, setScope] = useState<LegendSearchScope>("all")
  const [result, setResult] = useState<LegendSearchResult>(() =>
    emptyLegendSearchResult("all"),
  )
  const {
    run: runAsyncTask,
    loading,
    title: loadingTitle,
    description: loadingDescription,
    phase: loadingPhase,
    phaseLabel: loadingPhaseLabel,
    progress: loadingProgress,
  } = useAsyncTask()
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [hasSearched, setHasSearched] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(50)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null)

  const sourcePath = legend.sourcePath.trim()
  const pathsReady = Boolean(sourcePath)
  const canSave = pathsReady && !locked
  const matchOptions = useMemo<TagSearchOptions>(
    () => ({ caseSensitive, wholeWord }),
    [caseSensitive, wholeWord],
  )

  const performSearch = useCallback(
    async (
      searchQuery: string,
      searchScope: LegendSearchScope,
      options: TagSearchOptions,
    ) => {
      const trimmed = searchQuery.trim()
      try {
        await runAsyncTask({
          title: trimmed ? "Đang tìm kiếm…" : "Đang tải dữ liệu…",
          description: "Đang quét file nguồn XUnity.",
          task: async () => {
            if (isTauriRuntime()) {
              if (!sourcePath) {
                toast.error(
                  "Cần chọn file nguồn XUnity trong Cài đặt trước khi tra cứu.",
                )
                return emptyLegendSearchResult(searchScope)
              }
              const payload = await ipc.searchLegendFile(
                trimmed,
                searchScope,
                undefined,
                options.caseSensitive,
                options.wholeWord,
                sourcePath,
              )
              return trimmed
                ? filterLegendSearchResult(payload, options)
                : payload
            }
            return searchLegendEntries(
              legend.inspection?.sample ?? DEMO_ENTRIES,
              trimmed,
              searchScope,
              sourcePath || "demo-legend.txt",
              options,
            )
          },
          renderResult: (nextResult) => {
            setResult(nextResult)
            setHasSearched(true)
            setActiveMatchId(null)
          },
        })
      } catch (error) {
        toast.error(formatInvokeError(error))
      }
    },
    [legend.inspection?.sample, runAsyncTask, sourcePath],
  )

  const runSearch = useCallback(async () => {
    const trimmed = query.trim()
    setSubmittedQuery(trimmed)
    setPage(1)
    await performSearch(trimmed, scope, matchOptions)
  }, [matchOptions, performSearch, query, scope])

  const [pageResetKey, setPageResetKey] = useState(result.matches)
  const [trackedPageSize, setTrackedPageSize] = useState(pageSize)
  const filtersChanged =
    result.matches !== pageResetKey || pageSize !== trackedPageSize
  if (filtersChanged) {
    setPageResetKey(result.matches)
    setTrackedPageSize(pageSize)
  }

  const totalPages = Math.max(1, Math.ceil(result.matches.length / pageSize))
  const safePage = filtersChanged ? 1 : Math.min(page, totalPages)
  if (page !== safePage) {
    setPage(safePage)
  }

  const paginatedMatches = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return result.matches.slice(start, start + pageSize)
  }, [result.matches, pageSize, safePage])
  const tableScrollRef = useVirtualTableScrollRef()
  const virtualizeTableRows = shouldVirtualizeTableRows(paginatedMatches.length)

  const vietnameseMatcher = useMemo(
    () => createTextMatcher(submittedQuery, matchOptions),
    [matchOptions, submittedQuery],
  )

  const replaceableMatches = useMemo(() => {
    if (!replaceOpen || !submittedQuery) return []
    return result.matches.filter((match) =>
      vietnameseMatcher(match.currentTarget),
    )
  }, [replaceOpen, result.matches, submittedQuery, vietnameseMatcher])

  const replaceableCount = useMemo(() => {
    if (!replaceOpen || !submittedQuery) return 0
    return replaceableMatches.reduce(
      (sum, match) =>
        sum +
        findTextMatchRanges(match.currentTarget, submittedQuery, matchOptions)
          .length,
      0,
    )
  }, [matchOptions, replaceOpen, replaceableMatches, submittedQuery])

  const summary = useMemo(() => {
    if (!hasSearched) {
      return "Nhập từ khóa rồi bấm Tìm, hoặc để trống để tải các mục Trung=Việt."
    }
    const parts = [
      result.query
        ? `${result.totalMatches.toLocaleString("vi-VN")} kết quả`
        : `${result.totalMatches.toLocaleString("vi-VN")} mục`,
      `${result.scannedLines.toLocaleString("vi-VN")} dòng đã quét`,
    ]
    if (!result.query) parts.push("toàn bộ mục có thể dịch")
    if (result.query && caseSensitive) parts.push("phân biệt hoa/thường")
    if (result.query && wholeWord) parts.push("khớp nguyên từ")
    if (result.truncated) {
      parts.push(
        result.query ? "đã giới hạn 500 kết quả" : "đã giới hạn số bản ghi",
      )
    }
    if (replaceOpen && replaceableCount > 0) {
      parts.push(
        `${replaceableCount.toLocaleString("vi-VN")} chỗ khớp trong tiếng Việt`,
      )
    }
    return parts.join(" · ")
  }, [
    caseSensitive,
    hasSearched,
    replaceOpen,
    replaceableCount,
    result,
    wholeWord,
  ])

  const copySource = async (source: string) => {
    try {
      await navigator.clipboard.writeText(source)
      toast.success("Đã sao chép tiếng Trung.")
    } catch {
      toast.error("Không sao chép được.")
    }
  }

  const startEditing = (match: LegendSearchMatch) => {
    if (editing?.saving) return
    setActiveMatchId(match.id)
    setEditing({ id: match.id, value: match.currentTarget, saving: false })
  }

  const cancelEditing = () => {
    if (editing?.saving) return
    setEditing(null)
  }

  const persistVietnamese = useCallback(
    async (match: LegendSearchMatch, currentTarget: string) => {
      if (isTauriRuntime()) {
        if (!canSave) {
          throw new Error("Cần chọn file nguồn và đợi tác vụ khác xong trước khi lưu.")
        }
        await ipc.updateLegendLines(
          [{ lineNumber: match.lineNumber, currentTarget }],
          sourcePath,
        )
      }
      setResult((current) => ({
        ...current,
        matches: current.matches.map((item) =>
          item.id === match.id ? { ...item, currentTarget } : item,
        ),
      }))
    },
    [canSave, sourcePath],
  )

  const saveEditing = async (match: LegendSearchMatch) => {
    if (!editing || editing.id !== match.id || editing.saving) return
    setEditing((current) => (current ? { ...current, saving: true } : current))
    try {
      await persistVietnamese(match, editing.value)
      setEditing(null)
      toast.success("Đã lưu bản dịch.")
    } catch (error) {
      toast.error(formatInvokeError(error))
      setEditing((current) =>
        current ? { ...current, saving: false } : current,
      )
    }
  }

  const applyOptionsChange = (next: TagSearchOptions) => {
    if (hasSearched) {
      void performSearch(submittedQuery, scope, next)
    }
  }

  const replaceOne = async () => {
    if (!submittedQuery || loading) return
    if (isTauriRuntime() && !canSave) {
      toast.error("Cần chọn file nguồn trước khi thay thế.")
      return
    }
    const startIndex = Math.max(
      0,
      replaceableMatches.findIndex((match) => match.id === activeMatchId),
    )
    const ordered = [
      ...replaceableMatches.slice(startIndex),
      ...replaceableMatches.slice(0, startIndex),
    ]
    const target = ordered.find((match) =>
      vietnameseMatcher(match.currentTarget),
    )
    if (!target) {
      toast.message("Không còn chỗ khớp trong tiếng Việt.")
      return
    }
    const { text, count } = replaceTextMatches(
      target.currentTarget,
      submittedQuery,
      replaceValue,
      matchOptions,
      1,
    )
    if (count === 0) {
      toast.message("Không còn chỗ khớp trong tiếng Việt.")
      return
    }
    setActiveMatchId(target.id)
    try {
      await runAsyncTask({
        title: "Đang thay thế…",
        phase: "saving",
        task: () => persistVietnamese(target, text),
      })
      toast.success("Đã thay thế 1 chỗ khớp.")
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  const replaceAll = async () => {
    if (!submittedQuery || loading) return
    if (isTauriRuntime() && !canSave) {
      toast.error("Cần chọn file nguồn trước khi thay thế.")
      return
    }
    if (replaceableMatches.length === 0) {
      toast.message("Không có chỗ khớp trong tiếng Việt.")
      return
    }

    const edits: LegendLineEdit[] = []
    let replacedOccurrences = 0
    for (const match of replaceableMatches) {
      const { text, count } = replaceTextMatches(
        match.currentTarget,
        submittedQuery,
        replaceValue,
        matchOptions,
      )
      if (count === 0) continue
      edits.push({ lineNumber: match.lineNumber, currentTarget: text })
      replacedOccurrences += count
    }
    if (edits.length === 0) {
      toast.message("Không có chỗ khớp trong tiếng Việt.")
      return
    }

    try {
      await runAsyncTask({
        title: "Đang thay thế hàng loạt…",
        description: "Engine đang cập nhật bản dịch tiếng Việt.",
        phase: "saving",
        task: async () => {
          if (isTauriRuntime()) {
            await ipc.updateLegendLines(edits, sourcePath)
          }
          return { replacedOccurrences, edits }
        },
        renderResult: ({ edits: appliedEdits }) => {
          const byLine = new Map(
            appliedEdits.map((edit) => [edit.lineNumber, edit.currentTarget]),
          )
          setResult((current) => ({
            ...current,
            matches: current.matches.map((item) => {
              const next = byLine.get(item.lineNumber)
              return next === undefined ? item : { ...item, currentTarget: next }
            }),
          }))
        },
      })
      toast.success(
        `Đã thay thế ${replacedOccurrences.toLocaleString("vi-VN")} chỗ trong ${edits.length.toLocaleString("vi-VN")} dòng.`,
      )
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div
        className={cn(
          pageContainerClass,
          "relative flex min-h-0 flex-1 flex-col",
          loading && "pointer-events-none",
        )}
      >
        <AsyncLoadingOverlay
          visible={loading}
          title={loadingTitle}
          description={loadingDescription}
          phase={loadingPhase ?? undefined}
          phaseLabel={loadingPhaseLabel ?? undefined}
          progress={loadingProgress}
        />
        <PageHeader
          eyebrow="Legend of Heroes Three Kingdoms"
          title="Tra cứu"
          description="Tìm câu Trung=Việt trong file nguồn XUnity, sửa tiếng Việt và thay thế hàng loạt."
        />

        <PresenceAlert show={!isTauriRuntime()}>
          <AlertTitle>Chế độ demo</AlertTitle>
          <AlertDescription>
            Tra cứu/sửa trên dữ liệu mẫu. Trong app desktop, thay đổi được ghi
            vào file nguồn XUnity.
          </AlertDescription>
        </PresenceAlert>

        <PresenceAlert show={isTauriRuntime() && !pathsReady} variant="destructive">
          <AlertTitle>Thiếu file nguồn</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>Chọn file bản dịch XUnity trong Cài đặt trước khi tra cứu.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onNavigate("legend-settings")}
            >
              Mở Cài đặt
            </Button>
          </AlertDescription>
        </PresenceAlert>

        <PresenceAlert show={locked}>
          <AlertTitle>Đang có tác vụ chạy</AlertTitle>
          <AlertDescription>
            Có thể tra cứu, nhưng chưa lưu hay thay thế được cho đến khi job
            xong.
          </AlertDescription>
        </PresenceAlert>

        <Card className="shrink-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SearchIcon className="size-4" />
              Tìm và thay thế
            </CardTitle>
            <CardDescription>
              Tìm theo tiếng Trung, tiếng Việt hoặc số dòng. Thay thế chỉ áp
              dụng trên cột Tiếng Việt.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start">
              <div className="flex min-w-0 flex-1 gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-0.5 size-8 shrink-0"
                  aria-label={replaceOpen ? "Ẩn thay thế" : "Hiện thay thế"}
                  aria-expanded={replaceOpen}
                  onClick={() => setReplaceOpen((open) => !open)}
                >
                  {replaceOpen ? (
                    <ChevronDownIcon className="size-4" />
                  ) : (
                    <ChevronRightIcon className="size-4" />
                  )}
                </Button>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void runSearch()
                    }}
                    placeholder="Tìm tiếng Trung, tiếng Việt hoặc số dòng… (để trống = tải mục)"
                  />
                  {replaceOpen ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        value={replaceValue}
                        onChange={(event) => setReplaceValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && event.shiftKey) {
                            event.preventDefault()
                            void replaceAll()
                          } else if (event.key === "Enter") {
                            event.preventDefault()
                            void replaceOne()
                          }
                        }}
                        placeholder="Thay thế bằng…"
                        disabled={loading || locked}
                        className="min-w-0 flex-1"
                      />
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => void replaceOne()}
                          disabled={
                            loading ||
                            locked ||
                            !submittedQuery ||
                            replaceableCount === 0
                          }
                          title="Thay thế chỗ khớp tiếp theo trong tiếng Việt"
                        >
                          {loading ? (
                            <Loader2Icon className="size-4 animate-spin" />
                          ) : (
                            <ReplaceIcon className="size-4" />
                          )}
                          Replace
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void replaceAll()}
                          disabled={
                            loading ||
                            locked ||
                            !submittedQuery ||
                            replaceableCount === 0
                          }
                          title="Thay thế tất cả chỗ khớp trong tiếng Việt"
                        >
                          <ReplaceAllIcon className="size-4" />
                          Replace All
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <Select
                value={scope}
                onValueChange={(value) => {
                  const nextScope = value as LegendSearchScope
                  setScope(nextScope)
                  if (hasSearched) {
                    void performSearch(submittedQuery, nextScope, matchOptions)
                  }
                }}
              >
                <SelectTrigger className="w-full md:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={actionBtn.search}
                  onClick={() => void runSearch()}
                  disabled={loading || (isTauriRuntime() && !pathsReady)}
                >
                  <LoadingButtonLabel
                    loading={loading}
                    loadingContent={
                      <>
                        <Loader2Icon className="size-4 animate-spin" />
                        {query.trim() ? "Đang tìm…" : "Đang tải…"}
                      </>
                    }
                    idleContent="Tìm"
                  />
                </Button>
              </div>
            </div>
            <SearchMatchOptions
              caseSensitive={caseSensitive}
              wholeWord={wholeWord}
              onCaseSensitiveChange={(checked) => {
                setCaseSensitive(checked)
                applyOptionsChange({ caseSensitive: checked, wholeWord })
              }}
              onWholeWordChange={(checked) => {
                setWholeWord(checked)
                applyOptionsChange({ caseSensitive, wholeWord: checked })
              }}
            />
            <p className="text-muted-foreground text-sm">{summary}</p>
          </CardContent>
        </Card>

        {hasSearched ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0">
              <CardTitle className="text-base">Kết quả</CardTitle>
              <CardDescription>
                {result.query ? (
                  <>
                    Phạm vi:{" "}
                    {
                      scopeOptions.find((item) => item.value === result.scope)
                        ?.label
                    }
                    {" · "}
                  </>
                ) : (
                  <>Toàn bộ mục · </>
                )}
                Bấm ô Tiếng Việt để sửa trực tiếp.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {result.matches.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {result.query
                    ? `Không có kết quả cho "${result.query}".`
                    : "Không có mục Trung=Việt trong file."}
                </p>
              ) : (
                <>
                  <div
                    ref={tableScrollRef}
                    className="min-h-0 flex-1 overflow-auto rounded-lg border"
                  >
                    <Table
                      className="table-fixed"
                      containerClassName="overflow-visible"
                    >
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10 whitespace-normal text-center">
                            No
                          </TableHead>
                          <TableHead className="w-20 whitespace-normal text-center">
                            Dòng
                          </TableHead>
                          <TableHead className="whitespace-normal">
                            Tiếng Trung
                          </TableHead>
                          <TableHead className="whitespace-normal">
                            Tiếng Việt
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      {(() => {
                        const renderMatchRow = (
                          match: (typeof paginatedMatches)[number],
                          index: number,
                        ) => {
                          const rowNo = (safePage - 1) * pageSize + index + 1
                          const isEditing = editing?.id === match.id
                          const isActive = activeMatchId === match.id
                          return (
                            <TableRow
                              key={match.id}
                              data-state={isActive ? "selected" : undefined}
                              className={cn(isActive && "bg-muted/40")}
                              onClick={() => setActiveMatchId(match.id)}
                            >
                              <TableCell className="h-px whitespace-normal p-0 text-xs tabular-nums leading-tight text-muted-foreground">
                                <div className="flex h-full items-center justify-center px-1.5 py-2">
                                  {rowNo}
                                </div>
                              </TableCell>
                              <TableCell className="h-px whitespace-normal p-0 text-xs tabular-nums leading-tight">
                                <div className="flex h-full items-center justify-center px-1.5 py-2">
                                  <HighlightedSearchText
                                    text={String(match.lineNumber)}
                                    query={result.query}
                                    caseSensitive={caseSensitive}
                                    wholeWord={false}
                                  />
                                </div>
                              </TableCell>
                              <TableCell className="h-px whitespace-normal p-0 text-xs font-medium leading-tight">
                                <div className="flex h-full items-center gap-2 px-1.5 py-2">
                                  <span className="min-w-0 break-all">
                                    <HighlightedSearchText
                                      text={match.source}
                                      query={result.query}
                                      caseSensitive={caseSensitive}
                                      wholeWord={wholeWord}
                                    />
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-7 shrink-0"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      void copySource(match.source)
                                    }}
                                    title="Sao chép tiếng Trung"
                                  >
                                    <CopyIcon className="size-3.5" />
                                  </Button>
                                </div>
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "h-px whitespace-normal p-0 text-xs leading-tight",
                                  !isEditing && canSave && "cursor-pointer",
                                )}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setActiveMatchId(match.id)
                                  if (!isEditing && canSave) startEditing(match)
                                }}
                              >
                                {isEditing ? (
                                  <div
                                    className="flex h-full items-start gap-1 px-1.5 py-2"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <Textarea
                                      value={editing.value}
                                      onChange={(event) =>
                                        setEditing((current) =>
                                          current
                                            ? {
                                                ...current,
                                                value: event.target.value,
                                              }
                                            : current,
                                        )
                                      }
                                      className="min-h-16 flex-1 resize-y text-xs leading-tight"
                                      autoFocus
                                      disabled={editing.saving}
                                    />
                                    <div className="flex shrink-0 flex-col gap-1">
                                      <Button
                                        variant="outline"
                                        size="icon"
                                        className="size-8"
                                        title="Lưu"
                                        disabled={editing.saving}
                                        onClick={() => void saveEditing(match)}
                                      >
                                        {editing.saving ? (
                                          <Loader2Icon className="size-4 animate-spin" />
                                        ) : (
                                          <CheckIcon className="size-4" />
                                        )}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8"
                                        title="Hủy"
                                        disabled={editing.saving}
                                        onClick={cancelEditing}
                                      >
                                        <XIcon className="size-4" />
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    className={cn(
                                      "flex h-full items-center px-1.5 py-2 break-words whitespace-normal",
                                      canSave && "hover:bg-muted/50",
                                    )}
                                    title={
                                      canSave ? "Bấm để chỉnh sửa" : undefined
                                    }
                                  >
                                    <HighlightedSearchText
                                      text={match.currentTarget}
                                      query={result.query}
                                      caseSensitive={caseSensitive}
                                      wholeWord={wholeWord}
                                    />
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        }
                        return virtualizeTableRows ? (
                          <VirtualizedTableBody
                            rows={paginatedMatches}
                            scrollRef={tableScrollRef}
                            colSpan={4}
                            estimateSize={64}
                            renderRow={renderMatchRow}
                          />
                        ) : (
                          <TableBody>
                            {paginatedMatches.map(renderMatchRow)}
                          </TableBody>
                        )
                      })()}
                    </Table>
                  </div>
                  <TablePaginator
                    className="mt-4 shrink-0"
                    page={safePage}
                    totalPages={totalPages}
                    totalItems={result.matches.length}
                    pageSize={pageSize}
                    pageSizeOptions={PAGE_SIZE_OPTIONS}
                    onPageChange={setPage}
                    onPageSizeChange={(value) => setPageSize(value as PageSize)}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </div>
        ) : null}
      </div>
    </div>
  )
}
