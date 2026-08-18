import { useCallback, useEffect, useMemo, useState } from "react"
import {
  BookAIcon,
  FolderOpenIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader, pageContainerClass, pageShellClass } from "@/components/product-ui"
import { AsyncPageShell } from "@/components/async-page-shell"
import {
  shouldVirtualizeTableRows,
  useVirtualTableScrollRef,
  VirtualizedTableBody,
} from "@/components/virtualized-table-body"
import { useAsyncTask } from "@/hooks/use-async-task"
import { PresenceAlert } from "@/components/presence-fade"
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
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
import type { AppView } from "@/lib/app-types"
import {
  entriesToRows,
  rowsToEntries,
  validateGlossaryRows,
  type GlossaryRow,
} from "@/lib/glossary"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"

const demoGlossary: Record<string, string> = {
  Civilization: "Nền văn minh",
  District: "Quận",
  Commander: "Chỉ huy",
}

export function GlossaryPage({
  controller,
  onNavigate,
}: {
  controller: AppController
  onNavigate: (view: AppView) => void
}) {
  const { state, actions } = controller
  const [rows, setRows] = useState<GlossaryRow[]>([])
  const [savedRows, setSavedRows] = useState<GlossaryRow[]>([])
  const [path, setPath] = useState(state.config.glossaryPath)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const {
    run: runAsyncTask,
    loading,
    title: loadingTitle,
    description: loadingDescription,
    phase: loadingPhase,
    phaseLabel: loadingPhaseLabel,
    progress: loadingProgress,
  } = useAsyncTask()
  const tableScrollRef = useVirtualTableScrollRef()

  const loadGlossary = useCallback(async () => {
    try {
      await runAsyncTask({
        title: "Đang tải glossary…",
        description: "Đang đọc file thuật ngữ.",
        task: async () => {
          if (isTauriRuntime()) {
            return ipc.getGlossary(path || undefined)
          }
          return {
            path: state.config.glossaryPath || "demo/glossary.json",
            exists: true,
            entries: demoGlossary,
          }
        },
        renderResult: (payload) => {
          setPath(payload.path)
          const nextRows = entriesToRows(payload.entries)
          setRows(nextRows)
          setSavedRows(nextRows)
        },
      })
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }, [path, runAsyncTask, state.config.glossaryPath])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadGlossary()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadGlossary])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return rows
    return rows.filter(
      (row) =>
        row.key.toLocaleLowerCase().includes(normalized) ||
        row.value.toLocaleLowerCase().includes(normalized),
    )
  }, [rows, query])

  const virtualizeGlossaryRows = shouldVirtualizeTableRows(filtered.length)

  const filteredIds = useMemo(
    () => filtered.map((row) => row.id),
    [filtered],
  )
  const selectedFilteredCount = useMemo(
    () => filteredIds.filter((id) => selected.has(id)).length,
    [filteredIds, selected],
  )
  const allFilteredSelected =
    filteredIds.length > 0 && selectedFilteredCount === filteredIds.length
  const someFilteredSelected =
    selectedFilteredCount > 0 && selectedFilteredCount < filteredIds.length

  const toggleSelectAllFiltered = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) {
        for (const id of filteredIds) next.add(id)
      } else {
        for (const id of filteredIds) next.delete(id)
      }
      return next
    })
  }

  const validationErrors = validateGlossaryRows(rows)
  const changed =
    JSON.stringify(rows) !== JSON.stringify(savedRows) ||
    path !== state.config.glossaryPath

  const updateRow = (id: string, patch: Partial<GlossaryRow>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    )
  }

  const addRow = () => {
    setRows((current) => [
      ...current,
      { id: `new-${Date.now()}`, key: "", value: "" },
    ])
  }

  const removeSelected = () => {
    if (selected.size === 0) return
    setRows((current) => current.filter((row) => !selected.has(row.id)))
    setSelected(new Set())
  }

  const chooseFile = async () => {
    const picked = await ipc.pickFile(path || state.config.glossaryPath, [
      { name: "JSON", extensions: ["json"] },
    ])
    if (!picked) return
    setPath(picked)
    if (isTauriRuntime()) {
      await actions.saveConfig({ ...state.config, glossaryPath: picked })
    }
    void loadGlossary()
  }

  const save = async () => {
    if (validationErrors.length > 0) {
      toast.error(validationErrors[0])
      return
    }
    try {
      const entries = rowsToEntries(rows)
      await runAsyncTask({
        title: "Đang lưu glossary…",
        description: "Đang ghi file thuật ngữ.",
        phase: "saving",
        task: async () => {
          if (isTauriRuntime()) {
            if (path !== state.config.glossaryPath) {
              await actions.saveConfig({ ...state.config, glossaryPath: path })
            }
            return ipc.saveGlossary(entries, path || undefined)
          }
          Object.assign(demoGlossary, entries)
          return { path: path || "demo/glossary.json", entries: Object.keys(entries).length }
        },
        renderResult: (result) => {
          if (isTauriRuntime() && result.path) setPath(result.path)
          setSavedRows(rows)
        },
      })
      toast.success(
        isTauriRuntime()
          ? `Đã lưu glossary.`
          : "Đã lưu glossary (demo in-memory).",
      )
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AsyncPageShell
          className={cn(pageContainerClass, "flex min-h-full flex-col")}
          loading={loading}
          overlay={{
            title: loadingTitle,
            description: loadingDescription,
            phase: loadingPhase ?? undefined,
            phaseLabel: loadingPhaseLabel ?? undefined,
            progress: loadingProgress,
          }}
        >
      <PageHeader
        eyebrow="Thuật ngữ"
        title="Glossary Editor"
        description="Quản lý thuật ngữ EN → VN được engine đưa vào prompt khi dịch."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void chooseFile()}>
              <FolderOpenIcon data-icon="inline-start" />
              Chọn file
            </Button>
            {path && isTauriRuntime() && (
              <Button
                variant="outline"
                onClick={() =>
                  void ipc.openFile(path).catch((error) =>
                    toast.error(formatInvokeError(error)),
                  )
                }
              >
                Mở trong Explorer
              </Button>
            )}
          </div>
        }
      />

      <PresenceAlert show={!state.config.glossaryPath && !path}>
        <BookAIcon />
        <AlertTitle>Chưa chọn file glossary</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>Chọn file JSON hoặc cấu hình trong Cài đặt.</span>
          <Button size="sm" variant="outline" onClick={() => onNavigate("settings")}>
            Mở Cài đặt
          </Button>
        </AlertDescription>
      </PresenceAlert>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="shrink-0">
          <CardTitle>File hiện tại</CardTitle>
          <CardDescription className="text-xs break-all">
            {path || "Chưa có đường dẫn"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Tìm thuật ngữ…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Badge variant="outline">{rows.length} mục</Badge>
            <Button size="sm" variant="outline" onClick={addRow}>
              <PlusIcon data-icon="inline-start" />
              Thêm
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={selected.size === 0}
              onClick={removeSelected}
            >
              <Trash2Icon data-icon="inline-start" />
              Xóa đã chọn
            </Button>
          </div>

          <PresenceAlert show={validationErrors.length > 0} variant="destructive">
            <AlertTitle>Không thể lưu</AlertTitle>
            <AlertDescription>{validationErrors.join(" ")}</AlertDescription>
          </PresenceAlert>

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
                  <TableHead className="h-px w-10 p-0">
                    <div className="flex h-full items-center justify-center px-1.5 py-2">
                      <Checkbox
                        checked={
                          someFilteredSelected
                            ? "indeterminate"
                            : allFilteredSelected
                        }
                        disabled={loading || filteredIds.length === 0}
                        onCheckedChange={(checked) =>
                          toggleSelectAllFiltered(checked === true)
                        }
                        aria-label="Chọn tất cả"
                      />
                    </div>
                  </TableHead>
                  <TableHead className="h-px whitespace-normal p-0">
                    <div className="flex h-full items-center px-1.5 py-2">Thuật ngữ EN</div>
                  </TableHead>
                  <TableHead className="h-px whitespace-normal p-0">
                    <div className="flex h-full items-center px-1.5 py-2">Bản dịch VN</div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              {loading ? (
                <TableBody>
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-muted-foreground"
                    >
                      Đang tải glossary…
                    </TableCell>
                  </TableRow>
                </TableBody>
              ) : filtered.length === 0 ? (
                <TableBody>
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-muted-foreground"
                    >
                      Không có mục nào.
                    </TableCell>
                  </TableRow>
                </TableBody>
              ) : virtualizeGlossaryRows ? (
                <VirtualizedTableBody
                  rows={filtered}
                  scrollRef={tableScrollRef}
                  colSpan={3}
                  renderRow={(row) => (
                    <TableRow key={row.id}>
                      <TableCell className="h-px w-10 p-0 text-center">
                        <div className="flex h-full items-center justify-center px-1.5 py-2">
                          <Checkbox
                            checked={selected.has(row.id)}
                            onCheckedChange={(checked) => {
                              setSelected((current) => {
                                const next = new Set(current)
                                if (checked) next.add(row.id)
                                else next.delete(row.id)
                                return next
                              })
                            }}
                            aria-label={`Chọn ${row.key || "dòng mới"}`}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="h-px whitespace-normal p-0">
                        <div className="flex h-full items-center px-1.5 py-2">
                          <Input
                            value={row.key}
                            onChange={(event) =>
                              updateRow(row.id, { key: event.target.value })
                            }
                            placeholder="English term"
                          />
                        </div>
                      </TableCell>
                      <TableCell className="h-px whitespace-normal p-0">
                        <div className="flex h-full items-center px-1.5 py-2">
                          <Input
                            value={row.value}
                            onChange={(event) =>
                              updateRow(row.id, { value: event.target.value })
                            }
                            placeholder="Bản dịch tiếng Việt"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                />
              ) : (
                <TableBody>
                  {filtered.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="h-px w-10 p-0 text-center">
                        <div className="flex h-full items-center justify-center px-1.5 py-2">
                          <Checkbox
                            checked={selected.has(row.id)}
                            onCheckedChange={(checked) => {
                              setSelected((current) => {
                                const next = new Set(current)
                                if (checked) next.add(row.id)
                                else next.delete(row.id)
                                return next
                              })
                            }}
                            aria-label={`Chọn ${row.key || "dòng mới"}`}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="h-px whitespace-normal p-0">
                        <div className="flex h-full items-center px-1.5 py-2">
                          <Input
                            value={row.key}
                            onChange={(event) =>
                              updateRow(row.id, { key: event.target.value })
                            }
                            placeholder="English term"
                          />
                        </div>
                      </TableCell>
                      <TableCell className="h-px whitespace-normal p-0">
                        <div className="flex h-full items-center px-1.5 py-2">
                          <Input
                            value={row.value}
                            onChange={(event) =>
                              updateRow(row.id, { value: event.target.value })
                            }
                            placeholder="Bản dịch tiếng Việt"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              )}
            </Table>
          </div>
        </CardContent>
      </Card>
        </AsyncPageShell>
      </div>

      <footer className="shrink-0 border-t bg-background">
        <div className={cn(pageShellClass, "flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between")}>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  changed ? "bg-warning" : "bg-success",
                )}
              />
              <p className="truncate text-sm font-medium">Glossary Editor</p>
              {changed ? (
                <Badge variant="outline" className="hidden sm:inline-flex">
                  Chưa lưu
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
              {validationErrors.length > 0
                ? validationErrors[0]
                : changed
                  ? "Có thay đổi chưa lưu — bấm Lưu glossary để ghi file."
                  : `${rows.length.toLocaleString("vi-VN")} thuật ngữ · đã đồng bộ`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={!changed || loading}
              onClick={() => {
                setRows(savedRows)
                setSelected(new Set())
              }}
            >
              Hoàn tác
            </Button>
            <Button
              size="sm"
              disabled={!changed || loading || validationErrors.length > 0}
              onClick={() => void save()}
            >
              <SaveIcon data-icon="inline-start" />
              Lưu glossary
            </Button>
          </div>
        </div>
      </footer>
    </div>
  )
}
