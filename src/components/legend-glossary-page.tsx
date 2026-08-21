import { useEffect, useMemo, useRef, useState } from "react"
import {
  DownloadIcon,
  FileUpIcon,
  LockIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UnlockIcon,
} from "lucide-react"
import { toast } from "sonner"
import { AsyncPageShell } from "@/components/async-page-shell"
import { PageHeader, pageContainerClass } from "@/components/product-ui"
import {
  shouldVirtualizeTableRows,
  useVirtualTableScrollRef,
  VirtualizedTableBody,
} from "@/components/virtualized-table-body"
import { PresenceAlert } from "@/components/presence-fade"
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
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
import type { LegendGlossaryEntry } from "@/lib/legend-types"
import { useAsyncTask } from "@/hooks/use-async-task"
import { formatInvokeError, ipc } from "@/lib/tauri-ipc"

type LocalGlossaryEntry = LegendGlossaryEntry & { id: string }

const emptyEntry = (id: string): LocalGlossaryEntry => ({
  id,
  source: "",
  target: "",
  locked: false,
  note: "",
})

export function LegendGlossaryPage({
  locked = false,
  onDirtyChange,
  pendingDropPath = null,
  onDropPathConsumed,
}: {
  locked?: boolean
  onDirtyChange?: (dirty: boolean) => void
  pendingDropPath?: string | null
  onDropPathConsumed?: () => void
}) {
  const nextId = useRef(0)
  const withIds = (items: LegendGlossaryEntry[]): LocalGlossaryEntry[] =>
    items.map((entry) => ({ ...entry, id: `glossary-${nextId.current++}` }))
  const [entries, setEntries] = useState<LocalGlossaryEntry[]>([])
  const [savedEntries, setSavedEntries] = useState<LocalGlossaryEntry[]>([])
  const [path, setPath] = useState("")
  const [query, setQuery] = useState("")
  const [dirty, setDirty] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [pendingImport, setPendingImport] = useState<
    LocalGlossaryEntry[] | null
  >(null)
  const {
    run: runAsyncTask,
    loading,
    title: loadingTitle,
    description: loadingDescription,
    phase: loadingPhase,
    phaseLabel: loadingPhaseLabel,
    progress: loadingProgress,
  } = useAsyncTask({ title: "Đang tải glossary…" })

  function markDirty(value: boolean) {
    setDirty(value)
    onDirtyChange?.(value)
  }

  useEffect(() => {
    if (pendingDropPath) return

    void runAsyncTask({
      title: "Đang tải glossary…",
      description: "Đọc file glossary Tam Quốc.",
      task: () => ipc.getLegendGlossary(),
      renderResult: (document) => {
        const loaded = withIds(document.entries)
        setEntries(loaded)
        setSavedEntries(loaded)
        setPath(document.path)
      },
    }).catch((error) => toast.error(formatInvokeError(error)))
  }, [pendingDropPath, runAsyncTask])

  useEffect(() => {
    if (!pendingDropPath) return

    let cancelled = false
    void runAsyncTask({
      title: "Đang import glossary…",
      description: "Đọc file JSON đã thả vào app.",
      task: () => ipc.getLegendGlossary(pendingDropPath),
      renderResult: (imported) => {
        if (!cancelled) {
          setPendingImport(withIds(imported.entries))
        }
      },
    })
      .catch((error) => {
        if (!cancelled) toast.error(formatInvokeError(error))
      })
      .finally(() => {
        if (!cancelled) onDropPathConsumed?.()
      })

    return () => {
      cancelled = true
    }
  }, [onDropPathConsumed, pendingDropPath, runAsyncTask])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [dirty])

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return entries
    return entries.filter((entry) =>
      `${entry.source}\n${entry.target}\n${entry.note}`
        .toLocaleLowerCase()
        .includes(normalized),
    )
  }, [entries, query])
  const tableScrollRef = useVirtualTableScrollRef()
  const virtualizeTableRows = shouldVirtualizeTableRows(visible.length)

  function update(id: string, patch: Partial<LegendGlossaryEntry>) {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    )
    markDirty(true)
  }

  async function saveActive() {
    try {
      await runAsyncTask({
        title: "Đang lưu glossary…",
        description: "Ghi file glossary Tam Quốc.",
        phase: "saving",
        task: () => ipc.saveLegendGlossary(entries),
        renderResult: (document) => {
          const saved = withIds(document.entries)
          setEntries(saved)
          setSavedEntries(saved)
          setSelectedIds(new Set())
          setPath(document.path)
          markDirty(false)
        },
      })
      toast.success("Đã lưu Glossary Tam Quốc.")
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  async function importGlossary() {
    const selected = await ipc.pickFile(path, [
      { name: "Glossary JSON", extensions: ["json"] },
    ])
    if (!selected) return
    try {
      await runAsyncTask({
        title: "Đang import glossary…",
        description: "Đọc file JSON đã chọn.",
        task: () => ipc.getLegendGlossary(selected),
        renderResult: (imported) => {
          setPendingImport(withIds(imported.entries))
        },
      })
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  async function exportGlossary(format: "v2" | "flat") {
    const selected = await ipc.pickSaveFile(`legend-glossary-${format}.json`, [
      { name: "Glossary JSON", extensions: ["json"] },
    ])
    if (!selected) return
    try {
      await runAsyncTask({
        title: "Đang export glossary…",
        description: "Ghi file JSON ra đĩa.",
        phase: "saving",
        task: () => ipc.exportLegendGlossary(entries, selected, format),
      })
      toast.success(`Đã export glossary ${format}.`)
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  return (
    <AsyncPageShell
      className={pageContainerClass}
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
        eyebrow="Legend of Heroes Three Kingdoms"
        title="Glossary Tam Quốc"
        description="Khóa đúng tên người, địa danh và vật phẩm lịch sử (Hán–Việt từ điển)."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={locked}
              onClick={importGlossary}
            >
              <FileUpIcon data-icon="inline-start" />
              Import
            </Button>
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => void exportGlossary("v2")}
            >
              <DownloadIcon data-icon="inline-start" />
              Export v2
            </Button>
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => void exportGlossary("flat")}
            >
              <DownloadIcon data-icon="inline-start" />
              Export flat
            </Button>
            <Button disabled={!dirty || locked} onClick={saveActive}>
              <SaveIcon data-icon="inline-start" />
              Lưu
            </Button>
          </div>
        }
      />

      <PresenceAlert show={dirty}>
        <SaveIcon />
        <AlertTitle>Có thay đổi chưa lưu</AlertTitle>
        <AlertDescription>
          Glossary chỉ ảnh hưởng job dịch bắt đầu sau khi lưu.
          <Button
            className="ml-2"
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => {
              setEntries(savedEntries.map((entry) => ({ ...entry })))
              setSelectedIds(new Set())
              markDirty(false)
            }}
          >
            Hoàn tác
          </Button>
        </AlertDescription>
      </PresenceAlert>

      <Card>
        <CardHeader>
          <CardTitle>{entries.length} thuật ngữ</CardTitle>
          <CardDescription className="truncate">{path}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={query}
              placeholder="Tìm tiếng Trung, tiếng Việt hoặc ghi chú…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => {
                setEntries((current) => [
                  emptyEntry(`glossary-${nextId.current++}`),
                  ...current,
                ])
                markDirty(true)
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Thêm thuật ngữ
            </Button>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Đang tải glossary…</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || visible.length === 0}
                  onClick={() => {
                    const visibleIds = visible.map((entry) => entry.id)
                    const allSelected = visibleIds.every((id) =>
                      selectedIds.has(id),
                    )
                    setSelectedIds((current) => {
                      const next = new Set(current)
                      for (const id of visibleIds) {
                        if (allSelected) next.delete(id)
                        else next.add(id)
                      }
                      return next
                    })
                  }}
                >
                  Chọn tất cả kết quả lọc
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || selectedIds.size === 0}
                  onClick={() => {
                    setEntries((current) =>
                      current.map((entry) =>
                        selectedIds.has(entry.id)
                          ? { ...entry, locked: true }
                          : entry,
                      ),
                    )
                    markDirty(true)
                  }}
                >
                  Khóa đã chọn
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || selectedIds.size === 0}
                  onClick={() => {
                    setEntries((current) =>
                      current.map((entry) =>
                        selectedIds.has(entry.id)
                          ? { ...entry, locked: false }
                          : entry,
                      ),
                    )
                    markDirty(true)
                  }}
                >
                  Mở khóa đã chọn
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={locked || selectedIds.size === 0}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Xóa ${selectedIds.size} thuật ngữ đã chọn?`,
                      )
                    )
                      return
                    setEntries((current) =>
                      current.filter((entry) => !selectedIds.has(entry.id)),
                    )
                    setSelectedIds(new Set())
                    markDirty(true)
                  }}
                >
                  Xóa đã chọn
                </Button>
              </div>
              <div
                ref={tableScrollRef}
                className="max-h-[min(70vh,960px)] overflow-auto rounded-xl border"
              >
                <Table className="table-fixed" containerClassName="overflow-visible">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <span className="flex w-full justify-center">Chọn</span>
                      </TableHead>
                      <TableHead className="w-12">
                        <span className="flex w-full justify-center">Khóa</span>
                      </TableHead>
                      <TableHead>Tiếng Trung</TableHead>
                      <TableHead>Tiếng Việt</TableHead>
                      <TableHead>Ghi chú</TableHead>
                      <TableHead className="w-10">
                        <span className="sr-only">Xóa</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  {virtualizeTableRows ? (
                    <VirtualizedTableBody
                      rows={visible}
                      scrollRef={tableScrollRef}
                      colSpan={6}
                      estimateSize={56}
                      renderRow={(entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="w-12 p-1.5 text-center align-middle">
                            <span className="flex w-full justify-center">
                              <Checkbox
                                checked={selectedIds.has(entry.id)}
                                disabled={locked}
                                aria-label={`Chọn ${entry.source || "thuật ngữ mới"}`}
                                onCheckedChange={(checked) =>
                                  setSelectedIds((current) => {
                                    const next = new Set(current)
                                    if (checked === true) next.add(entry.id)
                                    else next.delete(entry.id)
                                    return next
                                  })
                                }
                              />
                            </span>
                          </TableCell>
                          <TableCell className="w-12 p-1.5 text-center align-middle">
                            <span className="flex w-full justify-center">
                              <Checkbox
                                checked={entry.locked}
                                disabled={locked}
                                aria-label={`Khóa ${entry.source || "thuật ngữ mới"}`}
                                onCheckedChange={(checked) =>
                                  update(entry.id, { locked: checked === true })
                                }
                              />
                            </span>
                          </TableCell>
                          <TableCell>
                            <Input
                              value={entry.source}
                              disabled={locked || entry.locked}
                              aria-label="Thuật ngữ tiếng Trung"
                              onChange={(event) =>
                                update(entry.id, { source: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={entry.target}
                              disabled={locked || entry.locked}
                              aria-label="Thuật ngữ tiếng Việt"
                              onChange={(event) =>
                                update(entry.id, { target: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={entry.note}
                              disabled={locked}
                              aria-label="Ghi chú thuật ngữ"
                              onChange={(event) =>
                                update(entry.id, { note: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell className="w-10 p-1.5 text-center align-middle">
                            <span className="flex w-full justify-center">
                              <Button
                                size="icon-sm"
                                variant="destructive"
                                disabled={locked || entry.locked}
                                aria-label="Xóa thuật ngữ"
                                onClick={() => {
                                  setEntries((current) =>
                                    current.filter(
                                      (item) => item.id !== entry.id,
                                    ),
                                  )
                                  markDirty(true)
                                }}
                              >
                                <Trash2Icon />
                              </Button>
                            </span>
                          </TableCell>
                        </TableRow>
                      )}
                    />
                  ) : (
                    <TableBody>
                      {visible.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="w-12 p-1.5 text-center align-middle">
                            <span className="flex w-full justify-center">
                              <Checkbox
                                checked={selectedIds.has(entry.id)}
                                disabled={locked}
                                aria-label={`Chọn ${entry.source || "thuật ngữ mới"}`}
                                onCheckedChange={(checked) =>
                                  setSelectedIds((current) => {
                                    const next = new Set(current)
                                    if (checked === true) next.add(entry.id)
                                    else next.delete(entry.id)
                                    return next
                                  })
                                }
                              />
                            </span>
                          </TableCell>
                          <TableCell className="w-12 p-1.5 text-center align-middle">
                            <span className="flex w-full justify-center">
                              <Checkbox
                                checked={entry.locked}
                                disabled={locked}
                                aria-label={`Khóa ${entry.source || "thuật ngữ mới"}`}
                                onCheckedChange={(checked) =>
                                  update(entry.id, { locked: checked === true })
                                }
                              />
                            </span>
                          </TableCell>
                          <TableCell>
                            <Input
                              value={entry.source}
                              disabled={locked || entry.locked}
                              aria-label="Thuật ngữ tiếng Trung"
                              onChange={(event) =>
                                update(entry.id, { source: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={entry.target}
                              disabled={locked || entry.locked}
                              aria-label="Thuật ngữ tiếng Việt"
                              onChange={(event) =>
                                update(entry.id, { target: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={entry.note}
                              disabled={locked}
                              aria-label="Ghi chú thuật ngữ"
                              onChange={(event) =>
                                update(entry.id, { note: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell className="w-10 p-1.5 text-center align-middle">
                            <span className="flex w-full justify-center">
                              <Button
                                size="icon-sm"
                                variant="destructive"
                                disabled={locked || entry.locked}
                                aria-label="Xóa thuật ngữ"
                                onClick={() => {
                                  setEntries((current) =>
                                    current.filter(
                                      (item) => item.id !== entry.id,
                                    ),
                                  )
                                  markDirty(true)
                                }}
                              >
                                <Trash2Icon />
                              </Button>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  )}
                </Table>
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              <LockIcon /> {entries.filter((entry) => entry.locked).length} đã
              khóa
            </Badge>
            <Badge variant="outline">
              <UnlockIcon /> {entries.filter((entry) => !entry.locked).length}{" "}
              gợi ý
            </Badge>
          </div>
        </CardContent>
      </Card>
      <AlertDialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import glossary theo cách nào?</AlertDialogTitle>
            <AlertDialogDescription>
              Merge giữ mục hiện tại và cập nhật mục trùng tiếng Trung. Replace
              xóa toàn bộ danh sách hiện tại.
              {dirty && " Bạn đang có thay đổi chưa lưu."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pendingImport) return
                setEntries(pendingImport)
                setSelectedIds(new Set())
                setPendingImport(null)
                markDirty(true)
              }}
            >
              Replace
            </Button>
            <Button
              onClick={() => {
                if (!pendingImport) return
                const imported = new Map(
                  pendingImport.map((entry) => [entry.source, entry]),
                )
                setEntries((current) => {
                  const merged = current.map(
                    (entry) => imported.get(entry.source) ?? entry,
                  )
                  const existing = new Set(
                    current.map((entry) => entry.source),
                  )
                  return [
                    ...merged,
                    ...pendingImport.filter(
                      (entry) => !existing.has(entry.source),
                    ),
                  ]
                })
                setPendingImport(null)
                markDirty(true)
              }}
            >
              Merge
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AsyncPageShell>
  )
}
