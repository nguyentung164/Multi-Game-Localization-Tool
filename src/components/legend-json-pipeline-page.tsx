import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2Icon,
  DatabaseIcon,
  FolderOpenIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  SearchIcon,
  ShieldAlertIcon,
  SquareIcon,
} from "lucide-react";

import { LegendJobConsole } from "@/components/legend-job-console";
import {
  SYNC_TABLE_PAGE_SIZE_OPTIONS,
  TablePaginator,
} from "@/components/table-paginator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { UseLegendJsonPipelineReturn } from "@/hooks/use-legend-json-pipeline";
import { useLegendJsonProgress } from "@/lib/legend-json-progress-store";
import {
  legendJsonApplySkipSummary,
  type LegendJsonEntry,
  type LegendJsonEntryDetail,
  type LegendJsonEstimate,
  type LegendJsonPreview,
  type LegendJsonQaIssue,
  type LegendJsonStatus,
} from "@/lib/legend-json-types";
import { formatDateTime } from "@/lib/format-date";
import { displayWindowsPath } from "@/lib/path-utils";
import { qaRuleLabel } from "@/lib/qa-labels";
import { ipc } from "@/lib/tauri-ipc";

const STATUS_OPTIONS: LegendJsonStatus[] = [
  "All",
  "New",
  "Translated",
  "Needs review",
  "Needs classification",
  "Excluded",
  "Orphan",
  "Conflict",
];

const STATUS_LABELS: Record<LegendJsonStatus, string> = {
  All: "Tất cả",
  New: "Mới",
  Translated: "Đã dịch",
  "Needs review": "Cần duyệt",
  "Needs classification": "Cần phân loại",
  Excluded: "Đã loại",
  Orphan: "Không còn trong JSON",
  Conflict: "Xung đột",
};

const CHANGE_KIND_LABELS: Record<
  LegendJsonPreview["changes"][number]["kind"],
  string
> = {
  append: "Thêm",
  update: "Cập nhật",
};

function usePagedItems<T>(items: readonly T[], resetKey: string) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(
    SYNC_TABLE_PAGE_SIZE_OPTIONS[1],
  );
  useEffect(() => {
    setPage(1);
  }, [resetKey]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize) || 1);
  const safePage = Math.min(page, totalPages);
  const paged = items.slice((safePage - 1) * pageSize, safePage * pageSize);
  return {
    page: safePage,
    pageSize,
    totalPages,
    paged,
    setPage,
    changePageSize: (value: number) => {
      setPage(1);
      setPageSize(value);
    },
  };
}

function RevealInTableButton({
  source,
  sourceHash,
  onReveal,
}: {
  source?: string;
  sourceHash?: string;
  onReveal: (source: string, sourceHash?: string) => void;
}) {
  const canReveal = Boolean(source || sourceHash);
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-7"
      disabled={!canReveal}
      aria-label="Hiện trong bảng Text đã phát hiện"
      title="Hiện trong bảng Text đã phát hiện"
      onClick={() => onReveal(source ?? "", sourceHash)}
    >
      <ScanSearchIcon />
    </Button>
  );
}

