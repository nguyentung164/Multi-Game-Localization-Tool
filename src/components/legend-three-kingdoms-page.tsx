import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyMinusIcon,
  FileCheck2Icon,
  FileDiffIcon,
  FileSearchIcon,
  FolderOpenIcon,
  HistoryIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
  UploadIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ApiManagerDialog } from "@/components/api-manager-dialog";
import { AsyncLoadingOverlay } from "@/components/async-loading-overlay";
import { resolvePageLoadingState } from "@/hooks/use-async-task";
import { LegendJobConsole } from "@/components/legend-job-console";
import {
  Metric,
  PageHeader,
  formatNumber,
  pageContainerClass,
} from "@/components/product-ui";
import {
  DEFAULT_TABLE_PAGE_SIZE_OPTIONS,
  TablePaginator,
} from "@/components/table-paginator";
import { PresenceAlert } from "@/components/presence-fade";
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
import { Button } from "@/components/ui/button";
import { actionBtn } from "@/lib/action-button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AppView } from "@/lib/app-types";
import type { AppController } from "@/hooks/use-app-controller";
import {
  estimateLegendTranslation,
  legendEstimateActionableItems,
  legendEstimateSummary,
  legendForceTranslateButtonLabel,
  legendInspectEstimateTitle,
  legendTranslateButtonLabel,
  type LegendTranslationController,
} from "@/hooks/use-legend-translation";
import {
  EMPTY_LEGEND_SELECTION_MASK,
  applyLegendSuggestion,
  applyLegendTermSuggestions,
  collectLegendPreviewEdits,
  collectLegendTermSuggestions,
  hasPendingLegendTextEdits,
  isLegendPreviewEditDirty,
  isLegendSelectionMaskEmpty,
  legendDiffDraftText,
  legendPreviewSessionKey,
  legendSelectedCount,
  legendSelectedLineNumbers,
  legendSelectedSuggestionStats,
  legendTermSuggestionApplies,
  mergeLegendPreviewEdits,
  overlayLegendDiff,
  pushLegendSelection,
  resolveLegendSelected,
  setLegendRowSelected,
  unsavedLegendTextLines,
} from "@/lib/legend-preview-edits";
import { legendDiffsWithHan } from "@/lib/legend-han";
import type {
  LegendFileEntry,
  LegendPreviewEdit,
  LegendPreviewLineRef,
  LegendQaIssue,
  LegendTermSuggestion,
  LegendTranslationDiff,
  LegendTranslationEstimate,
} from "@/lib/legend-types";
import { qaRuleLabel } from "@/lib/qa-labels";
import { displayWindowsPath } from "@/lib/path-utils";
import { ipc } from "@/lib/tauri-ipc";
import { cn } from "@/lib/utils";

const PREVIEW_PAGE_SIZE_OPTIONS = DEFAULT_TABLE_PAGE_SIZE_OPTIONS;
const INSPECTION_PAGE_SIZE_OPTIONS = DEFAULT_TABLE_PAGE_SIZE_OPTIONS;
type PreviewPageSize = (typeof PREVIEW_PAGE_SIZE_OPTIONS)[number];
type InspectionPageSize = (typeof INSPECTION_PAGE_SIZE_OPTIONS)[number];
const INSPECT_TEXT_CELL = "min-w-0 whitespace-normal break-all align-top";
type DiffFilter = "all" | "han" | "error" | "warning";
const PREVIEW_TEXT_CELL = "min-w-0 whitespace-pre-wrap break-all align-top";
const PREVIEW_ACTION_CELL =
  "w-12 p-1.5 text-center align-middle [&:has([role=checkbox])]:pr-1.5";
const PREVIEW_LINE_CELL = "w-16 p-1.5 text-center align-middle tabular-nums";
const PREVIEW_QA_RULE_CELL =
  "w-[11rem] min-w-0 align-top whitespace-normal break-words";
const PREVIEW_QA_DETAIL_CELL = `${PREVIEW_TEXT_CELL} text-sm`;
const PREVIEW_TABLE_COLUMNS = 7;
const QA_LINE_TONE_CLASS = {
  error: "bg-destructive/10 text-destructive hover:bg-destructive/15",
  warning: "bg-warning/10 text-warning hover:bg-warning/15",
} as const;
type QaLineTone = keyof typeof QA_LINE_TONE_CLASS;

function parseLineNumberFilter(raw: string): Set<number> | null {
  const text = raw.trim().replace(/^dòng\s+/i, "");
  if (!text) return null;
  const wanted = new Set<number>();
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const normalized = token.replace(/^dòng/i, "");
    if (!normalized) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(normalized);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (hi - lo > 20_000) continue;
      for (let line = lo; line <= hi; line += 1) wanted.add(line);
      continue;
    }
    if (/^\d+$/.test(normalized)) wanted.add(Number(normalized));
  }
  return wanted.size > 0 ? wanted : null;
}

function filterLegendPreviewRows(
  source: LegendTranslationDiff[],
  filter: DiffFilter,
  lineFilter: string,
  issues: LegendQaIssue[],
): LegendTranslationDiff[] {
  const lineNumbers = parseLineNumberFilter(lineFilter);
  const scoped =
    filter === "han"
      ? legendDiffsWithHan(source)
      : filter === "error"
        ? source.filter((diff) =>
            issues.some(
              (issue) =>
                issue.lineNumber === diff.lineNumber &&
                issue.severity === "error",
            ),
          )
        : filter === "warning"
          ? source.filter((diff) => {
              const lineIssues = issues.filter(
                (issue) => issue.lineNumber === diff.lineNumber,
              );
              return (
                lineIssues.some((issue) => issue.severity === "warning") &&
                !lineIssues.some((issue) => issue.severity === "error")
              );
            })
          : source;
  return lineNumbers === null
    ? scoped
    : scoped.filter((diff) => lineNumbers.has(diff.lineNumber));
}

function legendPreviewLineRefsFromDiffs(
  diffs: LegendTranslationDiff[],
  issues: LegendQaIssue[],
): LegendPreviewLineRef[] {
  const errorLines = new Set(
    issues
      .filter((issue) => issue.severity === "error" && issue.lineNumber)
      .map((issue) => issue.lineNumber),
  );
  return diffs.map((diff) => ({
    lineNumber: diff.lineNumber,
    selected: diff.selected,
    error: errorLines.has(diff.lineNumber),
  }));
}

function displayLegendPath(path: string): string {
  return displayWindowsPath(path);
}

function LegendQaIssueCells({
  issues,
  stale,
  applyEnabled,
  currentText,
  onApplySuggestion,
  onApplyAllSuggestions,
}: {
  issues: LegendQaIssue[];
  stale?: boolean;
  applyEnabled?: boolean;
  currentText?: string;
  onApplySuggestion?: (suggestion: LegendTermSuggestion) => void;
  onApplyAllSuggestions?: () => void;
}) {
  const draft = currentText ?? "";
  const collected = collectLegendTermSuggestions(issues);
  const canApplyAll =
    Boolean(onApplyAllSuggestions) &&
    applyLegendTermSuggestions(draft, collected).applied.length > 0;

  function renderSuggestionButtons(
    suggestions: LegendTermSuggestion[],
    keyPrefix: string,
    onlyApplyable: boolean,
  ) {
    const visible = onlyApplyable
      ? suggestions.filter((suggestion) =>
          legendTermSuggestionApplies(draft, suggestion),
        )
      : suggestions;
    if (visible.length === 0) return null;
    return (
      <span className="flex flex-wrap gap-1">
        {visible.map((suggestion) => {
          const canReplace = legendTermSuggestionApplies(draft, suggestion);
          const search = suggestion.replace || suggestion.source;
          return (
            <Button
              key={`${keyPrefix}-${suggestion.source}-${suggestion.reading}-${suggestion.replace ?? ""}`}
              type="button"
              size="sm"
              variant="outline"
              disabled={!applyEnabled || !onApplySuggestion || !canReplace}
              title={
                canReplace
                  ? `Thay ${search} thành ${suggestion.reading} trong ô Sau`
                  : `Đề xuất: ${suggestion.reading}. Ô Sau không có ${search} — sửa tay.`
              }
              onClick={() => onApplySuggestion?.(suggestion)}
            >
              {suggestion.source} → {suggestion.reading}
            </Button>
          );
        })}
      </span>
    );
  }

  const applyAllButton = canApplyAll ? (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="mt-1.5"
      disabled={!applyEnabled || !onApplyAllSuggestions}
      title="Áp dụng mọi đề xuất còn thay được trong ô Sau"
      onClick={() => onApplyAllSuggestions?.()}
    >
      Áp dụng đề xuất
    </Button>
  ) : null;

  if (stale) {
    return (
      <>
        <TableCell className={PREVIEW_QA_RULE_CELL}>
          <Badge variant="outline">QA chưa chạy lại</Badge>
        </TableCell>
        <TableCell
          className={`${PREVIEW_QA_DETAIL_CELL} text-muted-foreground`}
        >
          <div className="flex flex-col gap-1.5">
            <span>Lưu file để kiểm tra bản vừa sửa.</span>
            {renderSuggestionButtons(collected, "stale", true)}
            {applyAllButton}
          </div>
        </TableCell>
      </>
    );
  }
  if (issues.length === 0) {
    return (
      <>
        <TableCell className={`${PREVIEW_QA_RULE_CELL} text-muted-foreground`}>
          —
        </TableCell>
        <TableCell
          className={`${PREVIEW_QA_DETAIL_CELL} text-muted-foreground`}
        >
          —
        </TableCell>
      </>
    );
  }
  return (
    <>
      <TableCell className={PREVIEW_QA_RULE_CELL}>
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li key={issue.id}>
              <Badge
                variant={
                  issue.severity === "error" ? "destructive" : "secondary"
                }
              >
                {qaRuleLabel(issue.rule)}
              </Badge>
            </li>
          ))}
        </ul>
      </TableCell>
      <TableCell className={PREVIEW_QA_DETAIL_CELL}>
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue) => (
            <li key={issue.id} className="flex flex-col gap-1">
              <span>{issue.detail}</span>
              {renderSuggestionButtons(
                issue.suggestions ?? [],
                issue.id,
                false,
              )}
            </li>
          ))}
        </ul>
        {applyAllButton}
      </TableCell>
    </>
  );
}

