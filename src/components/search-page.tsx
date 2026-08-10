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
import { HighlightedSearchText } from "@/components/highlighted-search-text"
import {
  DEFAULT_TABLE_PAGE_SIZE_OPTIONS,
  TablePaginator,
} from "@/components/table-paginator"
import { SearchMatchOptions } from "@/components/search-match-options"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import type { AppController } from "@/hooks/use-app-controller"
import type {
  TagListResult,
  TagSearchMatch,
  TagSearchOptions,
  TagSearchResult,
  TagSearchScope,
} from "@/lib/app-types"
import {
  createTextMatcher,
  filterTagSearchResult,
  findTextMatchRanges,
  listDemoTags,
  replaceTextMatches,
  searchDemoTags,
} from "@/lib/tag-search"
import { formatLocDisplayText } from "@/lib/loc-text"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"

const scopeOptions: { value: TagSearchScope; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "tag", label: "Tag / LOC_*" },
  { value: "english", label: "Tiếng Anh" },
  { value: "vietnamese", label: "Tiếng Việt" },
  { value: "file", label: "Tên file" },
]

const PAGE_SIZE_OPTIONS = DEFAULT_TABLE_PAGE_SIZE_OPTIONS
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]

type EditingState = {
  id: string
  value: string
  saving: boolean
}

const emptyResult = (scope: TagSearchScope): TagSearchResult => ({
  query: "",
  scope,
  scannedFiles: 0,
  totalMatches: 0,
  truncated: false,
  matches: [],
})

const listResultToSearchResult = (
  list: TagListResult,
  scope: TagSearchScope,
): TagSearchResult => ({
  query: "",
  scope,
  scannedFiles: list.scannedFiles,
  totalMatches: list.totalMatches,
  truncated: list.truncated,
  matches: list.matches,
})

