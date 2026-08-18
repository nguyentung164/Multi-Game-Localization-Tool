export type LegendJobEventType =
  | "started"
  | "log"
  | "progress"
  | "warning"
  | "result"
  | "completed"
  | "failed"
  | "paused"

export type LegendFileEntryKind = "entry" | "invalid" | "duplicate" | "pending" | "done"

export interface LegendFileEntry {
  lineNumber: number
  source: string
  currentTarget: string
  kind?: LegendFileEntryKind | string
  warning?: string
  occurrence?: number
}

export interface LegendFileEntriesPage {
  sourcePath: string
  offset: number
  limit: number
  total: number
  entryTotal?: number
  invalidTotal?: number
  duplicateTotal?: number
  pendingTotal?: number
  doneTotal?: number
  warningReasons?: string[]
  entries: LegendFileEntry[]
}

export interface LegendFileInspection {
  sourcePath: string
  fingerprint: string
  totalLines: number
  entryCount: number
  invalidLines: number
  duplicateSources: number
  uniqueSourceCount: number
  syntaxSourceCount: number
  pendingEntries?: number
  doneEntries?: number
  doneItems?: number
  reusedItems?: number
  pendingItems?: number
  encoding: string
  newline: "crlf" | "lf" | "mixed" | string
  hasBom: boolean
  sample: LegendFileEntry[]
  warnings: string[]
}

export interface LegendTranslationDiff {
  lineNumber: number
  source: string
  before: string
  after: string
  effectiveTarget: string
  effectiveAfter: string
  selected: boolean
  editedAfter?: string
  status: "pending" | "accepted" | "rejected" | "edited"
}

export type LegendTranslationMode = "full" | "trial"

export interface LegendPreviewDiffsPage {
  previewId: string
  filter: string
  offset: number
  limit: number
  total: number
  selectedTotal: number
  hanTotal: number
  errorTotal: number
  warningTotal: number
  entries: LegendTranslationDiff[]
  issues: LegendQaIssue[]
  lineRefs?: LegendPreviewLineRef[]
}

export interface LegendPreviewLineRef {
  lineNumber: number
  selected: boolean
  error: boolean
}

export interface LegendTranslationEstimate {
  items: number
  doneItems?: number
  reusedItems?: number
  cachedItems: number
  lockedItems: number
  pendingItems: number
  /** Unique sources that incremental translate will process (reuse + locked + cache + API). */
  actionableItems?: number
  workersUsed?: number
  spareKeys?: number
  estimatedBatches: number
  estimatedApiCalls: number
  estimatedSecondsMin: number
  estimatedSecondsMax: number
}

export interface LegendTermSuggestion {
  source: string
  reading: string
  replace?: string
}

export interface LegendQaIssue {
  id: string
  severity: "error" | "warning"
  rule: string
  lineNumber: number
  source: string
  before: string
  after: string
  detail: string
  suggestions?: LegendTermSuggestion[]
}

export interface LegendQaReport {
  passed: boolean
  blocking: boolean
  revision: number
  errors: number
  warnings: number
  issues: LegendQaIssue[]
}

export interface LegendRuleStat {
  rule: string
  count: number
}

export interface LegendTranslationStats {
  itemsTotal: number
  itemsTranslated: number
  cacheHits: number
  apiCalls: number
  keysUsed?: number
  modelSwitches?: number
  qaPassedFirstPass?: boolean
  qaBlockingCount?: number
  qaIssueCount?: number
  retryPassesUsed?: number
  retranslatedSources?: number
  topFailedRules?: LegendRuleStat[]
  topIssueRules?: LegendRuleStat[]
}

export interface LegendPreviewSummary {
  previewPath: string
  previewId: string
  createdAt: string
  mode: LegendTranslationMode
  revision: number
  changedLines: number
  sourcePath: string
}

export interface LegendTranslationPreview {
  previewId: string
  sourcePath: string
  sourceFingerprint: string
  createdAt: string
  revision: number
  mode: LegendTranslationMode
  glossaryHash?: string
  qaStaleReason?: string
  coverageTranslated: number
  coverageTotal: number
  diffs: LegendTranslationDiff[]
  diffCount?: number
  selectedCount?: number
  hanCount?: number
  errorCount?: number
  warningCount?: number
  stats: LegendTranslationStats
  qa: LegendQaReport
  warnings: string[]
}

export interface LegendPreviewEdit {
  lineNumber: number
  selected: boolean
  editedAfter?: string
}

export interface LegendGlossaryEntry {
  source: string
  target: string
  locked: boolean
  note: string
}

export interface LegendGlossaryDocument {
  version: 2
  profileId: string
  path: string
  entries: LegendGlossaryEntry[]
}

export type LegendSearchScope = "all" | "chinese" | "vietnamese" | "line"

export interface LegendSearchMatch {
  id: string
  lineNumber: number
  source: string
  currentTarget: string
}

export interface LegendSearchResult {
  query: string
  scope: LegendSearchScope
  sourcePath: string
  scannedLines: number
  totalMatches: number
  truncated: boolean
  matches: LegendSearchMatch[]
}

export interface LegendLineEdit {
  lineNumber: number
  currentTarget: string
}

export interface LegendLineUpdateResult {
  sourcePath: string
  updatedLines: number
}

export interface LegendBackup {
  id: string
  createdAt: string
  sourcePath: string
  backupPath: string
  sourceFingerprint: string
  appliedFingerprint: string
  valid: boolean
  safety: boolean
}

export interface LegendDedupeResult {
  sourcePath: string
  removed: number
  remainingEntries: number
  backupPath?: string
}

export interface LegendTranslationApplyResult {
  previewId: string
  sourcePath: string
  backupPath: string
  updatedLines: number
  deployPath?: string
  deployBackupPath?: string
}

export interface LegendJobEvent {
  protocolVersion: number
  jobId: string
  seq: number
  timestamp: string
  type: LegendJobEventType
  payload: Record<string, unknown>
}