function LegendRetranslateCell({
  lineNumber,
  enabled,
  busy,
  disabledReason,
  onRetranslate,
}: {
  lineNumber: number;
  enabled: boolean;
  busy: boolean;
  disabledReason?: string;
  onRetranslate: (lineNumber: number) => void;
}) {
  return (
    <TableCell className={PREVIEW_ACTION_CELL}>
      <div className="flex items-center justify-center">
        <Button
          type="button"
          size="icon"
          variant={actionBtn.retranslate}
          disabled={!enabled || busy}
          title={
            busy
              ? "Đang dịch dòng này…"
              : (disabledReason ?? "Dịch lại dòng này (bỏ cache)")
          }
          aria-label={`Dịch lại dòng ${lineNumber}`}
          onClick={() => onRetranslate(lineNumber)}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
        </Button>
      </div>
    </TableCell>
  );
}

function LegendDiffEditorRow({
  diff,
  editable,
  qaTone,
  qaIssues,
  qaStale,
  retranslateEnabled,
  retranslateBusy,
  retranslateDisabledReason,
  onChange,
  onSelect,
  onRetranslate,
}: {
  diff: LegendTranslationDiff;
  editable: boolean;
  qaTone?: QaLineTone;
  qaIssues: LegendQaIssue[];
  qaStale?: boolean;
  retranslateEnabled: boolean;
  retranslateBusy: boolean;
  retranslateDisabledReason?: string;
  onChange: (edit: LegendPreviewEdit) => void;
  onSelect: (lineNumber: number, selected: boolean) => void;
  onRetranslate: (lineNumber: number) => void;
}) {
  const draft = legendDiffDraftText(diff);

  return (
    <TableRow
      id={`legend-diff-${diff.lineNumber}`}
      className={qaTone ? QA_LINE_TONE_CLASS[qaTone] : undefined}
    >
      <TableCell className={PREVIEW_ACTION_CELL}>
        <div className="flex items-center justify-center">
          <Checkbox
            checked={diff.selected}
            disabled={!editable}
            aria-label={`Chọn dòng ${diff.lineNumber}`}
            onCheckedChange={(checked) =>
              onSelect(diff.lineNumber, checked === true)
            }
          />
        </div>
      </TableCell>
      <TableCell className={PREVIEW_LINE_CELL}>{diff.lineNumber}</TableCell>
      <TableCell className={PREVIEW_TEXT_CELL}>{diff.source}</TableCell>
      <TableCell
        className={cn(
          PREVIEW_TEXT_CELL,
          "font-medium",
          qaTone === "error" && "text-destructive",
          qaTone === "warning" && "text-warning",
        )}
      >
        <Textarea
          value={draft}
          disabled={!diff.selected || !editable}
          className={cn(
            qaTone === "error" && "text-destructive",
            qaTone === "warning" && "text-warning",
          )}
          aria-label={`Bản dịch dòng ${diff.lineNumber}`}
          onChange={(event) => {
            const next = event.target.value;
            onChange({
              lineNumber: diff.lineNumber,
              selected: diff.selected,
              editedAfter: next === diff.after ? undefined : next,
            });
          }}
        />
      </TableCell>
      <LegendQaIssueCells
        issues={qaIssues}
        stale={qaStale}
        applyEnabled={editable && diff.selected}
        currentText={draft}
        onApplySuggestion={(suggestion) => {
          const next = applyLegendSuggestion(draft, suggestion);
          if (next === draft) {
            const search = suggestion.replace || suggestion.source;
            toast.message(
              `Đề xuất dịch thành ${suggestion.reading}. Ô Sau không có ${search} — sửa tay.`,
            );
            return;
          }
          onChange({
            lineNumber: diff.lineNumber,
            selected: diff.selected,
            editedAfter: next === diff.after ? undefined : next,
          });
        }}
        onApplyAllSuggestions={() => {
          const next = applyLegendTermSuggestions(
            draft,
            collectLegendTermSuggestions(qaIssues),
          );
          if (next.text === draft) {
            toast.message("Không có đề xuất nào thay được trong ô Sau.");
            return;
          }
          onChange({
            lineNumber: diff.lineNumber,
            selected: diff.selected,
            editedAfter: next.text === diff.after ? undefined : next.text,
          });
        }}
      />
      <LegendRetranslateCell
        lineNumber={diff.lineNumber}
        enabled={retranslateEnabled}
        busy={retranslateBusy}
        disabledReason={retranslateDisabledReason}
        onRetranslate={onRetranslate}
      />
    </TableRow>
  );
}

