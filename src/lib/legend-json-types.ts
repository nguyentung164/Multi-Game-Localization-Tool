export type LegendJsonCommand =
  | "legend-json-scan"
  | "legend-json-list"
  | "legend-json-set-rule"
  | "legend-json-estimate"
  | "legend-json-translate"
  | "legend-json-preview"
  | "legend-json-apply"
  | "legend-json-restore"
  | "legend-json-list-backups";

export type LegendJsonStatus =
  | "All"
  | "New"
  | "Translated"
  | "Needs review"
  | "Needs classification"
  | "Excluded"
  | "Orphan"
  | "Conflict";

export interface LegendJsonStatusCounts {
  New: number;
  Translated: number;
  "Needs review": number;
  "Needs classification": number;
  Excluded: number;
  Orphan: number;
  Conflict: number;
  total: number;
}

export interface LegendJsonEntry {
  sourceHash: string;
  source: string;
  target: string | null;
  status: Exclude<LegendJsonStatus, "All">;
  translationSource: "main" | "manual" | "model" | "runtime" | null;
  accepted: boolean;
  explicitUpdate: boolean;
  occurrenceCount: number;
  file: string | null;
  field: string | null;
}

export interface LegendJsonOccurrence {
  file: string;
  recordId: string | null;
  pointer: string;
  field: string;
  extractor: string;
  classification: "allow" | "exclude" | "classify";
  context: string;
  firstSeenScan: string;
  lastSeenScan: string;
}

export interface LegendJsonScanResult {
  scanId: string;
  fingerprint: string;
  sourceRoot: string;
  files: number;
  parsedFiles: number;
  reusedFiles: number;
  occurrencesParsed: number;
  mainEntriesImported: number;
  runtimeEntriesImported: number;
  stats: LegendJsonStatusCounts;
}

export interface LegendJsonListResult {
  scanId: string;
  fingerprint: string;
  offset: number;
  limit: number;
  total: number;
  items: LegendJsonEntry[];
  stats: LegendJsonStatusCounts;
}

export interface LegendJsonEntryDetail {
  scanId: string;
  fingerprint: string;
  entry: LegendJsonEntry;
  occurrences: LegendJsonOccurrence[];
}

export interface LegendJsonEstimate {
  scanId: string;
  fingerprint: string;
  items: number;
  characters: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTokens: number;
  estimatedBatches: number;
  estimatedApiCalls: number;
  estimatedCostUsd: number | null;
  pricingModel: string | null;
  pricingSource: string | null;
}

export interface LegendJsonQaIssue {
  severity: "error" | "warning";
  rule: string;
  detail: string;
  source?: string;
  sourceHash?: string;
}

export interface LegendJsonPreview {
  previewId: string;
  scanId: string;
  fingerprint: string;
  mainFingerprint: string;
  outputFingerprint: string;
  mainPath: string;
  changeCount: number;
  changes: Array<{
    kind: "append" | "update";
    sourceHash: string;
    source: string;
    before: string | null;
    after: string;
    line: number | null;
  }>;
  qa: {
    blocking: boolean;
    errors: number;
    warnings: number;
    issues: LegendJsonQaIssue[];
  };
}

export interface LegendJsonApplyResult {
  previewId: string;
  backupId: string;
  backupPath: string;
  manifestPath: string;
  outputPath: string;
  outputFingerprint: string;
  appliedCount: number;
  skippedCount: number;
  instruction: string;
}

export function legendJsonApplySkipSummary(
  preview: Pick<LegendJsonPreview, "changes" | "qa">,
): {
  errorHashCount: number;
  cleanChangeCount: number;
  canSkipApply: boolean;
} {
  const errorHashes = new Set(
    preview.qa.issues
      .filter((issue) => issue.severity === "error" && issue.sourceHash)
      .map((issue) => issue.sourceHash as string),
  );
  const cleanChangeCount = preview.changes.filter(
    (change) => !errorHashes.has(change.sourceHash),
  ).length;
  return {
    errorHashCount: errorHashes.size,
    cleanChangeCount,
    canSkipApply:
      preview.qa.blocking && errorHashes.size > 0 && cleanChangeCount > 0,
  };
}

export interface LegendJsonRestoreResult {
  backupId: string;
  outputPath: string;
  fingerprint: string;
  restored: boolean;
}

export interface LegendJsonBackup {
  id: string;
  createdAt: string;
  outputPath: string;
  backupPath: string;
  manifestPath: string;
  beforeFingerprint: string;
  appliedFingerprint: string;
  valid: boolean;
}

export interface LegendJsonBackupList {
  items: LegendJsonBackup[];
  total: number;
}

export interface LegendJsonPaths {
  sourceRoot: string;
  mainPath: string;
  runtimePath: string;
}

export function inferLegendJsonPaths(
  deployPath?: string | null,
): LegendJsonPaths {
  const raw = deployPath?.trim() ?? "";
  if (!raw) return { sourceRoot: "", mainPath: "", runtimePath: "" };
  const normalized = raw.replace(/\//g, "\\");
  const lower = normalized.toLocaleLowerCase("en-US");
  const fileName = lower.endsWith(".txt");
  const textDirectory = fileName
    ? normalized.slice(0, Math.max(normalized.lastIndexOf("\\"), 0))
    : normalized.replace(/\\+$/, "");
  const marker = lower.indexOf("\\bepinex\\");
  const gameRoot = marker >= 0 ? normalized.slice(0, marker) : "";
  return {
    sourceRoot: gameRoot
      ? `${gameRoot}\\ThreeKingdom_Data\\StreamingAssets\\Json`
      : "",
    mainPath: `${textDirectory}\\AutoGeneratedTranslations.txt`,
    runtimePath: `${textDirectory}\\_AutoGeneratedTranslations.txt`,
  };
}

export function isLegendJsonForceRestoreMessage(message: string): boolean {
  return (
    message.includes("cần xác nhận force") ||
    message.includes("đã thay đổi sau Apply")
  );
}

export function selectedHashesForRequest(
  selected: ReadonlySet<string>,
  selectAllMatching: boolean,
): string[] | undefined {
  return selectAllMatching ? undefined : [...selected];
}

export function buildLegendJsonListConfig(
  page: number,
  pageSize: number,
  status: LegendJsonStatus,
  search: string,
) {
  return {
    offset: Math.max(0, page - 1) * pageSize,
    limit: pageSize,
    status,
    search: search.trim(),
  };
}
