import { Fragment, useMemo, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCheck2Icon,
  FileTextIcon,
  FolderOpenIcon,
  LanguagesIcon,
  SearchIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Metric, StatusBadge } from "@/components/product-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
import type { AppController } from "@/hooks/use-app-controller"
import type { InspectDiff, InspectDiffStatus } from "@/lib/app-types"
import {
  countInspectByStatus,
  filterInspectDiffs,
  formatInspectDeltaLabel,
  inspectSummaryMetrics,
} from "@/lib/inspect-diff"
import { resolveInspectFilePath } from "@/lib/path-utils"
import { formatInvokeError, ipc } from "@/lib/tauri-ipc"

const statusLabels: Record<InspectDiffStatus, string> = {
  "english-only": "Chỉ EN",
  "vietnamese-only": "Chỉ VN",
  different: "Khác cấu trúc",
  invalid: "Lỗi file",
}

const statusTabs = [
  ["all", "Tất cả"],
  ["english-only", "Chỉ EN"],
  ["vietnamese-only", "Chỉ VN"],
  ["different", "Khác"],
  ["invalid", "Lỗi"],
] as const

function openInspectFile(config: AppController["state"]["config"], diff: InspectDiff) {
  const path = resolveInspectFilePath(config, diff)
  if (!path) {
    toast.error("Không xác định được file cần mở.")
    return
  }
  void ipc.openFile(path).catch((error) => toast.error(formatInvokeError(error)))
}

export function InspectPreview({ controller }: { controller: AppController }) {
  const { state } = controller
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<"all" | InspectDiffStatus>("all")
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const snapshot = state.inspectSnapshot
  const metrics = inspectSummaryMetrics(snapshot)
  const diffs = snapshot?.diffs ?? []
  const filtered = useMemo(
    () => filterInspectDiffs(diffs, query, status),
    [diffs, query, status],
  )
  const counts = countInspectByStatus(diffs)

  if (state.selectedStep !== "inspect") return null

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Đối chiếu EN ↔ VN</CardTitle>
          <CardDescription>
            So sánh cấu trúc file/tag giữa export tiếng Anh và mod Việt hóa
          </CardDescription>
        </div>
        <CardAction>
          <StatusBadge
            status={state.steps.find((step) => step.id === "inspect")?.status ?? "ready"}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Metric icon={FileTextIcon} label="File EN" value={String(metrics.englishFiles)} />
          <Metric icon={LanguagesIcon} label="File VN" value={String(metrics.vietnameseFiles)} />
          <Metric icon={FileCheck2Icon} label="Tổng lệch" value={String(metrics.differentFiles)} />
          <Metric icon={FileTextIcon} label="Chỉ EN" value={String(metrics.englishOnly)} />
          <Metric icon={LanguagesIcon} label="Chỉ VN" value={String(metrics.vietnameseOnly)} />
          <Metric icon={FileCheck2Icon} label="File lỗi" value={String(metrics.invalidCount)} />
        </div>

        {diffs.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
            <FileCheck2Icon className="size-8 text-muted-foreground" />
            <p className="font-medium">Chưa có kết quả Inspect</p>
            <p className="text-sm text-muted-foreground">
              Chạy bước Kiểm tra để quét chênh lệch EN–VN.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Tìm theo file hoặc tag…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as typeof status)}
              >
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {statusTabs.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label} ({counts[value]})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <Tabs defaultValue="table">
              <TabsList>
                <TabsTrigger value="table">Danh sách file</TabsTrigger>
              </TabsList>
              <TabsContent value="table">
                <div className="max-h-[min(28rem,50vh)] overflow-auto rounded-lg border">
                  <Table className="table-fixed" containerClassName="overflow-visible">
                    <TableHeader className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]">
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead className="w-28">Trạng thái</TableHead>
                        <TableHead>File</TableHead>
                        <TableHead className="w-24">Tác vụ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                            Không có mục phù hợp bộ lọc hiện tại.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filtered.map((diff) => {
                          const isOpen = expanded.has(diff.id)
                          const hasDetails =
                            (diff.missingInVietnamese?.length ?? 0) > 0 ||
                            (diff.extraInVietnamese?.length ?? 0) > 0 ||
                            Boolean(diff.error)
                          return (
                            <Fragment key={diff.id}>
                              <TableRow key={diff.id}>
                                <TableCell>
                                  {hasDetails ? (
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      aria-label={isOpen ? "Thu gọn" : "Mở rộng"}
                                      onClick={() => toggleExpanded(diff.id)}
                                    >
                                      {isOpen ? (
                                        <ChevronDownIcon />
                                      ) : (
                                        <ChevronRightIcon />
                                      )}
                                    </Button>
                                  ) : null}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">{statusLabels[diff.status]}</Badge>
                                </TableCell>
                                <TableCell className="max-w-0 truncate text-xs">
                                  {diff.file}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label="Mở file"
                                    onClick={() => openInspectFile(state.config, diff)}
                                  >
                                    <FolderOpenIcon />
                                  </Button>
                                </TableCell>
                              </TableRow>
                              {isOpen && hasDetails && (
                                <TableRow key={`${diff.id}-detail`} className="bg-muted/20">
                                  <TableCell colSpan={4} className="whitespace-normal py-3">
                                    {diff.error ? (
                                      <p className="text-xs text-destructive">{diff.error}</p>
                                    ) : null}
                                    {diff.missingInVietnamese &&
                                    diff.missingInVietnamese.length > 0 ? (
                                      <div className="mb-2">
                                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                                          Thiếu ở VN
                                        </p>
                                        <div className="flex flex-wrap gap-1">
                                          {diff.missingInVietnamese.map((item, index) => (
                                            <Badge key={`m-${index}`} variant="secondary">
                                              {formatInspectDeltaLabel(item)}
                                            </Badge>
                                          ))}
                                        </div>
                                      </div>
                                    ) : null}
                                    {diff.extraInVietnamese &&
                                    diff.extraInVietnamese.length > 0 ? (
                                      <div>
                                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                                          Thừa ở VN
                                        </p>
                                        <div className="flex flex-wrap gap-1">
                                          {diff.extraInVietnamese.map((item, index) => (
                                            <Badge key={`e-${index}`} variant="outline">
                                              {formatInspectDeltaLabel(item)}
                                            </Badge>
                                          ))}
                                        </div>
                                      </div>
                                    ) : null}
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          )
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  )
}
