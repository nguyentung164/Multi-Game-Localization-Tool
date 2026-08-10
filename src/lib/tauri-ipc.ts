import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type {
  ApiKeyMeta,
  AppConfig,
  AppState,
  GlossaryPayload,
  GlossarySaveResult,
  JobEventEnvelope,
  StepId,
  TagListResult,
  TagSearchResult,
  TagSearchScope,
  TagUpdateResult,
  TranslationCacheClearResult,
  TranslationCacheInfo,
} from "@/lib/app-types"
import { isDuplicateJobStartError } from "@/lib/job-start-lock"

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export function formatInvokeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return "Đã xảy ra lỗi không xác định."
}

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error(`Lệnh ${name} chỉ khả dụng trong ứng dụng desktop.`)
  }
  return invoke<T>(name, args)
}

export const ipc = {
  getState: () => command<AppState>("get_app_state"),
  saveConfig: (config: AppConfig) =>
    command<AppState>("save_app_config", { config }),
  validatePaths: (
    config: Pick<AppConfig, "gamePath" | "exportPath" | "modPath">,
  ) =>
    command<{ valid: boolean; errors: Record<string, string> }>(
      "validate_paths",
      { config },
    ),
  async startJob(
    step: StepId,
    mode: "run" | "dry-run" | "resume" = "run",
  ): Promise<{ jobId: string } | null> {
    try {
      return await command<{ jobId: string }>("start_job", { step, mode })
    } catch (error) {
      // Brute-force: any shape that mentions the concurrent-job message → silent null.
      const raw = [
        typeof error === "string" ? error : "",
        error instanceof Error ? error.message : "",
        (() => {
          try {
            return JSON.stringify(error)
          } catch {
            return String(error)
          }
        })(),
      ]
        .join("\n")
        .toLocaleLowerCase("vi-VN")
      if (
        isDuplicateJobStartError(error) ||
        raw.includes("job_already_running") ||
        raw.includes("một thời điểm")
      ) {
        return null
      }
      throw error
    }
  },
  cancelJob: (jobId: string) => command<void>("cancel_job", { jobId }),
  applySync: (previewId: string) =>
    command<{ jobId: string }>("apply_sync", { previewId }),
  openReport: (reportId: string, kind: "json" | "txt" | "folder" = "json") =>
    command<void>("open_report", { reportId, kind }),
  openReportsFolder: () => command<void>("open_reports_folder"),
  clearReports: () => command<AppState>("clear_reports"),
  clearJobEvents: (step: StepId) =>
    command<AppState>("clear_job_events", { step }),
  getTranslationCacheInfo: (
    paths?: Pick<AppConfig, "cachePath" | "reportPath">,
  ) =>
    command<TranslationCacheInfo>("get_translation_cache_info", {
      cachePath: paths?.cachePath,
      reportPath: paths?.reportPath,
    }),
  openTranslationCache: (paths?: Pick<AppConfig, "cachePath" | "reportPath">) =>
    command<void>("open_translation_cache", {
      cachePath: paths?.cachePath,
      reportPath: paths?.reportPath,
    }),
  clearTranslationCache: (
    paths?: Pick<AppConfig, "cachePath" | "reportPath">,
  ) =>
    command<TranslationCacheClearResult>("clear_translation_cache", {
      cachePath: paths?.cachePath,
      reportPath: paths?.reportPath,
    }),
  openFile: (path: string) => command<void>("open_file", { path }),
  restoreBackup: (backupId: string) =>
    command<AppState>("restore_backup", { backupId }),
  listBackupFiles: (backupId: string) =>
    command<string[]>("list_backup_files", { backupId }),
  openBackupFolder: (backupId: string) =>
    command<void>("open_backup_folder", { backupId }),
  deleteBackup: (backupId: string) =>
    command<AppState>("delete_backup", { backupId }),
  addApiKey: (label: string, secret: string) =>
    command<ApiKeyMeta>("add_api_key", { label, secret }),
  renameApiKey: (keyId: string, label: string) =>
    command<ApiKeyMeta>("rename_api_key", { keyId, label }),
  testApiKey: (keyId: string) => command<ApiKeyMeta>("test_api_key", { keyId }),
  setApiKeyEnabled: (keyId: string, enabled: boolean) =>
    command<ApiKeyMeta>("set_api_key_enabled", { keyId, enabled }),
  reorderApiKeys: (keyIds: string[]) =>
    command<ApiKeyMeta[]>("reorder_api_keys", { keyIds }),
  deleteApiKey: (keyId: string) => command<void>("delete_api_key", { keyId }),
  getGlossary: (glossaryPath?: string) =>
    command<GlossaryPayload>("get_glossary", { glossaryPath }),
  saveGlossary: (entries: Record<string, string>, glossaryPath?: string) =>
    command<GlossarySaveResult>("save_glossary", { entries, glossaryPath }),
  searchTags: (
    query: string,
    scope?: TagSearchScope,
    maxResults?: number,
    caseSensitive = false,
    wholeWord = false,
  ) =>
    command<TagSearchResult>("search_tags", {
      query,
      scope,
      maxResults,
      caseSensitive,
      wholeWord,
    }),
  listTags: (maxResults?: number) =>
    command<TagListResult>("list_tags", {
      maxResults: maxResults ?? 0,
    }),
  updateTag: (payload: {
    file: string
    tag: string
    entryType: string
    vietnamese: string
    timing?: string
  }) => command<TagUpdateResult>("update_tag", payload),
  async pickDirectory(defaultPath?: string) {
    if (!isTauriRuntime()) return null
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
    })
    return typeof selected === "string" ? selected : null
  },
  async pickFile(
    defaultPath?: string,
    filters?: { name: string; extensions: string[] }[],
  ) {
    if (!isTauriRuntime()) return null
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      directory: false,
      multiple: false,
      defaultPath,
      filters,
    })
    return typeof selected === "string" ? selected : null
  },
  async listenToJobEvents(
    handler: (event: JobEventEnvelope) => void,
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => undefined
    return listen<JobEventEnvelope>("job-event", ({ payload }) =>
      handler(payload),
    )
  },
}
