export type AppView =
  | "dashboard"
  | "pipeline"
  | "reports"
  | "search"
  | "glossary"
  | "settings"
  | "help"
  | "about"

export type StepId = "export" | "inspect" | "sync" | "translate" | "deploy"

export type StepStatus =
  "locked" | "ready" | "running" | "success" | "warning" | "failed" | "paused"

export type EventLevel = "info" | "success" | "warning" | "error"

export interface StepSummary {
  files?: number
  rows?: number
  changes?: number
  warnings?: number
  translated?: number
  skipped?: number
}

export interface PipelineStep {
  id: StepId
  title: string
  shortTitle: string
  description: string
  status: StepStatus
  lastRun?: string
  duration?: string
  lockedReason?: string
  summary: StepSummary
}

export interface JobEvent {
  id: string
  seq: number
  timestamp: string
  level: EventLevel
  title: string
  description: string
  step: StepId
  detail?: unknown
  count?: number
}

export interface ActiveJob {
  id: string
  step: StepId
  status: "running" | "paused" | "failed"
  startedAt: string
  elapsed: string
  eta?: string
  progress: number
  batchProgress: number
  currentFile: string
  processed: number
  total: number
  throughput: string
  model?: string
  keyId?: string
  keyIndex?: number
  isSavingCache?: boolean
}

export type KeyStatus =
  | "unknown"
  | "valid"
  | "active"
  | "rate-limited"
  | "quota-exhausted"
  | "invalid"

export interface ApiKeyMeta {
  id: string
  label: string
  maskedSuffix: string
  priority: number
  enabled: boolean
  status: KeyStatus
  lastUsed?: string
  localRequests: number
  activeSince?: string
}

export interface SyncChange {
  id: string
  kind: "add" | "delete" | "update" | "vtt" | "warning"
  file: string
  tag: string
  /** Nội dung từ engine: EN khi thêm, VH khi xóa. */
  text?: string
  before?: string
  after?: string
}

export interface DeployChange {
  id: string
  kind: "copy" | "create" | "skip" | "unchanged"
  file: string
}

export interface QaIssue {
  id: string
  severity: "warning" | "error"
  rule: string
  file: string
  tag: string
  source: string
  target: string
}

export interface Report {
  id: string
  step: StepId
  title: string
  status: StepStatus
  createdAt: string
  duration: string
  summary: string
}

export interface Backup {
  id: string
  createdAt: string
  step: StepId
  files: number
  size: string
  valid: boolean
}

export interface SyncPreviewInfo {
  fingerprint: string
  createdAt: string
}

export type InspectDiffStatus =
  "english-only" | "vietnamese-only" | "different" | "invalid"

export interface InspectInventoryStats {
  xmlFiles: number
  vttFiles: number
  rows: number
  replaces: number
  cues: number
  invalidCount: number
}

export interface InspectTagDelta {
  type?: string
  tag?: string
  timing?: string
  count: number
}

export interface InspectDiff {
  id: string
  file: string
  status: InspectDiffStatus
  missingInVietnamese?: InspectTagDelta[]
  extraInVietnamese?: InspectTagDelta[]
  error?: string
}

export interface InspectSnapshot {
  english?: InspectInventoryStats
  vietnamese?: InspectInventoryStats
  diffs: InspectDiff[]
  englishOnly: number
  vietnameseOnly: number
  differentFiles: number
}

export interface GlossaryPayload {
  path: string
  exists: boolean
  entries: Record<string, string>
}

export interface GlossarySaveResult {
  path: string
  entries: number
}

export type TagSearchScope = "all" | "tag" | "english" | "vietnamese" | "file"

export interface TagSearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

export interface TagSearchMatch {
  id: string
  file: string
  tag: string
  entryType: string
  english: string
  vietnamese: string
  timing?: string
}

export interface TagSearchResult {
  query: string
  scope: TagSearchScope
  scannedFiles: number
  totalMatches: number
  truncated: boolean
  matches: TagSearchMatch[]
}

export interface TagListResult {
  scannedFiles: number
  totalMatches: number
  truncated: boolean
  matches: TagSearchMatch[]
}

export interface TagUpdateResult {
  file: string
  tag: string
  entryType: string
  vietnamese: string
  timing?: string
}

export interface AppConfig {
  gamePath: string
  exportPath: string
  modPath: string
  reportPath: string
  cachePath: string
  glossaryPath: string
  model: string
  fallbackModels: string[]
  delayMs: number
  timeoutSeconds: number
  batchSize: number
  maxFiles: number
  maxApiCalls: number
  deployBackup: boolean
  deployOnlyExisting: boolean
  theme: "light" | "dark" | "system"
  notifications: {
    enabled: boolean
    completed: boolean
    paused: boolean
    failed: boolean
  }
}

export interface AppState {
  setupComplete: boolean
  steps: PipelineStep[]
  selectedStep: StepId
  activeJob: ActiveJob | null
  events: JobEvent[]
  apiKeys: ApiKeyMeta[]
  syncChanges: SyncChange[]
  deployChanges: DeployChange[]
  qaIssues: QaIssue[]
  reports: Report[]
  backups: Backup[]
  config: AppConfig
  syncPreview?: SyncPreviewInfo | null
  syncApplied?: boolean
  deployApplied?: boolean
  inspectSnapshot?: InspectSnapshot
}

export interface JobEventEnvelope {
  protocolVersion: number
  jobId: string
  seq: number
  step: StepId
  timestamp: string
  type:
    | "started"
    | "log"
    | "progress"
    | "warning"
    | "report"
    | "completed"
    | "failed"
    | "paused"
  payload: Record<string, unknown>
}

export interface TranslationCacheInfo {
  path: string
  exists: boolean
  entries: number
  sizeBytes: number
}

export interface TranslationCacheClearResult {
  path: string
  clearedEntries: number
}

export const STEP_ORDER: StepId[] = [
  "export",
  "inspect",
  "sync",
  "translate",
  "deploy",
]

export const STEP_LABELS: Record<StepId, string> = {
  export: "Export",
  inspect: "Kiểm tra & Thống kê",
  sync: "Đồng bộ",
  translate: "Dịch",
  deploy: "Deploy",
}