function statusVariant(
  status: LegendJsonEntry["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "Conflict") return "destructive";
  if (status === "Translated") return "default";
  if (status === "Needs review" || status === "Needs classification")
    return "secondary";
  return "outline";
}

function PathField({
  id,
  label,
  value,
  directory = false,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  directory?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const pick = async () => {
    const selected = directory
      ? await ipc.pickDirectory(value || undefined)
      : await ipc.pickFile(value || undefined, [
          { name: "XUnity translations", extensions: ["txt"] },
        ]);
    if (selected) onChange(selected);
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={pick}
          disabled={disabled}
          aria-label={`Chọn ${label}`}
        >
          <FolderOpenIcon data-icon="inline-start" />
        </Button>
      </div>
    </Field>
  );
}

function PreviewReviewPanel({
  issues,
  blocking,
  changes,
  onReveal,
}: {
  issues: LegendJsonQaIssue[];
  blocking: boolean;
  changes: LegendJsonPreview["changes"];
  onReveal: (source: string, sourceHash?: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "error" | "warning">(
    blocking ? "error" : "all",
  );
  const [rule, setRule] = useState("all");
  const bySeverity = issues.filter(
    (issue) => filter === "all" || issue.severity === filter,
  );
  const ruleOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      if (filter !== "all" && issue.severity !== filter) continue;
      counts.set(issue.rule, (counts.get(issue.rule) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([value, count]) => ({ value, count }));
  }, [filter, issues]);
  const filtered = bySeverity.filter(
    (issue) => rule === "all" || issue.rule === rule,
  );
  const qaPage = usePagedItems(filtered, `${filter}:${rule}:${filtered.length}`);
  const changePage = usePagedItems(changes, String(changes.length));
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter(
    (issue) => issue.severity === "warning",
  ).length;
  const changeSeverity = (value: "all" | "error" | "warning") => {
    setFilter(value);
    setRule("all");
  };
  const defaultTab =
    blocking && issues.length > 0
      ? "qa"
      : changes.length > 0
        ? "changes"
        : "qa";
  const [tab, setTab] = useState<"qa" | "changes">(defaultTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as "qa" | "changes")}
      className="gap-3"
    >
      <TabsList>
        <TabsTrigger value="qa" onClick={() => setTab("qa")}>
          Lỗi / Cảnh báo ({issues.length.toLocaleString("vi-VN")})
        </TabsTrigger>
        <TabsTrigger value="changes" onClick={() => setTab("changes")}>
          Thay đổi dự kiến ({changes.length.toLocaleString("vi-VN")})
        </TabsTrigger>
      </TabsList>
      {tab === "qa" ? (
      <TabsContent value="qa">
        <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["error", `Lỗi (${errorCount})`],
              ["warning", `Cảnh báo (${warningCount})`],
              ["all", `Tất cả (${issues.length})`],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "default" : "outline"}
              onClick={() => changeSeverity(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {ruleOptions.length > 1 ? (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={rule === "all" ? "secondary" : "outline"}
              onClick={() => setRule("all")}
            >
              Mọi loại ({bySeverity.length})
            </Button>
            {ruleOptions.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={rule === option.value ? "secondary" : "outline"}
                onClick={() => setRule(option.value)}
              >
                {qaRuleLabel(option.value)} ({option.count})
              </Button>
            ))}
          </div>
        ) : null}
        <div className="rounded-lg border">
          <Table
            className="table-fixed text-xs"
            containerClassName="max-h-72 overflow-auto"
          >
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Mức</TableHead>
                <TableHead className="w-44">Loại</TableHead>
                <TableHead>Chi tiết</TableHead>
                <TableHead>Nguồn</TableHead>
                <TableHead className="w-10"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {qaPage.paged.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-muted-foreground text-center"
                  >
                    Không có mục khớp bộ lọc.
                  </TableCell>
                </TableRow>
              ) : (
                qaPage.paged.map((issue, index) => (
                  <TableRow
                    key={`${issue.severity}:${issue.rule}:${issue.sourceHash ?? index}`}
                  >
                    <TableCell>
                      <Badge
                        variant={
                          issue.severity === "error" ? "destructive" : "outline"
                        }
                      >
                        {issue.severity === "error" ? "Lỗi" : "Cảnh báo"}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="max-w-0 truncate"
                      title={qaRuleLabel(issue.rule)}
                    >
                      {qaRuleLabel(issue.rule)}
                    </TableCell>
                    <TableCell className="max-w-0 truncate" title={issue.detail}>
                      {issue.detail}
                    </TableCell>
                    <TableCell
                      className="max-w-0 truncate"
                      title={issue.source}
                    >
                      {issue.source ?? "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <RevealInTableButton
                        source={issue.source}
                        sourceHash={issue.sourceHash}
                        onReveal={onReveal}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <TablePaginator
          page={qaPage.page}
          totalPages={qaPage.totalPages}
          totalItems={filtered.length}
          pageSize={qaPage.pageSize}
          pageSizeOptions={SYNC_TABLE_PAGE_SIZE_OPTIONS}
          onPageChange={qaPage.setPage}
          onPageSizeChange={qaPage.changePageSize}
          showFirstLast={false}
        />
        </div>
      </TabsContent>
      ) : (
      <TabsContent value="changes">
        <div className="flex flex-col gap-2">
        <div className="rounded-lg border">
          <Table
            className="table-fixed text-xs"
            containerClassName="max-h-72 overflow-auto"
          >
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Loại</TableHead>
                <TableHead>Nguồn</TableHead>
                <TableHead>Trước</TableHead>
                <TableHead>Sau</TableHead>
                <TableHead className="w-10"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changePage.paged.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-muted-foreground text-center"
                  >
                    Không có thay đổi dự kiến.
                  </TableCell>
                </TableRow>
              ) : (
                changePage.paged.map((change) => (
                  <TableRow
                    key={`${change.kind}:${change.sourceHash}:${change.line ?? "new"}`}
                  >
                    <TableCell>
                      <Badge variant="secondary">
                        {CHANGE_KIND_LABELS[change.kind]}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-0 truncate" title={change.source}>
                      {change.source}
                    </TableCell>
                    <TableCell
                      className="max-w-0 truncate"
                      title={change.before ?? undefined}
                    >
                      {change.before ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-0 truncate" title={change.after}>
                      {change.after}
                    </TableCell>
                    <TableCell className="text-center">
                      <RevealInTableButton
                        source={change.source}
                        sourceHash={change.sourceHash}
                        onReveal={onReveal}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <TablePaginator
          page={changePage.page}
          totalPages={changePage.totalPages}
          totalItems={changes.length}
          pageSize={changePage.pageSize}
          pageSizeOptions={SYNC_TABLE_PAGE_SIZE_OPTIONS}
          onPageChange={changePage.setPage}
          onPageSizeChange={changePage.changePageSize}
          showFirstLast={false}
        />
        </div>
      </TabsContent>
      )}
    </Tabs>
  );
}

function TranslateProgressAlert({
  jobId,
  onCancel,
}: {
  jobId: string | null;
  onCancel: () => void;
}) {
  const progress = useLegendJsonProgress();
  return (
    <Alert>
      <RefreshCwIcon className="animate-spin" />
      <AlertTitle>Đang dịch</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <Progress
          value={
            progress?.total
              ? (progress.processed / progress.total) * 100
              : undefined
          }
        />
        <div className="flex items-center justify-between gap-2">
          <span>
            {progress?.total
              ? `${progress.processed}/${progress.total}`
              : "Đang chuẩn bị batch…"}
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={onCancel}
            disabled={!jobId}
          >
            <SquareIcon data-icon="inline-start" /> Hủy
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export const LegendJsonPipelinePage = memo(function LegendJsonPipelinePage({
  legendJson,
  locked = false,
}: {
  legendJson: UseLegendJsonPipelineReturn;
  locked?: boolean;
}) {
  const {
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
  } = legendJson;

  const [searchDraft, setSearchDraft] = useState(search);
  const [detail, setDetail] = useState<LegendJsonEntryDetail | null>(null);
  const [manualTarget, setManualTarget] = useState("");
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applySkipErrors, setApplySkipErrors] = useState(false);
  const [estimate, setEstimate] = useState<LegendJsonEstimate | null>(null);
  const [forceRestoreId, setForceRestoreId] = useState<string | null>(null);
  const [highlightedSourceHash, setHighlightedSourceHash] = useState<
    string | null
  >(null);
  const detectedTextRef = useRef<HTMLDivElement>(null);
  const actionsLocked = locked || busy !== null;
  const tableLocked = locked || isJobActive;
  const applySkipSummary = preview ? legendJsonApplySkipSummary(preview) : null;

  useEffect(() => {
    if (!highlightedSourceHash) return;
    const row = detectedTextRef.current?.querySelector(
      `[data-source-hash="${CSS.escape(highlightedSourceHash)}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [data, highlightedSourceHash]);

  const revealInDetectedTable = (source: string, sourceHash?: string) => {
    setSearchDraft(source);
    setHighlightedSourceHash(sourceHash ?? null);
    revealEntry(source);
    if (typeof detectedTextRef.current?.scrollIntoView === "function") {
      detectedTextRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  };

  const requestEstimate = async () => {
    const result = await handleEstimate();
    if (result) setEstimate(result);
  };

  const openDetail = async (entry: LegendJsonEntry) => {
    if (tableLocked) return;
    const result = await loadDetail(entry);
    if (!result) return;
    setDetail(result);
    setManualTarget(result.entry.target ?? "");
  };

  const requestRestore = async (backupId: string, force = false) => {
    const result = await handleRestore(backupId, force);
    if (result.needsForce) setForceRestoreId(backupId);
  };

  const saveEntry = async (payload: Record<string, unknown>) => {
    const ok = await updateEntry(payload);
    if (!ok) return;
    if (!detail) return;
    const next = await loadDetail(detail.entry);
    if (!next) return;
    setDetail(next);
    setManualTarget(next.entry.target ?? "");
  };

  return (
    <main className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            Legend JSON Pipeline
          </h1>
          <p className="text-muted-foreground text-sm">
            Quét JSON chỉ đọc, dịch incremental và merge an toàn vào file XUnity
            chính.
          </p>
        </div>
        <Badge variant="outline" className="w-fit gap-1.5">
          <DatabaseIcon /> SQLite incremental
        </Badge>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Nguồn và đích triển khai</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-3">
          <PathField
            id="legend-json-root"
            label="Thư mục JSON"
            value={paths.sourceRoot}
            directory
            disabled={actionsLocked}
            onChange={(value) => updatePath("sourceRoot", value)}
          />
          <PathField
            id="legend-json-main"
            label="File chính (không dấu _)"
            value={paths.mainPath}
            disabled={actionsLocked}
            onChange={(value) => updatePath("mainPath", value)}
          />
          <PathField
            id="legend-json-runtime"
            label="Runtime cache (chỉ đọc)"
            value={paths.runtimePath}
            disabled={actionsLocked}
            onChange={(value) => updatePath("runtimePath", value)}
          />
          <div className="flex flex-wrap items-center gap-2 xl:col-span-3">
            <Button onClick={() => void handleScan()} disabled={actionsLocked}>
              <RefreshCwIcon
                className={busy === "scan" ? "animate-spin" : ""}
                data-icon="inline-start"
              />{" "}
              Quét incremental
            </Button>
            {scan ? (
              <p className="text-muted-foreground text-sm">
                {scan.parsedFiles} file đã parse · {scan.reusedFiles} file tái
                sử dụng · {scan.stats.total.toLocaleString("vi-VN")} source
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Alert>
        <DatabaseIcon />
        <AlertTitle>Bản dịch được lưu ở đâu?</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <p>
            Target đã dịch được lưu trong SQLite incremental của ứng dụng và xem
            được ở trạng thái <strong>Đã dịch</strong>. JSON game không bị sửa;
            chỉ sau Preview + Apply target mới được merge vào file chính:{" "}
            {paths.mainPath || "chưa chọn file chính"}.
          </p>
          {(data?.stats.Translated ?? 0) > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={tableLocked}
              onClick={() => changeStatusFilter("Translated")}
            >
              Xem {data?.stats.Translated.toLocaleString("vi-VN")} mục đã dịch
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>

      <div ref={detectedTextRef} id="legend-json-detected-text">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle>Text đã phát hiện</CardTitle>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={status}
                onValueChange={(value) =>
                  changeStatusFilter(value as LegendJsonStatus)
                }
                disabled={tableLocked}
              >
                <SelectTrigger
                  className="w-full sm:w-48"
                  aria-label="Lọc theo trạng thái"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {STATUS_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  applySearch(searchDraft.trim());
                }}
              >
                <Input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="Tìm source hoặc target…"
                  aria-label="Tìm text Legend JSON"
                  disabled={tableLocked}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  aria-label="Tìm kiếm"
                  disabled={tableLocked}
                >
                  <SearchIcon data-icon="inline-start" />
                </Button>
              </form>
            </div>
          </div>
          {data ? (
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.filter((item) => item !== "All").map((item) => (
                <Badge
                  key={item}
                  variant={statusVariant(item as LegendJsonEntry["status"])}
                >
                  {STATUS_LABELS[item]}:{" "}
                  {data.stats[item].toLocaleString("vi-VN")}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                id="legend-json-select-all"
                checked={selectAllMatching}
                disabled={tableLocked}
                onCheckedChange={(checked) => {
                  setSelectAllMatching(checked === true);
                  setSelected(new Set());
                }}
              />
              Chọn toàn bộ theo bộ lọc
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void requestEstimate()}
                disabled={
                  !ready ||
                  actionsLocked ||
                  (!selectAllMatching && selected.size === 0)
                }
              >
                Ước tính
              </Button>
              <Button
                onClick={() => void handlePreview()}
                variant="outline"
                disabled={!ready || actionsLocked}
              >
                <ShieldAlertIcon data-icon="inline-start" /> Preview + QA
              </Button>
              <Button
                onClick={() => void requestEstimate()}
                disabled={
                  !ready ||
                  actionsLocked ||
                  (!selectAllMatching && selected.size === 0)
                }
              >
                <PlayIcon data-icon="inline-start" /> Dịch{" "}
                {status === "All" ? "New" : STATUS_LABELS[status]}
              </Button>
            </div>
          </div>

          {isJobActive ? (
            <TranslateProgressAlert
              jobId={jobId}
              onCancel={() => void cancelTranslation()}
            />
          ) : null}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        selectAllMatching || currentPageSelected
                          ? true
                          : currentPagePartiallySelected
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) =>
                        changePageSelection(checked === true)
                      }
                      disabled={tableLocked}
                      aria-label="Chọn trang hiện tại"
                    />
                  </TableHead>
                  <TableHead className="min-w-72 text-left">Source</TableHead>
                  <TableHead className="min-w-72 text-left">Target</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-left">File / field</TableHead>
                  <TableHead>Nguồn dịch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((entry) => (
                  <TableRow
                    key={entry.sourceHash}
                    data-source-hash={entry.sourceHash}
                    data-state={
                      highlightedSourceHash === entry.sourceHash
                        ? "selected"
                        : undefined
                    }
                    className={tableLocked ? undefined : "cursor-pointer"}
                    tabIndex={tableLocked ? -1 : 0}
                    onClick={() => void openDetail(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void openDetail(entry);
                    }}
                  >
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={
                          selectAllMatching || selected.has(entry.sourceHash)
                        }
                        disabled={tableLocked}
                        onCheckedChange={(checked) =>
                          changeRowSelection(entry.sourceHash, checked === true)
                        }
                        aria-label={`Chọn ${entry.source}`}
                      />
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      <p className="line-clamp-3">{entry.source}</p>
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal text-muted-foreground">
                      <p className="line-clamp-3">{entry.target || "—"}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(entry.status)}>
                        {STATUS_LABELS[entry.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-56 truncate">
                        {entry.file || "—"}
                      </div>
                      <div className="text-muted-foreground">
                        {entry.field || "—"} · {entry.occurrenceCount}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {entry.translationSource || "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {!data?.items.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-28 text-center text-muted-foreground"
                    >
                      {ready
                        ? "Không có text khớp bộ lọc."
                        : "Chạy Scan để tạo inventory."}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <TablePaginator
            page={page}
            totalPages={totalPages}
            totalItems={data?.total ?? 0}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={changePageSize}
            disabled={tableLocked}
          />
        </CardContent>
      </Card>
      </div>

      {preview ? (
        <div className="flex flex-col gap-3">
        <Alert variant={preview.qa.blocking ? "destructive" : "default"}>
          {preview.qa.blocking ? <ShieldAlertIcon /> : <CheckCircle2Icon />}
          <AlertTitle>
            {preview.qa.blocking
              ? "QA đang chặn Apply"
              : "Preview sẵn sàng Apply"}
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-3">
              <p>
                {preview.changeCount.toLocaleString("vi-VN")} thay đổi ·{" "}
                {preview.qa.errors} lỗi · {preview.qa.warnings} cảnh báo.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setApplySkipErrors(false);
                    setApplyDialogOpen(true);
                  }}
                  disabled={preview.qa.blocking || actionsLocked}
                >
                  Apply có backup
                </Button>
                {applySkipSummary?.canSkipApply ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setApplySkipErrors(true);
                      setApplyDialogOpen(true);
                    }}
                    disabled={actionsLocked}
                  >
                    Apply dòng OK
                  </Button>
                ) : null}
              </div>
            </div>
          </AlertDescription>
        </Alert>
        {preview.qa.issues.length > 0 || preview.changes.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Chi tiết QA</CardTitle>
            </CardHeader>
            <CardContent>
              <PreviewReviewPanel
                key={preview.previewId}
                issues={preview.qa.issues}
                blocking={preview.qa.blocking}
                changes={preview.changes}
                onReveal={revealInDetectedTable}
              />
            </CardContent>
          </Card>
        ) : null}
        </div>
      ) : null}

      {backups.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Backup Apply</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Backup file chính sau mỗi lần Apply. Restore không phụ thuộc Preview
              đang mở.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={actionsLocked || !backups[0]?.valid}
                onClick={() => void requestRestore(backups[0].id)}
              >
                <RotateCcwIcon data-icon="inline-start" /> Restore backup mới nhất
              </Button>
              <span className="text-muted-foreground text-sm">
                {formatDateTime(backups[0].createdAt)} ·{" "}
                {displayWindowsPath(backups[0].outputPath)}
              </span>
            </div>
            <ul className="flex max-h-40 flex-col gap-2 overflow-y-auto text-sm">
              {backups.slice(0, 8).map((backup) => (
                <li
                  key={backup.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{backup.id}</p>
                    <p className="text-muted-foreground truncate">
                      {formatDateTime(backup.createdAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actionsLocked || !backup.valid}
                    onClick={() => void requestRestore(backup.id)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <LegendJobConsole events={events} onClear={clearEvents} />

      <Sheet
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Chi tiết source</SheetTitle>
            <SheetDescription>
              {detail?.entry.occurrenceCount ?? 0} occurrence dùng chung một
              target XUnity.
            </SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="flex flex-col gap-5 px-4">
              <div>
                <p className="text-muted-foreground text-xs">SOURCE</p>
                <p className="mt-1 whitespace-pre-wrap">
                  {detail.entry.source}
                </p>
              </div>
              <Field>
                <FieldLabel htmlFor="legend-json-target">Target</FieldLabel>
                <Textarea
                  id="legend-json-target"
                  value={manualTarget}
                  onChange={(event) => setManualTarget(event.target.value)}
                  rows={5}
                  disabled={actionsLocked}
                />
                <FieldDescription>
                  Lưu thủ công sẽ được ưu tiên và đánh dấu cập nhật rõ ràng khi
                  merge.
                </FieldDescription>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void saveEntry({
                      sourceHash: detail.entry.sourceHash,
                      target: manualTarget,
                      accepted: true,
                    })
                  }
                  disabled={!manualTarget.trim() || actionsLocked}
                >
                  Lưu & chấp nhận
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void saveEntry({
                      sourceHash: detail.entry.sourceHash,
                      action: "allow",
                    })
                  }
                  disabled={actionsLocked}
                >
                  Cho phép text này
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void saveEntry({
                      sourceHash: detail.entry.sourceHash,
                      action: "exclude",
                    })
                  }
                  disabled={actionsLocked}
                >
                  Loại text này
                </Button>
              </div>
              <div className="flex flex-col gap-3">
                <h3 className="font-medium">Occurrences</h3>
                {detail.occurrences.map((occurrence) => (
                  <div
                    key={`${occurrence.file}:${occurrence.pointer}`}
                    className="rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs">
                        {occurrence.file}
                        {occurrence.pointer}
                      </code>
                      <Badge variant="outline">
                        {occurrence.classification}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-2 text-xs">
                      Field: {occurrence.field} · Record:{" "}
                      {occurrence.recordId || "—"} · {occurrence.extractor}
                    </p>
                    {occurrence.context !== detail.entry.source ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm">
                        {occurrence.context}
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          void saveEntry({
                            filePattern: occurrence.file
                              .split(/[\\/]/)
                              .slice(-1)[0],
                            field: occurrence.field,
                            action: "allow",
                          })
                        }
                        disabled={actionsLocked}
                      >
                        Allow field
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          void saveEntry({
                            filePattern: occurrence.file
                              .split(/[\\/]/)
                              .slice(-1)[0],
                            field: occurrence.field,
                            action: "exclude",
                          })
                        }
                        disabled={actionsLocked}
                      >
                        Exclude field
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <SheetFooter />
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={estimate !== null}
        onOpenChange={(open) => {
          if (!open) setEstimate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận dịch hàng loạt</AlertDialogTitle>
            <AlertDialogDescription>
              {estimate
                ? `${estimate.items.toLocaleString("vi-VN")} text · khoảng ${estimate.estimatedTokens.toLocaleString("vi-VN")} token · ${estimate.estimatedApiCalls} API call. ${estimate.estimatedCostUsd == null ? "Chưa có bảng giá cho model đang chọn." : `Ước tính $${estimate.estimatedCostUsd.toFixed(6)} theo ${estimate.pricingModel ?? "model đang chọn"}.`}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setEstimate(null);
                void handleTranslate();
              }}
            >
              Bắt đầu dịch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={applyDialogOpen} onOpenChange={setApplyDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {applySkipErrors ? "Apply dòng OK?" : "Apply vào file chính?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {applySkipErrors ? (
                <>
                  Sẽ ghi {applySkipSummary?.cleanChangeCount.toLocaleString("vi-VN")}{" "}
                  dòng sạch, bỏ qua {applySkipSummary?.errorHashCount.toLocaleString("vi-VN")}{" "}
                  dòng lỗi. Dòng lỗi vẫn giữ trong SQLite, không merge lần này. Có
                  backup; file có dấu _ không bị sửa.
                </>
              ) : (
                <>
                  Pipeline sẽ chạy lại QA, kiểm tra fingerprint JSON/file chính, tạo
                  backup rồi atomic replace. File có dấu _ không bị sửa.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setApplyDialogOpen(false);
                void handleApply(applySkipErrors);
              }}
            >
              {applySkipErrors ? "Backup & Apply dòng OK" : "Backup & Apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={forceRestoreId !== null}
        onOpenChange={(open) => {
          if (!open) setForceRestoreId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>File chính đã đổi sau Apply</AlertDialogTitle>
            <AlertDialogDescription>
              File hiện tại không còn khớp fingerprint lúc Apply. Restore vẫn
              tạo ghi đè từ backup nếu bạn xác nhận.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Giữ file hiện tại</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const backupId = forceRestoreId;
                setForceRestoreId(null);
                if (backupId) void requestRestore(backupId, true);
              }}
            >
              Force restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
});