export function LegendThreeKingdomsPage({
  controller,
  legend,
  onNavigate,
}: {
  controller: AppController;
  legend: LegendTranslationController;
  onNavigate: (view: AppView) => void;
}) {
  const [apiOpen, setApiOpen] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [dedupeConfirm, setDedupeConfirm] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);
  const [forceEstimate, setForceEstimate] =
    useState<LegendTranslationEstimate | null>(null);
  const [page, setPage] = useState(1);
  const [previewPageSize, setPreviewPageSize] = useState<PreviewPageSize>(25);
  const [retranslatingLine, setRetranslatingLine] = useState<number | null>(
    null,
  );
  const [inspectPage, setInspectPage] = useState(1);
  const [inspectPageSize, setInspectPageSize] =
    useState<InspectionPageSize>(50);
  const [previewRows, setPreviewRows] = useState<LegendTranslationDiff[]>([]);
  const [previewPageTotal, setPreviewPageTotal] = useState(0);
  const [previewPageIssues, setPreviewPageIssues] = useState<LegendQaIssue[]>(
    [],
  );
  const [previewRowsLoading, setPreviewRowsLoading] = useState(false);
  const [previewRowsReadyQuery, setPreviewRowsReadyQuery] = useState("");
  const [filterLineRefs, setFilterLineRefs] = useState<LegendPreviewLineRef[]>(
    [],
  );
  const [filterLineRefsKey, setFilterLineRefsKey] = useState("");
  const [inspectRows, setInspectRows] = useState<LegendFileEntry[]>([]);
  const [inspectTotal, setInspectTotal] = useState<number | null>(null);
  const [inspectEntryTotal, setInspectEntryTotal] = useState<number | null>(
    null,
  );
  const [inspectInvalidTotal, setInspectInvalidTotal] = useState<number | null>(
    null,
  );
  const [inspectDuplicateTotal, setInspectDuplicateTotal] = useState<
    number | null
  >(null);
  const [inspectWarningReasons, setInspectWarningReasons] = useState<string[]>(
    [],
  );
  const [inspectRowsLoading, setInspectRowsLoading] = useState(false);
  const [inspectFilter, setInspectFilter] = useState<
    "entry" | "invalid" | "duplicate"
  >("entry");
  const [estimateResult, setEstimateResult] = useState<{
    key: string;
    value: LegendTranslationEstimate | null;
    failed: boolean;
  }>({ key: "", value: null, failed: false });
  const [estimateFetching, setEstimateFetching] = useState(false);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [pendingEdits, setPendingEdits] = useState<
    Record<number, LegendPreviewEdit>
  >({});
  const [selectionMask, setSelectionMask] = useState(
    EMPTY_LEGEND_SELECTION_MASK,
  );
  const [diffFilter, setDiffFilter] = useState<DiffFilter>("all");
  const [lineFilter, setLineFilter] = useState("");
  const previewSessionRef = useRef("");
  const previewRevisionRef = useRef("");
  const filterLineRefsKeyRef = useRef("");
  const autoLoadPreviewRef = useRef(false);
  const runEstimateRef = useRef(legend.runEstimate);
  const estimateCacheRef = useRef(estimateResult);
  runEstimateRef.current = legend.runEstimate;
  estimateCacheRef.current = estimateResult;
  const retranslateFocusRef = useRef<number | null>(null);
  const enabledKeys = controller.state.apiKeys.filter((key) => key.enabled);
  const running =
    legend.phase === "starting" ||
    legend.phase === "running" ||
    legend.phase === "cancelling" ||
    legend.retranslating;
  const busy =
    legend.globalJobActive ||
    legend.phase === "inspecting" ||
    legend.retranslating;
  const savedDiffs = previewRows;
  const diffs = useMemo(
    () => mergeLegendPreviewEdits(savedDiffs, pendingEdits),
    [pendingEdits, savedDiffs],
  );
  const qaIssues = useMemo(
    () => [...(legend.preview?.qa.issues ?? []), ...previewPageIssues],
    [legend.preview?.qa.issues, previewPageIssues],
  );
  const qaToneByLine = useMemo(() => {
    const tones = new Map<number, QaLineTone>();
    for (const issue of qaIssues) {
      if (!issue.lineNumber) continue;
      if (issue.severity === "error") {
        tones.set(issue.lineNumber, "error");
      } else if (tones.get(issue.lineNumber) !== "error") {
        tones.set(issue.lineNumber, "warning");
      }
    }
    return tones;
  }, [qaIssues]);
  const qaIssuesByLine = useMemo(() => {
    const grouped = new Map<number, LegendQaIssue[]>();
    for (const issue of qaIssues) {
      if (!issue.lineNumber) continue;
      const list = grouped.get(issue.lineNumber);
      if (list) list.push(issue);
      else grouped.set(issue.lineNumber, [issue]);
    }
    return grouped;
  }, [qaIssues]);
  const fileLevelQaIssues = useMemo(
    () =>
      (legend.preview?.qa.issues ?? []).filter((issue) => !issue.lineNumber),
    [legend.preview?.qa.issues],
  );
  const filteredDiffs = diffs;
  const headerDiffCount = legend.preview?.diffCount ?? diffs.length;
  const headerHanCount = legend.preview?.hanCount ?? 0;
  const headerErrorCount = legend.preview?.errorCount ?? 0;
  const headerWarningCount = legend.preview?.warningCount ?? 0;
  const headerSelectedCount = legend.preview?.selectedCount ?? 0;
  const previewDirty =
    Object.keys(pendingEdits).length > 0 ||
    !isLegendSelectionMaskEmpty(selectionMask);
  const previewTextDirty = hasPendingLegendTextEdits(savedDiffs, pendingEdits);
  const unsavedTextLines = useMemo(
    () => unsavedLegendTextLines(savedDiffs, pendingEdits),
    [pendingEdits, savedDiffs],
  );
  const inspectTotalItems =
    inspectTotal ??
    (inspectFilter === "invalid"
      ? (inspectInvalidTotal ?? 0)
      : inspectFilter === "duplicate"
        ? (inspectDuplicateTotal ?? legend.inspection?.duplicateSources ?? 0)
        : (inspectEntryTotal ?? legend.inspection?.entryCount ?? 0));
  const warningCount = inspectInvalidTotal ?? 0;
  const duplicateCount =
    inspectDuplicateTotal ?? legend.inspection?.duplicateSources ?? 0;
  const warningReasons = inspectWarningReasons;
  const inspectTotalPages = Math.max(
    1,
    Math.ceil(inspectTotalItems / inspectPageSize),
  );
  const safeInspectPage = Math.min(inspectPage, inspectTotalPages);
  const totalPages = Math.max(1, Math.ceil(previewPageTotal / previewPageSize));
  const safePage = Math.min(page, totalPages);
  const visibleDiffs = filteredDiffs.map((diff) =>
    overlayLegendDiff(diff, pendingEdits[diff.lineNumber], selectionMask),
  );
  const previewRowsQuery = legend.preview
    ? `${legend.preview.previewId}:${legend.preview.revision}:${safePage}:${previewPageSize}:${diffFilter}:${lineFilter}`
    : "";
  const filterRefsQuery = legend.preview
    ? `${legend.preview.previewId}:${legend.preview.revision}:${diffFilter}:${lineFilter}`
    : "";
  const diffsTableLoading =
    Boolean(legend.preview) &&
    (previewRowsLoading || previewRowsReadyQuery !== previewRowsQuery);
  const filterRefsReady =
    !legend.preview || filterLineRefsKey === filterRefsQuery;
  const selectedCount = useMemo(
    () => legendSelectedCount(headerSelectedCount, selectionMask),
    [headerSelectedCount, selectionMask],
  );
  const selectedFilteredCount = useMemo(
    () => legendSelectedLineNumbers(filterLineRefs, selectionMask).length,
    [filterLineRefs, selectionMask],
  );
  const suggestionApplyStats = useMemo(
    () =>
      legendSelectedSuggestionStats(
        filteredDiffs,
        pendingEdits,
        selectionMask,
        qaIssuesByLine,
      ),
    [filteredDiffs, pendingEdits, qaIssuesByLine, selectionMask],
  );
  const deployConfigured = legend.deployPath.trim().length > 0;
  const previewLoading =
    legend.previewLoading ||
    (!legend.preview &&
      !legend.jobId &&
      (legend.phase === "running" || legend.phase === "starting"));
  const savingPreview =
    legend.syncOverlay.loading &&
    (legend.syncOverlay.title === "Đang lưu preview…" ||
      legend.syncOverlay.title === "Đang rebuild preview + QA…");
  const retranslateRowEnabled =
    legend.canMutatePreview &&
    !savingPreview &&
    !previewTextDirty &&
    !diffsTableLoading &&
    enabledKeys.length > 0;
  const retranslateRowReason = previewTextDirty
    ? "Lưu sửa bản dịch trước khi dịch lại"
    : diffsTableLoading
      ? "Đang tải trang diff"
      : enabledKeys.length === 0
        ? "Cần API key đang bật"
        : legend.preview?.mode !== "full"
          ? "Preview không cho phép dịch lại"
          : !legend.canMutatePreview
            ? "Preview đang bị khóa bởi một tác vụ khác"
            : undefined;
  const estimateKey = legend.inspection?.fingerprint ?? "";
  const localEstimate = legend.inspection
    ? estimateLegendTranslation(
        legend.inspection.uniqueSourceCount,
        controller.state.config.batchSize,
        enabledKeys.length,
      )
    : null;
  const fetchedEstimate =
    estimateResult.key === estimateKey ? estimateResult.value : null;
  const estimate = fetchedEstimate ?? (legend.desktop ? null : localEstimate);
  const estimateFailed =
    estimateResult.key === estimateKey &&
    estimateResult.failed &&
    !fetchedEstimate;
  const estimateLoading = estimateFetching;
  const forceEstimateLoading =
    legend.syncOverlay.loading &&
    legend.syncOverlay.title === "Đang ước lượng dịch lại…";
  const pageLoading = useMemo(
    () =>
      resolvePageLoadingState({
        syncOverlay: legend.syncOverlay,
        forceEstimateLoading,
        estimateLoading: estimateLoading && !legend.syncOverlay.loading,
        previewRowsLoading: diffsTableLoading,
        inspectRowsLoading,
        savingPreview,
      }),
    [
      diffsTableLoading,
      estimateLoading,
      forceEstimateLoading,
      inspectRowsLoading,
      legend.syncOverlay,
      savingPreview,
    ],
  );

  useEffect(() => {
    if (legend.preview || legend.isJobActive) {
      autoLoadPreviewRef.current = false;
      return;
    }
    if (!legend.desktop || autoLoadPreviewRef.current) {
      return;
    }
    autoLoadPreviewRef.current = true;
    void legend.loadPreview({ silent: true });
  }, [legend.desktop, legend.isJobActive, legend.loadPreview, legend.preview]);

  useEffect(() => {
    if (legend.preview || legend.isJobActive || !legend.desktop) return;
    void legend.refreshSavedPreviews({ silent: true });
  }, [
    legend.desktop,
    legend.isJobActive,
    legend.preview,
    legend.refreshSavedPreviews,
  ]);

  useEffect(() => {
    const session = legendPreviewSessionKey(legend.preview);
    const revision = legend.preview
      ? `${legend.preview.previewId}:${legend.preview.revision}`
      : "";
    if (session !== previewSessionRef.current) {
      previewSessionRef.current = session;
      setPage(1);
      setLineFilter("");
      setPreviewRows([]);
      setPreviewPageTotal(0);
      setPreviewPageIssues([]);
      setPreviewRowsReadyQuery("");
      setFilterLineRefs([]);
      setFilterLineRefsKey("");
      filterLineRefsKeyRef.current = "";
    }
    if (revision !== previewRevisionRef.current) {
      previewRevisionRef.current = revision;
      setPendingEdits({});
      setSelectionMask(EMPTY_LEGEND_SELECTION_MASK);
    }
  }, [legend.preview]);

  useEffect(() => {
    if (!previewTextDirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [previewTextDirty]);

  useEffect(() => {
    const preview = legend.preview;
    const pageQuery = preview
      ? `${preview.previewId}:${preview.revision}:${safePage}:${previewPageSize}:${diffFilter}:${lineFilter}`
      : "";
    const refsQuery = preview
      ? `${preview.previewId}:${preview.revision}:${diffFilter}:${lineFilter}`
      : "";
    if (!preview) {
      setPreviewRows([]);
      setPreviewPageTotal(0);
      setPreviewPageIssues([]);
      setPreviewRowsLoading(false);
      setPreviewRowsReadyQuery("");
      setFilterLineRefs([]);
      setFilterLineRefsKey("");
      filterLineRefsKeyRef.current = "";
      return;
    }
    const offset = (safePage - 1) * previewPageSize;
    if (!legend.desktop) {
      const filtered = filterLegendPreviewRows(
        preview.diffs,
        diffFilter,
        lineFilter,
        preview.qa.issues ?? [],
      );
      setPreviewPageTotal(filtered.length);
      setPreviewRows(filtered.slice(offset, offset + previewPageSize));
      setPreviewPageIssues(preview.qa.issues ?? []);
      setFilterLineRefs(
        legendPreviewLineRefsFromDiffs(filtered, preview.qa.issues ?? []),
      );
      setFilterLineRefsKey(refsQuery);
      filterLineRefsKeyRef.current = refsQuery;
      setPreviewRowsReadyQuery(pageQuery);
      setPreviewRowsLoading(false);
      return;
    }
    let active = true;
    const includeLineRefs = filterLineRefsKeyRef.current !== refsQuery;
    setPreviewRowsLoading(true);
    void ipc
      .listLegendPreviewDiffs(
        diffFilter,
        offset,
        previewPageSize,
        lineFilter.trim() || null,
        includeLineRefs,
      )
      .then((pageResult) => {
        if (!active) return;
        setPreviewRows(pageResult.entries);
        setPreviewPageTotal(pageResult.total);
        setPreviewPageIssues(pageResult.issues);
        if (includeLineRefs) {
          setFilterLineRefs(pageResult.lineRefs ?? []);
          setFilterLineRefsKey(refsQuery);
          filterLineRefsKeyRef.current = refsQuery;
        }
      })
      .catch(() => {
        if (!active) return;
        setPreviewRows([]);
        setPreviewPageTotal(0);
        setPreviewPageIssues([]);
        if (includeLineRefs) {
          setFilterLineRefs([]);
          setFilterLineRefsKey(refsQuery);
          filterLineRefsKeyRef.current = refsQuery;
        }
        toast.error("Không tải được trang diff.");
      })
      .finally(() => {
        if (active) {
          setPreviewRowsLoading(false);
          setPreviewRowsReadyQuery(pageQuery);
        }
      });
    return () => {
      active = false;
    };
  }, [
    diffFilter,
    legend.desktop,
    legend.preview,
    lineFilter,
    previewPageSize,
    safePage,
  ]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setInspectPage(1);
  }, [legend.inspection?.fingerprint, inspectPageSize, inspectFilter]);

  useEffect(() => {
    const inspection = legend.inspection;
    if (!inspection) {
      setInspectRows([]);
      setInspectTotal(null);
      setInspectEntryTotal(null);
      setInspectInvalidTotal(null);
      setInspectDuplicateTotal(null);
      setInspectWarningReasons([]);
      setInspectRowsLoading(false);
      return;
    }
    const offset = (safeInspectPage - 1) * inspectPageSize;
    if (!legend.desktop) {
      const demoRows =
        inspectFilter === "invalid" || inspectFilter === "duplicate"
          ? []
          : inspection.sample.slice(offset, offset + inspectPageSize);
      setInspectRows(demoRows);
      setInspectTotal(
        inspectFilter === "invalid" || inspectFilter === "duplicate"
          ? 0
          : inspection.sample.length,
      );
      setInspectEntryTotal(inspection.sample.length);
      setInspectInvalidTotal(0);
      setInspectDuplicateTotal(0);
      setInspectWarningReasons([]);
      setInspectRowsLoading(false);
      return;
    }
    let active = true;
    setInspectRowsLoading(true);
    void ipc
      .listLegendFileEntries(
        inspection.sourcePath,
        offset,
        inspectPageSize,
        inspectFilter,
      )
      .then((pageResult) => {
        if (!active) return;
        setInspectRows(pageResult.entries);
        setInspectTotal(pageResult.total);
        setInspectEntryTotal(pageResult.entryTotal ?? pageResult.total);
        setInspectInvalidTotal(pageResult.invalidTotal ?? 0);
        setInspectDuplicateTotal(pageResult.duplicateTotal ?? 0);
        setInspectWarningReasons(pageResult.warningReasons ?? []);
      })
      .catch(() => {
        if (!active) return;
        setInspectRows(
          inspectFilter === "entry"
            ? inspection.sample.slice(offset, offset + inspectPageSize)
            : [],
        );
        setInspectTotal(inspectFilter === "entry" ? inspection.entryCount : 0);
        setInspectEntryTotal(inspection.entryCount);
        setInspectInvalidTotal(0);
        setInspectDuplicateTotal(0);
        setInspectWarningReasons([]);
      })
      .finally(() => {
        if (active) setInspectRowsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    inspectFilter,
    inspectPageSize,
    legend.desktop,
    legend.inspection,
    safeInspectPage,
  ]);

  useEffect(() => {
    if (focusLine === null) return;
    let attempts = 0;
    let frame = 0;
    const tryFocus = () => {
      const row = document.getElementById(`legend-diff-${focusLine}`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.querySelector<HTMLElement>("textarea,button,[tabindex]")?.focus();
        setFocusLine(null);
        return;
      }
      attempts += 1;
      if (attempts > 12) {
        setFocusLine(null);
        return;
      }
      frame = window.requestAnimationFrame(tryFocus);
    };
    frame = window.requestAnimationFrame(tryFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [focusLine, page, diffFilter]);

  const jumpToLine = useCallback((lineNumber: number) => {
    setLineFilter(String(lineNumber));
    setDiffFilter("all");
    setPage(1);
    setFocusLine(lineNumber);
  }, []);

  useEffect(() => {
    const lineNumber = retranslateFocusRef.current;
    if (lineNumber === null || !legend.preview) return;
    retranslateFocusRef.current = null;
    jumpToLine(lineNumber);
  }, [jumpToLine, legend.preview]);

  function patchPreviewEdit(edit: LegendPreviewEdit) {
    const base = previewRows.find(
      (diff) => diff.lineNumber === edit.lineNumber,
    );
    setPendingEdits((current) => {
      const next = { ...current };
      if (!base || !isLegendPreviewEditDirty(base, edit)) {
        delete next[edit.lineNumber];
      } else {
        next[edit.lineNumber] = edit;
      }
      return next;
    });
  }

  function applyFilteredTermSuggestions() {
    const baseByLine = new Map(savedDiffs.map((row) => [row.lineNumber, row]));
    const nextEdits = { ...pendingEdits };
    let lines = 0;
    let replacements = 0;
    for (const diff of filteredDiffs) {
      const base = baseByLine.get(diff.lineNumber);
      if (!base) continue;
      const selected = resolveLegendSelected(base, selectionMask);
      if (!selected) continue;
      const draft = legendDiffDraftText(
        overlayLegendDiff(base, pendingEdits[diff.lineNumber], selectionMask),
      );
      const result = applyLegendTermSuggestions(
        draft,
        collectLegendTermSuggestions(qaIssuesByLine.get(diff.lineNumber) ?? []),
      );
      if (result.text === draft) continue;
      const edit = {
        lineNumber: diff.lineNumber,
        selected,
        editedAfter: result.text === base.after ? undefined : result.text,
      };
      if (!isLegendPreviewEditDirty(base, edit)) {
        delete nextEdits[diff.lineNumber];
      } else {
        nextEdits[diff.lineNumber] = edit;
      }
      lines += 1;
      replacements += result.applied.length;
    }
    if (lines === 0) {
      toast.message(
        suggestionApplyStats.selectedWithSuggestions > 0
          ? "Các dòng đang chọn có đề xuất, nhưng ô Sau không còn cụm Hán để thay. Đề xuất thiếu token/thuật ngữ phải sửa tay."
          : "Không có đề xuất nào thay được trong ô Sau của các dòng đang chọn.",
      );
      return;
    }
    setPendingEdits(nextEdits);
    toast.success(
      `Đã áp dụng ${formatNumber(replacements)} đề xuất trên ${formatNumber(lines)} dòng. Lưu file để QA chạy lại.`,
    );
  }

  function setPreviewSelection(
    selectedFor: (row: { lineNumber: number; selected: boolean }) => boolean,
    scope: Array<
      Pick<LegendTranslationDiff, "lineNumber" | "selected">
    > = filterLineRefs,
  ) {
    setSelectionMask((current) =>
      pushLegendSelection(current, scope, selectedFor),
    );
  }

  function setRowSelected(lineNumber: number, selected: boolean) {
    const original =
      previewRows.find((diff) => diff.lineNumber === lineNumber)?.selected ??
      selected;
    setSelectionMask((current) =>
      setLegendRowSelected(current, lineNumber, selected, original),
    );
  }

  async function savePreviewEdits(options?: { silent?: boolean }) {
    const edits = collectLegendPreviewEdits(
      savedDiffs,
      pendingEdits,
      selectionMask,
    );
    if (edits.length === 0) return true;
    const saved = await legend.updatePreview(edits);
    if (saved && !options?.silent) {
      toast.success(
        `Đã lưu ${formatNumber(edits.length)} thay đổi và chạy lại QA.`,
      );
    }
    return saved;
  }

  async function rebuildPreviewQa() {
    if (previewTextDirty) {
      toast.error("Lưu sửa bản dịch trước khi rebuild QA.");
      return;
    }
    const saved = await legend.rebuildPreviewQa();
    if (saved) {
      toast.success("Đã rebuild preview và chạy lại QA với glossary hiện tại.");
    }
  }

  async function refreshQa() {
    if (previewTextDirty) {
      toast.error("Lưu sửa bản dịch trước khi làm mới QA.");
      return;
    }
    const saved = await legend.rebuildPreviewQa();
    if (saved) {
      toast.success("Đã làm mới bảng lỗi và cảnh báo.");
    }
  }

  async function retranslateHanLines() {
    if (previewTextDirty) {
      toast.error("Lưu sửa bản dịch trước khi dịch lại chữ Hán.");
      return;
    }
    try {
      const lines = legend.desktop
        ? await legend.runSyncTask({
            title: "Đang liệt kê dòng Hán…",
            description: "Đọc danh sách dòng còn chữ Hán trong preview.",
            task: () => ipc.listLegendPreviewHanLines(),
          })
        : legendDiffsWithHan(legend.preview?.diffs ?? []).map(
            (diff) => diff.lineNumber,
          );
      if (!lines?.length) {
        toast.message("Không còn dòng nào có chữ Hán.");
        return;
      }
      const saved = await legend.retranslateHan(lines);
      if (saved) {
        toast.success(
          `Đã dịch lại ${formatNumber(lines.length)} dòng còn chữ Hán.`,
        );
      }
    } catch {
      toast.error("Không liệt kê được dòng còn chữ Hán.");
    }
  }

  async function retranslateSelectedLines() {
    if (previewTextDirty) {
      toast.error("Lưu sửa bản dịch trước khi dịch lại.");
      return;
    }
    const lines = legendSelectedLineNumbers(filterLineRefs, selectionMask);
    if (lines.length === 0) {
      toast.error("Chưa chọn dòng nào trong bộ lọc hiện tại.");
      return;
    }
    const saved = await legend.retranslateHan(lines);
    if (saved) {
      toast.success(`Đã dịch lại ${formatNumber(lines.length)} dòng đã chọn.`);
    }
  }

  async function retranslateLine(lineNumber: number) {
    if (previewTextDirty) {
      toast.error("Lưu sửa bản dịch trước khi dịch lại.");
      return;
    }
    retranslateFocusRef.current = lineNumber;
    setRetranslatingLine(lineNumber);
    const saved = await legend.retranslateHan([lineNumber]);
    setRetranslatingLine(null);
    if (!saved) {
      retranslateFocusRef.current = null;
      return;
    }
    toast.success(`Đã dịch lại dòng ${formatNumber(lineNumber)}.`);
  }

  useEffect(() => {
    if (legend.phase === "inspecting") {
      setEstimateResult({ key: estimateKey, value: null, failed: false });
      setEstimateFetching(false);
    }
  }, [estimateKey, legend.phase]);

  useEffect(() => {
    if (
      !legend.desktop ||
      !legend.inspection ||
      legend.phase === "inspecting" ||
      legend.isJobActive
    ) {
      return;
    }
    const key = estimateKey;
    const cached = estimateCacheRef.current;
    if (cached.key === key && (cached.value || cached.failed)) {
      return;
    }
    let cancelled = false;
    setEstimateFetching(true);
    const timer = window.setTimeout(() => {
      void runEstimateRef
        .current(legend.inspection!.sourcePath, { silent: true })
        .then((value) => {
          if (cancelled) return;
          setEstimateResult({
            key,
            value: value ?? null,
            failed: !value,
          });
        })
        .catch(() => {
          if (!cancelled) {
            setEstimateResult({ key, value: null, failed: true });
          }
        })
        .finally(() => {
          if (!cancelled) setEstimateFetching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setEstimateFetching(false);
    };
  }, [
    estimateKey,
    legend.desktop,
    legend.inspection?.sourcePath,
    legend.isJobActive,
    legend.phase,
  ]);

  async function openPath(path: string) {
    try {
      await ipc.openFile(path);
    } catch {
      toast.error("Không mở được đường dẫn đã chọn.");
    }
  }

  return (
    <div
      className={cn(
        pageContainerClass,
        "relative",
        pageLoading.loading && "pointer-events-none",
      )}
    >
      <AsyncLoadingOverlay
        visible={pageLoading.loading}
        title={pageLoading.title}
        description={pageLoading.description}
        phase={pageLoading.phase ?? undefined}
        phaseLabel={pageLoading.phaseLabel ?? undefined}
        progress={pageLoading.progress}
      />
      <PageHeader
        eyebrow="Legend of Heroes Three Kingdoms"
        title="Dịch Trung → Việt"
        description="Dịch Trung → Việt theo bối cảnh Tam Quốc. Mặc định chỉ dịch câu chưa Việt hóa; duyệt diff trước khi backup và ghi vào game."
      />

      <PresenceAlert show={Boolean(legend.error)} variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>Không thể hoàn tất thao tác</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{legend.error}</span>
          <Button size="sm" variant="outline" onClick={legend.resetError}>
            <RotateCcwIcon data-icon="inline-start" />
            Thử lại
          </Button>
        </AlertDescription>
      </PresenceAlert>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Tổng quan</CardTitle>
            <CardDescription className="truncate">
              {legend.sourcePath.trim()
                ? displayLegendPath(legend.sourcePath)
                : "Chưa chọn file nguồn XUnity. Vào Cài đặt để chọn file và thư mục game."}
            </CardDescription>
            <CardAction className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onNavigate("legend-settings")}
              >
                <FolderOpenIcon data-icon="inline-start" />
                Cài đặt
              </Button>
              <Button
                type="button"
                variant={actionBtn.inspect}
                disabled={busy || !legend.sourcePath.trim()}
                onClick={() => void legend.inspect()}
              >
                {legend.phase === "inspecting" ? (
                  <Loader2Icon
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : (
                  <FileSearchIcon data-icon="inline-start" />
                )}
                Kiểm tra
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Metric
                icon={FileCheck2Icon}
                label="Mục có thể dịch"
                value={
                  legend.inspection
                    ? formatNumber(legend.inspection.entryCount)
                    : "—"
                }
              />
              <Metric
                icon={FileDiffIcon}
                label="Nguồn duy nhất"
                value={
                  legend.inspection
                    ? formatNumber(legend.inspection.uniqueSourceCount)
                    : "—"
                }
                hint={
                  estimate
                    ? `${formatNumber(estimate.pendingItems)} câu mới cần API`
                    : legend.inspection
                      ? `${formatNumber(legend.inspection.syntaxSourceCount)} mục có token/cú pháp`
                      : "Bấm Kiểm tra để đếm nguồn"
                }
              />
              <Metric
                icon={FileSearchIcon}
                label="Tổng số dòng"
                value={
                  legend.inspection
                    ? formatNumber(legend.inspection.totalLines)
                    : "—"
                }
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Metric
                icon={SparklesIcon}
                label="Cần gọi API"
                value={
                  estimate
                    ? formatNumber(estimate.pendingItems)
                    : estimateLoading
                      ? "…"
                      : "—"
                }
                hint="Câu chưa Việt hóa / chưa cache"
              />
              <Metric
                icon={ZapIcon}
                label="Luồng song song"
                value={
                  estimate
                    ? estimate.workersUsed
                      ? `${formatNumber(estimate.workersUsed)} luồng${
                          (estimate.spareKeys ?? 0) > 0
                            ? ` · ${formatNumber(estimate.spareKeys ?? 0)} dự phòng`
                            : ""
                        }`
                      : "0"
                    : "—"
                }
                hint="min(key bật, số batch)"
              />
              <Metric
                icon={HistoryIcon}
                label="Thời gian ước tính"
                value={
                  estimate
                    ? estimate.pendingItems <= 0
                      ? "Không gọi API"
                      : `${formatNumber(Math.max(1, Math.ceil(estimate.estimatedSecondsMin / 60)))}–${formatNumber(Math.max(1, Math.ceil(estimate.estimatedSecondsMax / 60)))} phút`
                    : "—"
                }
                hint="Đã chia theo số luồng"
              />
            </div>

            {legend.inspection && (
              <>
                <Alert variant="info">
                  <SparklesIcon />
                  <AlertTitle>
                    {legendInspectEstimateTitle({
                      estimate,
                      loading: estimateLoading,
                      failed: estimateFailed,
                    })}
                  </AlertTitle>
                  <AlertDescription>
                    {legendEstimateSummary({
                      estimate,
                      uniqueSourceCount: legend.inspection.uniqueSourceCount,
                      loading: estimateLoading,
                      failed: estimateFailed,
                    })}
                  </AlertDescription>
                </Alert>

                {(legend.inspection.duplicateSources > 0 ||
                  (inspectDuplicateTotal ?? 0) > 0) && (
                  <Alert variant="warning">
                    <CopyMinusIcon />
                    <AlertTitle>Có nguồn trùng trong file</AlertTitle>
                    <AlertDescription className="flex flex-col items-start gap-3">
                      <span>
                        {formatNumber(legend.inspection.duplicateSources)} dòng
                        là bản sao thêm của cùng một câu Trung. Xóa trùng sẽ giữ
                        dòng xuất hiện sau cùng (đúng XUnity) và backup file
                        gốc.
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setInspectFilter("duplicate")}
                        >
                          Xem dòng trùng
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => setDedupeConfirm(true)}
                        >
                          <CopyMinusIcon data-icon="inline-start" />
                          Xóa dòng trùng
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                {warningCount > 0 && (
                  <Alert variant="warning">
                    <AlertTriangleIcon />
                    <AlertTitle>Có dòng không được dịch</AlertTitle>
                    <AlertDescription className="flex flex-col items-start gap-3">
                      <span>
                        {formatNumber(warningCount)} dòng bị bỏ qua
                        {warningReasons.length > 0
                          ? `: ${warningReasons.join(" · ")}`
                          : "."}{" "}
                        Đây là cảnh báo, không chặn bước dịch.
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setInspectFilter("invalid")}
                      >
                        Xem dòng cảnh báo
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-col gap-3">
                  <ToggleGroup
                    type="single"
                    size="sm"
                    value={inspectFilter}
                    onValueChange={(value) => {
                      if (
                        value === "entry" ||
                        value === "invalid" ||
                        value === "duplicate"
                      ) {
                        setInspectFilter(value);
                      }
                    }}
                  >
                    <ToggleGroupItem value="entry">Có thể dịch</ToggleGroupItem>
                    <ToggleGroupItem value="invalid">
                      Cảnh báo
                      {warningCount > 0
                        ? ` (${formatNumber(warningCount)})`
                        : ""}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="duplicate">
                      Nguồn trùng
                      {duplicateCount > 0
                        ? ` (${formatNumber(duplicateCount)})`
                        : ""}
                    </ToggleGroupItem>
                  </ToggleGroup>

                  <div className="overflow-hidden rounded-xl border">
                    <Table className="table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">Dòng</TableHead>
                          <TableHead>
                            {inspectFilter === "invalid"
                              ? "Nội dung dòng"
                              : "Tiếng Trung"}
                          </TableHead>
                          <TableHead>
                            {inspectFilter === "invalid"
                              ? "Lý do"
                              : "Vế phải hiện tại"}
                          </TableHead>
                          {inspectFilter === "duplicate" ? (
                            <TableHead className="w-24">Số lần</TableHead>
                          ) : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inspectRowsLoading && inspectRows.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={inspectFilter === "duplicate" ? 4 : 3}
                              className="text-muted-foreground"
                            >
                              Đang tải danh sách dòng…
                            </TableCell>
                          </TableRow>
                        ) : inspectRows.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={inspectFilter === "duplicate" ? 4 : 3}
                              className="text-muted-foreground"
                            >
                              {inspectFilter === "invalid"
                                ? "Không có dòng cảnh báo."
                                : inspectFilter === "duplicate"
                                  ? "Không có nguồn trùng."
                                  : "Không có mục có thể dịch trên trang này."}
                            </TableCell>
                          </TableRow>
                        ) : (
                          inspectRows.map((entry) => (
                            <TableRow
                              key={`${entry.kind ?? inspectFilter}-${entry.lineNumber}-${entry.source}`}
                            >
                              <TableCell className="w-20 tabular-nums align-top">
                                {entry.lineNumber}
                              </TableCell>
                              <TableCell className={INSPECT_TEXT_CELL}>
                                {entry.source || "—"}
                              </TableCell>
                              <TableCell
                                className={`${INSPECT_TEXT_CELL} text-muted-foreground`}
                              >
                                {inspectFilter === "invalid"
                                  ? (entry.warning ?? "Dòng không hợp lệ")
                                  : entry.currentTarget || "—"}
                              </TableCell>
                              {inspectFilter === "duplicate" ? (
                                <TableCell className="w-24 tabular-nums align-top">
                                  {entry.occurrence
                                    ? `×${formatNumber(entry.occurrence)}`
                                    : "—"}
                                </TableCell>
                              ) : null}
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
                <TablePaginator
                  page={safeInspectPage}
                  totalPages={inspectTotalPages}
                  totalItems={inspectTotalItems}
                  pageSize={inspectPageSize}
                  pageSizeOptions={INSPECTION_PAGE_SIZE_OPTIONS}
                  onPageChange={setInspectPage}
                  onPageSizeChange={(nextPageSize) =>
                    setInspectPageSize(nextPageSize as InspectionPageSize)
                  }
                  summary={
                    inspectFilter === "invalid"
                      ? `${formatNumber(inspectTotalItems)} dòng cảnh báo`
                      : inspectFilter === "duplicate"
                        ? `${formatNumber(inspectTotalItems)} dòng nguồn trùng`
                        : `${formatNumber(inspectTotalItems)} mục trong file`
                  }
                />
              </>
            )}
            {!legend.inspection && (
              <p className="text-sm text-muted-foreground">
                {legend.sourcePath.trim()
                  ? "Bấm Kiểm tra để xem số dòng, câu cần dịch và cảnh báo."
                  : "Chưa có file nguồn. Mở Cài đặt để chọn file XUnity rồi quay lại Kiểm tra."}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Gemini</CardTitle>
            <CardDescription>
              {enabledKeys.length} API key đang bật ·{" "}
              {controller.state.config.model}
            </CardDescription>
            <CardAction>
              <Button variant={actionBtn.manageApi} onClick={() => setApiOpen(true)}>
                <KeyRoundIcon data-icon="inline-start" />
                Quản lý API
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Ước tính API</FieldLabel>
              <FieldDescription>
                {legend.inspection
                  ? legendEstimateSummary({
                      estimate,
                      uniqueSourceCount: legend.inspection.uniqueSourceCount,
                      loading: estimateLoading,
                      failed: estimateFailed,
                    })
                  : "Kiểm tra file trước để biết số câu mới cần gọi API. Sau khi dịch, chọn từng câu hoặc Dịch lại đã chọn nếu cần sửa."}
              </FieldDescription>
            </Field>
            {running ? (
              <>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">
                    {legend.progress.total > 0
                      ? `${formatNumber(legend.progress.processed)} / ${formatNumber(legend.progress.total)} mục`
                      : "Đang chuẩn bị batch…"}
                    {legend.progress.workers
                      ? ` · ${formatNumber(legend.progress.workers)} luồng đang chạy`
                      : ""}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {Math.round(legend.progress.progress)}%
                  </span>
                </div>
                <Progress value={legend.progress.progress} />
                <p className="truncate text-xs text-muted-foreground">
                  {legend.retranslating
                    ? legend.progress.currentItem ||
                      legend.progress.model ||
                      "Đang dịch lại chữ Hán…"
                    : legend.progress.currentItem ||
                      legend.progress.model ||
                      "Engine đang khởi động…"}
                </p>
                {!legend.retranslating && (
                  <Button
                    variant="destructive"
                    disabled={legend.phase === "cancelling"}
                    onClick={() => void legend.cancel()}
                  >
                    {legend.phase === "cancelling" ? (
                      <Loader2Icon
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <SquareIcon data-icon="inline-start" />
                    )}
                    {legend.phase === "starting"
                      ? "Hủy khi khởi động"
                      : legend.phase === "cancelling"
                        ? legend.progress.workers
                          ? `Đang dừng ${formatNumber(legend.progress.workers)} luồng…`
                          : "Đang dừng…"
                        : "Dừng tác vụ"}
                  </Button>
                )}
              </>
            ) : (
              <>
                {enabledKeys.length === 0 && (
                  <Alert variant="destructive">
                    <KeyRoundIcon />
                    <AlertTitle>Thiếu API key đang bật</AlertTitle>
                    <AlertDescription>
                      Thêm hoặc bật ít nhất một Gemini API key trước khi dịch.
                    </AlertDescription>
                  </Alert>
                )}
                <Button
                  variant={actionBtn.translateNew}
                  disabled={
                    !legend.inspection ||
                    busy ||
                    enabledKeys.length === 0 ||
                    legend.inspection.entryCount === 0 ||
                    (estimate != null &&
                      legendEstimateActionableItems(estimate) <= 0)
                  }
                  onClick={() => void legend.translate()}
                >
                  <PlayIcon data-icon="inline-start" />
                  {legendTranslateButtonLabel(estimate)}
                </Button>
                <Button
                  variant={actionBtn.translateAll}
                  disabled={
                    !legend.inspection ||
                    busy ||
                    enabledKeys.length === 0 ||
                    legend.inspection.entryCount === 0
                  }
                  onClick={() => {
                    setForceEstimate(null);
                    setForceConfirm(true);
                    if (!legend.desktop || !legend.inspection) return;
                    void legend
                      .runEstimate(legend.inspection.sourcePath, {
                        forceRetranslate: true,
                      })
                      .then((value) => {
                        if (value) setForceEstimate(value);
                      })
                      .catch(() => setForceEstimate(null));
                  }}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {legendForceTranslateButtonLabel()}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Mặc định chỉ dịch câu chưa Việt hóa trong file. Câu đã Việt
                  được bỏ qua; chỉ câu mới gọi API. File gốc chỉ đổi sau khi
                  duyệt diff và bấm Áp dụng. Muốn làm lại chất lượng thì dùng
                  Dịch lại tất cả.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <PresenceAlert show={previewLoading} variant="info">
          <Loader2Icon className="animate-spin" />
          <AlertTitle>Đang tải bảng diff</AlertTitle>
          <AlertDescription>
            {legend.previewLoading
              ? "Đang đọc preview từ AppData. File lớn có thể mất vài giây — app vẫn phản hồi."
              : "Dịch đã xong; đang đọc preview từ artifact. Bảng kết quả sẽ hiện trong giây lát."}
          </AlertDescription>
        </PresenceAlert>

        {!legend.preview &&
          !previewLoading &&
          !legend.isJobActive &&
          legend.savedPreviews.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Preview đã lưu trong AppData</CardTitle>
                <CardDescription>
                  Tìm thấy JSON trong{" "}
                  <code className="text-xs">legend/previews</code>. Mở để xem
                  bảng diff — không cần Deploy hay Apply trước.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {legend.savedPreviews.map((item) => (
                  <div
                    key={item.previewPath}
                    className="flex flex-col gap-3 rounded-lg bg-surface-gradient p-3 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)] sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft-gradient text-primary">
                        <FileDiffIcon aria-hidden="true" className="size-4" />
                      </span>
                      <div className="min-w-0 space-y-1 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.previewId}</span>
                          {item.changedLines > 0 && (
                            <Badge variant="secondary">
                              {formatNumber(item.changedLines)} dòng diff
                            </Badge>
                          )}
                        </div>
                        <p className="break-all text-muted-foreground">
                          {item.previewPath}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      disabled={
                        legend.loadingSavedPreviews || legend.isJobActive
                      }
                      onClick={() =>
                        void legend.adoptPreviewFromPath(item.previewPath)
                      }
                    >
                      {legend.loadingSavedPreviews ? (
                        <Loader2Icon
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <HistoryIcon data-icon="inline-start" />
                      )}
                      Mở bảng diff
                    </Button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={legend.loadingSavedPreviews}
                  onClick={() => void legend.refreshSavedPreviews()}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Quét lại thư mục preview
                </Button>
              </CardContent>
            </Card>
          )}

        {legend.preview ? (
          <Card>
            <CardHeader>
              <CardTitle>Diff chờ áp dụng</CardTitle>
              <CardDescription>
                {formatNumber(headerDiffCount)} dòng thay đổi · artifact{" "}
                {legend.preview.previewId}
                {previewTextDirty
                  ? ` · ${formatNumber(Object.keys(pendingEdits).length)} chưa lưu`
                  : ""}
              </CardDescription>
              <CardAction className="flex flex-wrap items-center gap-2">
                {legend.preview.mode === "full" && (
                  <>
                    <Button
                      variant="outline"
                      disabled={
                        !previewTextDirty ||
                        !legend.canMutatePreview ||
                        savingPreview
                      }
                      onClick={() => void savePreviewEdits()}
                    >
                      {savingPreview ? (
                        <Loader2Icon
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <SaveIcon data-icon="inline-start" />
                      )}
                      Lưu file
                      {previewTextDirty
                        ? ` (${formatNumber(Object.keys(pendingEdits).length)})`
                        : ""}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!previewTextDirty || savingPreview}
                      onClick={() => setPendingEdits({})}
                    >
                      <RotateCcwIcon data-icon="inline-start" />
                      Hủy sửa
                    </Button>
                  </>
                )}
                <Button
                  variant={actionBtn.deploy}
                  disabled={
                    !legend.canApply ||
                    selectedCount === 0 ||
                    previewTextDirty ||
                    savingPreview
                  }
                  title={
                    previewTextDirty
                      ? "Lưu sửa bản dịch trước khi deploy"
                      : deployConfigured
                        ? "Backup và ghi _AutoGeneratedTranslations.txt vào thư mục game"
                        : "Chưa cấu hình thư mục game — chỉ ghi file nguồn XUnity"
                  }
                  onClick={() => setApplyConfirm(true)}
                >
                  {deployConfigured ? (
                    <UploadIcon data-icon="inline-start" />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  {deployConfigured ? "Deploy vào game" : "Áp dụng file nguồn"}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {legend.preview.mode === "full" && !deployConfigured && (
                <Alert variant="warning">
                  <FolderOpenIcon />
                  <AlertTitle>Chưa cấu hình thư mục deploy</AlertTitle>
                  <AlertDescription>
                    Điền hoặc chọn thư mục{" "}
                    <code>…\BepInEx\Translation\vi\Text</code> trong Cài đặt.
                    Nếu không, nút Áp dụng chỉ ghi file nguồn bạn đang dịch,
                    không copy vào folder game.
                  </AlertDescription>
                </Alert>
              )}
              {legend.preview.qaStaleReason && (
                <Alert variant="destructive">
                  <AlertTriangleIcon />
                  <AlertTitle>QA đã cũ</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      {legend.preview.qaStaleReason} Bấm Rebuild preview + QA để
                      chạy lại kiểm tra với glossary mới, hoặc lưu/sửa trước khi
                      áp dụng.
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={
                        !legend.canMutatePreview ||
                        previewTextDirty ||
                        savingPreview
                      }
                      onClick={() => void rebuildPreviewQa()}
                    >
                      Rebuild preview + QA
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {previewTextDirty && (
                <Alert variant="warning">
                  <AlertTriangleIcon />
                  <AlertTitle>Bản sửa chưa lưu</AlertTitle>
                  <AlertDescription>
                    Cột Quy tắc/Chi tiết vẫn là lần QA trước. Bấm Lưu file để
                    kiểm tra lại chữ vừa sửa.
                  </AlertDescription>
                </Alert>
              )}
              <Alert
                variant={
                  legend.preview.qa.blocking ? "destructive" : "success"
                }
              >
                <ShieldCheckIcon />
                <AlertTitle>
                  QA: {formatNumber(legend.preview.qa.errors)} lỗi ·{" "}
                  {formatNumber(legend.preview.qa.warnings)} cảnh báo
                </AlertTitle>
                <AlertDescription>
                  {legend.preview.qa.blocking
                    ? "Phải sửa hết lỗi trước khi áp dụng."
                    : "Không có lỗi blocking."}
                  {fileLevelQaIssues.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {fileLevelQaIssues.map((issue) => (
                        <li key={issue.id}>
                          {qaRuleLabel(issue.rule)}: {issue.detail}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </AlertDescription>
              </Alert>
              <div className="flex w-full flex-wrap items-center gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ToggleGroup
                    type="single"
                    size="sm"
                    value={diffFilter}
                    onValueChange={(value) => {
                      if (
                        value === "all" ||
                        value === "han" ||
                        value === "error" ||
                        value === "warning"
                      ) {
                        setDiffFilter(value);
                        setPage(1);
                      }
                    }}
                  >
                    <ToggleGroupItem value="all">
                      Tất cả
                      {` (${formatNumber(headerDiffCount)})`}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="han">
                      Còn chữ Hán
                      {headerHanCount > 0
                        ? ` (${formatNumber(headerHanCount)})`
                        : ""}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="error">
                      Lỗi
                      {` (${formatNumber(headerErrorCount)})`}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="warning">
                      Cảnh báo
                      {` (${formatNumber(headerWarningCount)})`}
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Input
                    className="w-44"
                    value={lineFilter}
                    placeholder="12, 20-30"
                    spellCheck={false}
                    aria-label="Lọc theo số dòng file"
                    title="Số dòng trong file gốc (không phải STT bảng). Ví dụ: 14198, 20006 hoặc 20-30"
                    onChange={(event) => {
                      setLineFilter(event.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                {legend.preview.mode === "full" && (
                  <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !legend.canMutatePreview ||
                        savingPreview ||
                        previewTextDirty ||
                        legend.retranslating
                      }
                      title={
                        previewTextDirty
                          ? "Lưu sửa bản dịch trước khi làm mới QA"
                          : "Chạy lại QA trên preview hiện tại, không gọi API dịch"
                      }
                      onClick={() => void refreshQa()}
                    >
                      {savingPreview ? (
                        <Loader2Icon
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <ShieldCheckIcon data-icon="inline-start" />
                      )}
                      Làm mới QA
                    </Button>
                    <span
                      className="inline-flex"
                      title={
                        !legend.canMutatePreview
                          ? "Preview đang bị khóa bởi một tác vụ khác"
                          : savingPreview || legend.retranslating
                            ? "Đang lưu hoặc dịch lại…"
                            : selectedFilteredCount === 0
                              ? "Tick các dòng cần áp đề xuất"
                              : suggestionApplyStats.selectedWithSuggestions ===
                                  0
                                ? "Các dòng đang chọn không có đề xuất QA"
                                : suggestionApplyStats.lines === 0
                                  ? "Đã chọn dòng có đề xuất, nhưng ô Sau không còn chữ Hán để thay. Nút vẫn bấm được — sẽ báo nếu không thay được gì."
                                  : `Áp dụng ${formatNumber(suggestionApplyStats.replacements)} đề xuất trên ${formatNumber(suggestionApplyStats.lines)} dòng đang chọn trong bộ lọc`
                      }
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          suggestionApplyStats.selectedWithSuggestions === 0 ||
                          !legend.canMutatePreview ||
                          savingPreview ||
                          legend.retranslating
                        }
                        onClick={applyFilteredTermSuggestions}
                      >
                        <SparklesIcon data-icon="inline-start" />
                        Áp dụng đề xuất
                        {suggestionApplyStats.lines > 0
                          ? ` (${formatNumber(suggestionApplyStats.lines)})`
                          : suggestionApplyStats.selectedWithSuggestions > 0
                            ? ` (${formatNumber(suggestionApplyStats.selectedWithSuggestions)})`
                            : ""}
                      </Button>
                    </span>
                    <Button
                      size="sm"
                      variant={actionBtn.retranslate}
                      disabled={
                        selectedFilteredCount === 0 ||
                        !legend.canMutatePreview ||
                        previewTextDirty ||
                        savingPreview ||
                        legend.retranslating ||
                        diffsTableLoading ||
                        !filterRefsReady ||
                        enabledKeys.length === 0
                      }
                      title={
                        previewTextDirty
                          ? "Lưu sửa bản dịch trước khi dịch lại"
                          : enabledKeys.length === 0
                            ? "Cần API key đang bật"
                            : !filterRefsReady || diffsTableLoading
                              ? "Đang tải danh sách dòng"
                              : selectedFilteredCount === 0
                                ? "Tick các dòng cần dịch, hoặc Bỏ chọn tất cả rồi chọn lại"
                                : "Dịch lại các dòng đang tick trong bộ lọc hiện tại (mọi trang)"
                      }
                      onClick={() => void retranslateSelectedLines()}
                    >
                      {legend.retranslating ? (
                        <Loader2Icon
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      Dịch lại đã chọn
                      {selectedFilteredCount > 0
                        ? ` (${formatNumber(selectedFilteredCount)})`
                        : ""}
                    </Button>
                    <Button
                      size="sm"
                      variant={actionBtn.retranslate}
                      disabled={
                        headerHanCount === 0 ||
                        !legend.canMutatePreview ||
                        previewTextDirty ||
                        savingPreview ||
                        legend.retranslating ||
                        diffsTableLoading ||
                        enabledKeys.length === 0
                      }
                      title={
                        previewTextDirty
                          ? "Lưu sửa bản dịch trước khi dịch lại"
                          : enabledKeys.length === 0
                            ? "Cần API key đang bật"
                            : headerHanCount === 0
                              ? "Không còn dòng chữ Hán"
                              : "Gửi hết dòng còn Hán; mỗi lần 15 dòng, chạy đến khi xong"
                      }
                      onClick={() => void retranslateHanLines()}
                    >
                      {legend.retranslating ? (
                        <Loader2Icon
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      Dịch lại chữ Hán
                      {headerHanCount > 0
                        ? ` (${formatNumber(headerHanCount)})`
                        : ""}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !legend.canMutatePreview ||
                        savingPreview ||
                        diffsTableLoading ||
                        !filterRefsReady
                      }
                      title="Mọi trang trong bộ lọc hiện tại"
                      onClick={() => setPreviewSelection(() => true)}
                    >
                      Chọn tất cả
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !legend.canMutatePreview ||
                        savingPreview ||
                        diffsTableLoading ||
                        !filterRefsReady
                      }
                      title="Mọi trang trong bộ lọc hiện tại"
                      onClick={() => setPreviewSelection(() => false)}
                    >
                      Bỏ chọn tất cả
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !legend.canMutatePreview ||
                        savingPreview ||
                        diffsTableLoading ||
                        !filterRefsReady
                      }
                      title="Bỏ tick các dòng lỗi trong bộ lọc hiện tại (mọi trang)"
                      onClick={() => {
                        const errorLines = new Set(
                          filterLineRefs
                            .filter((row) => row.error)
                            .map((row) => row.lineNumber),
                        );
                        setPreviewSelection(
                          (diff) => !errorLines.has(diff.lineNumber),
                        );
                      }}
                    >
                      Chỉ chọn dòng không lỗi
                    </Button>
                  </div>
                )}
              </div>
              <div className="overflow-hidden rounded-xl border">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <span className="flex w-full justify-center">Chọn</span>
                      </TableHead>
                      <TableHead className="w-16">
                        <span className="flex w-full justify-center">
                          Dòng file
                        </span>
                      </TableHead>
                      <TableHead className="w-[24%]">Tiếng Trung</TableHead>
                      <TableHead className="w-[24%]">Sau</TableHead>
                      <TableHead className="w-[11rem]">Quy tắc</TableHead>
                      <TableHead>Chi tiết</TableHead>
                      <TableHead className="w-12">
                        <span className="flex w-full justify-center">
                          <RefreshCwIcon
                            className="size-4 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="sr-only">Dịch lại</span>
                        </span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleDiffs.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={PREVIEW_TABLE_COLUMNS}
                          className="text-muted-foreground"
                        >
                          {diffsTableLoading
                            ? "Đang tải trang diff…"
                            : lineFilter.trim()
                              ? "Không có dòng khớp số đã nhập."
                              : diffFilter === "han"
                                ? "Không còn dòng chữ Hán."
                                : diffFilter === "error"
                                  ? "Không có dòng lỗi."
                                  : diffFilter === "warning"
                                    ? "Không có dòng cảnh báo."
                                    : "Không có dòng thay đổi."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      visibleDiffs.map((diff) => {
                        const qaStale = unsavedTextLines.has(diff.lineNumber);
                        const qaTone = qaStale
                          ? undefined
                          : qaToneByLine.get(diff.lineNumber);
                        return (
                          <LegendDiffEditorRow
                            key={`${legend.preview?.previewId}:${legend.preview?.revision}:${diff.lineNumber}`}
                            diff={diff}
                            qaTone={qaTone}
                            qaIssues={qaIssuesByLine.get(diff.lineNumber) ?? []}
                            qaStale={qaStale}
                            editable={
                              legend.canMutatePreview &&
                              !savingPreview &&
                              !legend.retranslating &&
                              !diffsTableLoading
                            }
                            retranslateEnabled={retranslateRowEnabled}
                            retranslateBusy={
                              legend.retranslating &&
                              retranslatingLine === diff.lineNumber
                            }
                            retranslateDisabledReason={retranslateRowReason}
                            onChange={patchPreviewEdit}
                            onSelect={setRowSelected}
                            onRetranslate={(lineNumber) =>
                              void retranslateLine(lineNumber)
                            }
                          />
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
              <TablePaginator
                page={Math.min(page, totalPages)}
                totalPages={totalPages}
                totalItems={previewPageTotal}
                pageSize={previewPageSize}
                pageSizeOptions={PREVIEW_PAGE_SIZE_OPTIONS}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPreviewPageSize(nextPageSize as PreviewPageSize);
                  setPage(1);
                }}
                summary={(() => {
                  const stats = legend.preview.stats;
                  const parts = [
                    `${formatNumber(stats.cacheHits)} cache hit`,
                    `${formatNumber(stats.apiCalls)} API call`,
                  ];
                  if (typeof stats.qaPassedFirstPass === "boolean") {
                    parts.push(
                      stats.qaPassedFirstPass
                        ? "QA pass lần 1"
                        : "QA cần retry/sửa",
                    );
                  }
                  if (
                    typeof stats.retryPassesUsed === "number" &&
                    stats.retryPassesUsed > 0
                  ) {
                    parts.push(
                      `${formatNumber(stats.retryPassesUsed)} retry pass`,
                    );
                  }
                  if (
                    typeof stats.retranslatedSources === "number" &&
                    stats.retranslatedSources > 0
                  ) {
                    parts.push(
                      `${formatNumber(stats.retranslatedSources)} dòng dịch lại`,
                    );
                  }
                  const topRule = stats.topFailedRules?.[0];
                  if (topRule) {
                    parts.push(
                      `top lỗi: ${topRule.rule} (${formatNumber(topRule.count)})`,
                    );
                  }
                  return parts.join(" · ");
                })()}
              />
            </CardContent>
          </Card>
        ) : null}

        <PresenceAlert show={Boolean(legend.applyResult)} variant="success">
          <CheckCircle2Icon />
          <AlertTitle>Đã cập nhật file bản dịch</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span className="min-w-0 max-w-full break-words">
              Đã ghi {formatNumber(legend.applyResult?.updatedLines ?? 0)} dòng. Bản
              gốc được lưu tại{" "}
                <span className="break-all">
                  {displayLegendPath(legend.applyResult?.backupPath ?? "")}
                </span>
                .
                {legend.applyResult?.deployPath ? (
                  <>
                    {" "}
                    File game:{" "}
                    <span className="break-all">
                      {displayLegendPath(legend.applyResult.deployPath)}
                    </span>
                    {legend.applyResult.deployBackupPath
                      ? ` (backup: ${displayLegendPath(legend.applyResult.deployBackupPath)})`
                      : ""}
                    .
                  </>
                ) : null}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!legend.applyResult}
                  onClick={() => {
                    if (!legend.applyResult) return
                    void openPath(legend.applyResult.sourcePath)
                  }}
                >
                  <FileCheck2Icon data-icon="inline-start" />
                  Mở file nguồn
                </Button>
                {legend.applyResult?.deployPath ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!legend.applyResult?.deployPath) return
                      void openPath(legend.applyResult.deployPath)
                    }}
                  >
                    <FileCheck2Icon data-icon="inline-start" />
                    Mở file game
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!legend.applyResult}
                  onClick={() => {
                    if (!legend.applyResult) return
                    void openPath(legend.applyResult.backupPath)
                  }}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  Mở backup
                </Button>
              </div>
            </AlertDescription>
        </PresenceAlert>

        <LegendJobConsole events={legend.events} onClear={legend.clearEvents} />
      </div>

      <AlertDialog
        open={forceConfirm}
        onOpenChange={(open) => {
          setForceConfirm(open);
          if (!open) {
            setForceEstimate(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dịch lại tất cả?</AlertDialogTitle>
            <AlertDialogDescription>
              Sẽ bỏ qua bản Việt đã có trong file và dịch lại toàn bộ nguồn duy
              nhất
              {legend.inspection
                ? ` (${formatNumber(legend.inspection.uniqueSourceCount)})`
                : ""}
              . Cache không được dùng; chỉ các dòng khác bản mới xuất hiện trong
              preview. File gốc chỉ đổi khi bạn Áp dụng.
              {forceEstimateLoading
                ? " Đang ước tính số lần gọi API…"
                : forceEstimate
                  ? ` Ước khoảng ${formatNumber(forceEstimate.pendingItems)} câu gọi API · ${formatNumber(forceEstimate.estimatedBatches)} batch.`
                  : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant={actionBtn.translateAll}
              disabled={busy || forceEstimateLoading}
              onClick={() => {
                setForceConfirm(false);
                void legend.translate({ forceRetranslate: true });
              }}
            >
              Dịch lại tất cả
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dedupeConfirm} onOpenChange={setDedupeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa dòng nguồn trùng?</AlertDialogTitle>
            <AlertDialogDescription>
              Sẽ xóa {formatNumber(legend.inspection?.duplicateSources ?? 0)}{" "}
              dòng trùng, giữ bản xuất hiện sau cùng của mỗi câu Trung. File gốc
              được backup trước khi ghi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Giữ nguyên</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDedupeConfirm(false);
                void legend.dedupe().then((result) => {
                  if (!result) return;
                  setInspectFilter("entry");
                  if (result.removed > 0) {
                    toast.success(
                      `Đã xóa ${formatNumber(result.removed)} dòng trùng, còn ${formatNumber(result.remainingEntries)} mục.`,
                    );
                  } else {
                    toast.message("Không còn dòng trùng để xóa.");
                  }
                });
              }}
            >
              <CopyMinusIcon data-icon="inline-start" />
              Backup và xóa trùng
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={applyConfirm} onOpenChange={setApplyConfirm}>
        <AlertDialogContent className="overflow-hidden data-[size=default]:max-w-[min(28rem,calc(100vw-1.5rem))] data-[size=default]:sm:max-w-md">
          <AlertDialogHeader className="min-w-0">
            <AlertDialogTitle>
              {deployConfigured
                ? "Deploy bản dịch vào game?"
                : "Áp dụng bản dịch vào file nguồn?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 overflow-hidden break-words text-left">
              Ứng dụng sẽ kiểm tra fingerprint, tạo backup có manifest rồi ghi
              atomic {formatNumber(selectedCount)} dòng đã chọn vào file nguồn
              {deployConfigured ? (
                <>
                  {" "}
                  và deploy <code>_AutoGeneratedTranslations.txt</code> vào:
                  <code className="mt-1 block max-w-full break-all">
                    {displayLegendPath(legend.deployPath)}
                  </code>
                </>
              ) : (
                ". "
              )}
              Sau deploy, bảng diff sẽ ẩn vì artifact đã được ghi ra disk. Nếu
              file đã bị sửa sau lúc dịch, thao tác sẽ dừng an toàn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="min-w-0">
            <AlertDialogCancel>Tiếp tục xem</AlertDialogCancel>
            <AlertDialogAction
              variant={actionBtn.deploy}
              className="max-w-full whitespace-normal"
              onClick={() => {
                setApplyConfirm(false);
                void (async () => {
                  if (previewDirty) {
                    const saved = await savePreviewEdits({ silent: true });
                    if (!saved) return;
                  }
                  await legend.apply();
                })();
              }}
            >
              {deployConfigured ? (
                <UploadIcon data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {deployConfigured
                ? `Deploy ${formatNumber(selectedCount)} dòng vào game`
                : `Backup và áp dụng ${formatNumber(selectedCount)} dòng`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ApiManagerDialog
        open={apiOpen}
        onOpenChange={setApiOpen}
        controller={controller}
        locked={running}
      />
    </div>
  );
}