export function SearchPage({ controller }: { controller: AppController }) {
  const { state } = controller
  const [query, setQuery] = useState("")
  const [replaceValue, setReplaceValue] = useState("")
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [scope, setScope] = useState<TagSearchScope>("all")
  const [result, setResult] = useState<TagSearchResult>(() =>
    emptyResult("all"),
  )
  const [loading, setLoading] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [hasSearched, setHasSearched] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(50)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null)

  const pathsReady = Boolean(
    state.config.exportPath.trim() || state.config.modPath.trim(),
  )
  const canSave = Boolean(state.config.modPath.trim())
  const matchOptions = useMemo<TagSearchOptions>(
    () => ({ caseSensitive, wholeWord }),
    [caseSensitive, wholeWord],
  )

  const performSearch = useCallback(
    async (
      searchQuery: string,
      searchScope: TagSearchScope,
      options: TagSearchOptions,
    ) => {
      const trimmed = searchQuery.trim()
      setLoading(true)
      try {
        if (isTauriRuntime()) {
          if (!pathsReady) {
            toast.error(
              "Cần cấu hình exportPath hoặc modPath trước khi tra cứu.",
            )
            setResult(emptyResult(searchScope))
            setHasSearched(true)
            return
          }
          if (!trimmed) {
            const payload = await ipc.listTags(0)
            setResult(listResultToSearchResult(payload, searchScope))
          } else {
            const payload = await ipc.searchTags(
              trimmed,
              searchScope,
              undefined,
              options.caseSensitive,
              options.wholeWord,
            )
            setResult(filterTagSearchResult(payload, options))
          }
        } else if (!trimmed) {
          setResult(
            listResultToSearchResult(listDemoTags(state.qaIssues), searchScope),
          )
        } else {
          setResult(
            searchDemoTags(state.qaIssues, trimmed, searchScope, 500, options),
          )
        }
        setHasSearched(true)
        setActiveMatchId(null)
      } catch (error) {
        toast.error(formatInvokeError(error))
      } finally {
        setLoading(false)
      }
    },
    [pathsReady, state.qaIssues],
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

  const vietnameseMatcher = useMemo(
    () => createTextMatcher(submittedQuery, matchOptions),
    [matchOptions, submittedQuery],
  )

  const replaceableMatches = useMemo(() => {
    if (!submittedQuery) return []
    return result.matches.filter((match) =>
      vietnameseMatcher(formatLocDisplayText(match.vietnamese)),
    )
  }, [result.matches, submittedQuery, vietnameseMatcher])

  const replaceableCount = useMemo(() => {
    if (!submittedQuery) return 0
    return replaceableMatches.reduce(
      (sum, match) =>
        sum +
        findTextMatchRanges(
          formatLocDisplayText(match.vietnamese),
          submittedQuery,
          matchOptions,
        ).length,
      0,
    )
  }, [matchOptions, replaceableMatches, submittedQuery])

  const summary = useMemo(() => {
    if (!hasSearched) {
      return "Nhập từ khóa rồi bấm Tìm, hoặc để trống để tải toàn bộ dữ liệu."
    }
    const parts = [
      result.query
        ? `${result.totalMatches.toLocaleString("vi-VN")} kết quả`
        : `${result.totalMatches.toLocaleString("vi-VN")} bản ghi`,
      `${result.scannedFiles.toLocaleString("vi-VN")} file đã quét`,
    ]
    if (!result.query) parts.push("toàn bộ dữ liệu")
    if (result.query && caseSensitive) parts.push("phân biệt hoa/thường")
    if (result.query && wholeWord) parts.push("khớp nguyên từ")
    if (result.truncated) {
      parts.push(
        result.query ? "đã giới hạn 500 kết quả" : "đã giới hạn số bản ghi",
      )
    }
    if (replaceOpen && replaceableCount > 0) {
      parts.push(
        `${replaceableCount.toLocaleString("vi-VN")} chỗ khớp trong VN`,
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

  const copyTag = async (tag: string) => {
    try {
      await navigator.clipboard.writeText(tag)
      toast.success("Đã sao chép tag.")
    } catch {
      toast.error("Không sao chép được tag.")
    }
  }

  const startEditing = (match: TagSearchMatch) => {
    if (editing?.saving) return
    setActiveMatchId(match.id)
    setEditing({ id: match.id, value: match.vietnamese, saving: false })
  }

  const cancelEditing = () => {
    if (editing?.saving) return
    setEditing(null)
  }

  const persistVietnamese = useCallback(
    async (match: TagSearchMatch, vietnamese: string) => {
      if (isTauriRuntime()) {
        if (!canSave) {
          throw new Error("Cần cấu hình modPath trước khi lưu.")
        }
        await ipc.updateTag({
          file: match.file,
          tag: match.tag,
          entryType: match.entryType,
          vietnamese,
          timing: match.timing,
        })
      }
      setResult((current) => ({
        ...current,
        matches: current.matches.map((item) =>
          item.id === match.id ? { ...item, vietnamese } : item,
        ),
      }))
    },
    [canSave],
  )

  const saveEditing = async (match: TagSearchMatch) => {
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
    if (submittedQuery) {
      void performSearch(submittedQuery, scope, next)
    }
  }

  const replaceOne = async () => {
    if (!submittedQuery || replacing) return
    if (isTauriRuntime() && !canSave) {
      toast.error("Cần cấu hình modPath trước khi thay thế.")
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
      vietnameseMatcher(formatLocDisplayText(match.vietnamese)),
    )
    if (!target) {
      toast.message("Không còn chỗ khớp trong bản dịch VN.")
      return
    }

    const { text, count } = replaceTextMatches(
      target.vietnamese,
      submittedQuery,
      replaceValue,
      matchOptions,
      1,
    )
    if (count === 0) {
      toast.message("Không còn chỗ khớp trong bản dịch VN.")
      return
    }

    setReplacing(true)
    setActiveMatchId(target.id)
    try {
      await persistVietnamese(target, text)
      toast.success("Đã thay thế 1 chỗ khớp.")
    } catch (error) {
      toast.error(formatInvokeError(error))
    } finally {
      setReplacing(false)
    }
  }

  const replaceAll = async () => {
    if (!submittedQuery || replacing) return
    if (isTauriRuntime() && !canSave) {
      toast.error("Cần cấu hình modPath trước khi thay thế.")
      return
    }
    if (replaceableMatches.length === 0) {
      toast.message("Không có chỗ khớp trong bản dịch VN.")
      return
    }

    setReplacing(true)
    let replacedOccurrences = 0
    let updatedRows = 0
    try {
      for (const match of replaceableMatches) {
        const { text, count } = replaceTextMatches(
          match.vietnamese,
          submittedQuery,
          replaceValue,
          matchOptions,
        )
        if (count === 0) continue
        await persistVietnamese(match, text)
        replacedOccurrences += count
        updatedRows += 1
      }
      toast.success(
        `Đã thay thế ${replacedOccurrences.toLocaleString("vi-VN")} chỗ trong ${updatedRows.toLocaleString("vi-VN")} tag.`,
      )
    } catch (error) {
      toast.error(formatInvokeError(error))
    } finally {
      setReplacing(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className={cn(pageContainerClass, "flex min-h-0 flex-1 flex-col")}>
        <PageHeader
          eyebrow="Tra cứu"
          title="Tra cứu"
          description="Tìm LOC_*, sửa bản dịch tiếng Việt và thay thế hàng loạt giống VS Code."
        />

        {!isTauriRuntime() && (
          <Alert>
            <AlertTitle>Chế độ demo</AlertTitle>
            <AlertDescription>
              Tra cứu/sửa trên dữ liệu QA mẫu. Trong app desktop, thay đổi được
              ghi vào thư mục mod.
            </AlertDescription>
          </Alert>
        )}

        {isTauriRuntime() && !pathsReady && (
          <Alert variant="destructive">
            <AlertTitle>Thiếu đường dẫn</AlertTitle>
            <AlertDescription>
              Cấu hình exportPath hoặc modPath trong Cài đặt trước khi tra cứu.
            </AlertDescription>
          </Alert>
        )}

        {isTauriRuntime() && pathsReady && !canSave && (
          <Alert>
            <AlertTitle>Chỉ xem</AlertTitle>
            <AlertDescription>
              Chưa cấu hình modPath — có thể tra cứu nhưng chưa lưu/thay thế
              được bản dịch.
            </AlertDescription>
          </Alert>
        )}

        <Card className="shrink-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SearchIcon className="size-4" />
              Tìm và thay thế
            </CardTitle>
            <CardDescription>
              Tìm theo tag/nội dung, bấm mũi tên để mở Replace. Thay thế chỉ áp
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
                    placeholder="Tìm LOC_* hoặc nội dung… (để trống = tải toàn bộ)"
                  />
                  {replaceOpen && (
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
                        disabled={replacing}
                        className="min-w-0 flex-1"
                      />
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => void replaceOne()}
                          disabled={
                            replacing ||
                            loading ||
                            !submittedQuery ||
                            replaceableCount === 0
                          }
                          title="Thay thế chỗ khớp tiếp theo trong VN"
                        >
                          {replacing ? (
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
                            replacing ||
                            loading ||
                            !submittedQuery ||
                            replaceableCount === 0
                          }
                          title="Thay thế tất cả chỗ khớp trong VN"
                        >
                          <ReplaceAllIcon className="size-4" />
                          Replace All
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <Select
                value={scope}
                onValueChange={(value) => {
                  const nextScope = value as TagSearchScope
                  setScope(nextScope)
                  if (submittedQuery) {
                    void performSearch(submittedQuery, nextScope, matchOptions)
                  } else if (hasSearched) {
                    setResult((current) => ({
                      ...current,
                      scope: nextScope,
                    }))
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
                <Button onClick={() => void runSearch()} disabled={loading}>
                  {loading
                    ? query.trim()
                      ? "Đang tìm…"
                      : "Đang tải…"
                    : "Tìm"}
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

        {hasSearched && (
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
                  <>Toàn bộ dữ liệu · </>
                )}
                Bấm ô Tiếng Việt để sửa trực tiếp.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {result.matches.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {result.query
                    ? `Không có kết quả cho "${result.query}".`
                    : "Không có dữ liệu localization."}
                </p>
              ) : (
                <>
                  <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
                    <Table
                      className="table-fixed"
                      containerClassName="overflow-visible"
                    >
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10 whitespace-normal text-center">
                            No
                          </TableHead>
                          <TableHead className="w-[28%] whitespace-normal">
                            Tag
                          </TableHead>
                          <TableHead className="whitespace-normal">
                            Tiếng Anh
                          </TableHead>
                          <TableHead className="whitespace-normal">
                            Tiếng Việt
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {paginatedMatches.map((match, index) => {
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
                              <TableCell className="h-px whitespace-normal p-0 text-xs font-medium leading-tight">
                                <div className="flex h-full flex-col justify-center gap-1 px-1.5 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="min-w-0 break-all">
                                      <HighlightedSearchText
                                        text={match.tag}
                                        query={result.query}
                                        caseSensitive={caseSensitive}
                                        wholeWord={wholeWord}
                                      />
                                    </span>
                                    {match.entryType !== "VTT" && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-7 shrink-0"
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          void copyTag(match.tag)
                                        }}
                                        title="Sao chép tag"
                                      >
                                        <CopyIcon className="size-3.5" />
                                      </Button>
                                    )}
                                  </div>
                                  {match.entryType !== "Row" && (
                                    <Badge variant="outline" className="w-fit">
                                      {match.entryType}
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="h-px whitespace-normal p-0 text-xs leading-tight">
                                <div className="flex h-full items-center px-1.5 py-2 break-words whitespace-normal">
                                  <HighlightedSearchText
                                    text={formatLocDisplayText(match.english)}
                                    query={result.query}
                                    caseSensitive={caseSensitive}
                                    wholeWord={wholeWord}
                                  />
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
                                      text={formatLocDisplayText(
                                        match.vietnamese,
                                      )}
                                      query={result.query}
                                      caseSensitive={caseSensitive}
                                      wholeWord={wholeWord}
                                    />
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
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
        )}
      </div>
    </div>
  )
}
