import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  ReplaceTagsResult,
  TranslationCacheClearResult,
  TranslationCacheInfo,
} from "@/lib/app-types";
import type {
  LegendDedupeResult,
  LegendFileEntriesPage,
  LegendFileInspection,
  LegendBackup,
  LegendGlossaryDocument,
  LegendGlossaryEntry,
  LegendJobEvent,
  LegendPreviewDiffsPage,
  LegendPreviewEdit,
  LegendPreviewLineRef,
  LegendPreviewSummary,
  LegendLineEdit,
  LegendLineUpdateResult,
  LegendSearchResult,
  LegendSearchScope,
  LegendTranslationEstimate,
  LegendTranslationApplyResult,
  LegendTranslationPreview,
} from "@/lib/legend-types";
import type { ClassifiedDrop } from "@/hooks/use-file-drop";
import type { LegendJsonCommand } from "@/lib/legend-json-types";
import { isDuplicateJobStartError } from "@/lib/job-start-lock";
import { OPEN_APP_UPDATE_EVENT } from "@/lib/app-updater";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function formatInvokeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Đã xảy ra lỗi không xác định.";
}

export function invokeErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error(`Lệnh ${name} chỉ khả dụng trong ứng dụng desktop.`);
  }
  return invoke<T>(name, args);
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
      return await command<{ jobId: string }>("start_job", { step, mode });
    } catch (error) {
      // Brute-force: any shape that mentions the concurrent-job message → silent null.
      const raw = [
        typeof error === "string" ? error : "",
        error instanceof Error ? error.message : "",
        (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })(),
      ]
        .join("\n")
        .toLocaleLowerCase("vi-VN");
      if (
        isDuplicateJobStartError(error) ||
        raw.includes("job_already_running") ||
        raw.includes("một thời điểm")
      ) {
        return null;
      }
      throw error;
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
  getTranslationCacheInfo: () =>
    command<TranslationCacheInfo>("get_translation_cache_info"),
  openTranslationCache: () => command<void>("open_translation_cache"),
  clearTranslationCache: () =>
    command<TranslationCacheClearResult>("clear_translation_cache"),
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
    file: string;
    tag: string;
    entryType: string;
    vietnamese: string;
    timing?: string;
  }) => command<TagUpdateResult>("update_tag", payload),
  replaceTags: (
    query: string,
    replacement: string,
    caseSensitive = false,
    wholeWord = false,
  ) =>
    command<ReplaceTagsResult>("replace_tags", {
      query,
      replacement,
      caseSensitive,
      wholeWord,
    }),
  inspectLegendFile: (sourcePath: string) =>
    command<LegendFileInspection>("inspect_legend_file", {
      sourcePath,
    }),
  searchLegendFile: (
    query: string,
    scope?: LegendSearchScope,
    maxResults?: number,
    caseSensitive = false,
    wholeWord = false,
    sourcePath?: string,
  ) =>
    command<LegendSearchResult>("search_legend_file", {
      query,
      scope,
      maxResults,
      caseSensitive,
      wholeWord,
      sourcePath: sourcePath || null,
    }),
  updateLegendLines: (edits: LegendLineEdit[], sourcePath?: string) =>
    command<LegendLineUpdateResult>("update_legend_lines", {
      edits,
      sourcePath: sourcePath || null,
    }),
  listLegendFileEntries: (
    sourcePath: string,
    offset: number,
    limit: number,
    kind: "entry" | "invalid" | "duplicate" | "pending" | "all" = "entry",
  ) =>
    command<LegendFileEntriesPage>("list_legend_file_entries", {
      sourcePath,
      offset,
      limit,
      kind,
    }),
  dedupeLegendFile: (sourcePath: string) =>
    command<LegendDedupeResult>("dedupe_legend_file", {
      sourcePath,
    }),
  estimateLegendTranslation: (
    sourcePath: string,
    options?: { forceRetranslate?: boolean },
  ) =>
    command<LegendTranslationEstimate>("estimate_legend_translation", {
      sourcePath,
      mode: "full",
      trialLimit: null,
      forceRetranslate: options?.forceRetranslate ?? false,
    }),
  getLegendGlossary: (path?: string) =>
    command<LegendGlossaryDocument>("get_legend_glossary", {
      path: path || null,
    }),
  saveLegendGlossary: (
    entries: LegendGlossaryEntry[],
    path?: string,
    setActive = true,
  ) =>
    command<LegendGlossaryDocument>("save_legend_glossary", {
      entries,
      path: path || null,
      setActive,
    }),
  exportLegendGlossary: (
    entries: LegendGlossaryEntry[],
    path: string,
    format: "v2" | "flat",
  ) =>
    command<void>("export_legend_glossary", {
      entries,
      path,
      format,
    }),
  startLegendTranslation: (
    sourcePath: string,
    options?: { forceRetranslate?: boolean; lineNumbers?: number[] },
  ) =>
    command<{ jobId: string }>("start_legend_translation", {
      sourcePath,
      mode: "full",
      trialLimit: null,
      forceRetranslate: options?.forceRetranslate ?? false,
      lineNumbers: options?.lineNumbers?.length ? options.lineNumbers : null,
    }),
  getLegendTranslationPreview: () =>
    command<LegendTranslationPreview | null>("get_legend_translation_preview", {
      mode: "full",
    }),
  listLegendPreviewDiffs: (
    filter: "all" | "han" | "error" | "warning" = "all",
    offset = 0,
    limit = 25,
    lineFilter?: string | null,
    includeLineRefs = false,
  ) =>
    command<LegendPreviewDiffsPage>("list_legend_preview_diffs", {
      filter,
      offset,
      limit,
      lineFilter: lineFilter?.trim() ? lineFilter : null,
      includeLineRefs,
    }),
  listLegendPreviewHanLines: () =>
    command<number[]>("list_legend_preview_han_lines"),
  listLegendPreviewLineRefs: (
    filter: "all" | "han" | "error" | "warning" = "all",
    lineFilter?: string | null,
  ) =>
    command<LegendPreviewLineRef[]>("list_legend_preview_line_refs", {
      filter,
      lineFilter: lineFilter?.trim() ? lineFilter : null,
    }),
  listLegendPreviews: () =>
    command<LegendPreviewSummary[]>("list_legend_previews", { mode: "full" }),
  adoptLegendPreviewFromPath: (previewPath: string) =>
    command<LegendTranslationPreview>("adopt_legend_preview_from_path", {
      previewPath,
      mode: "full",
    }),
  getLegendSourcePath: () => command<string | null>("get_legend_source_path"),
  getLegendDeployPath: () => command<string | null>("get_legend_deploy_path"),
  setLegendDeployPath: (deployPath: string) =>
    command<string | null>("set_legend_deploy_path", { deployPath }),
  applyLegendTranslation: (previewId: string) =>
    command<LegendTranslationApplyResult>("apply_legend_translation", {
      previewId,
    }),
  updateLegendTranslationPreview: (
    previewId: string,
    edits: LegendPreviewEdit[],
  ) =>
    command<LegendTranslationPreview>("update_legend_translation_preview", {
      previewId,
      edits,
    }),
  retranslateLegendPreview: (previewId: string, lineNumbers: number[]) =>
    command<LegendTranslationPreview>("retranslate_legend_preview", {
      previewId,
      lineNumbers,
    }),
  listLegendBackups: () => command<LegendBackup[]>("list_legend_backups"),
  restoreLegendBackup: (backupId: string, force = false) =>
    command<string>("restore_legend_backup", { backupId, force }),
  deleteLegendBackup: (backupId: string) =>
    command<void>("delete_legend_backup", { backupId }),
  openLegendBackupFolder: (backupId: string) =>
    command<void>("open_legend_backup_folder", { backupId }),
  runLegendJsonCommand: <T>(
    legendCommand: LegendJsonCommand,
    config: Record<string, unknown>,
  ) =>
    command<T>("run_legend_json_command", {
      command: legendCommand,
      config,
    }),
  async pickDirectory(defaultPath?: string) {
    if (!isTauriRuntime()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
    });
    return typeof selected === "string" ? selected : null;
  },
  async pickFile(
    defaultPath?: string,
    filters?: { name: string; extensions: string[] }[],
  ) {
    if (!isTauriRuntime()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: false,
      defaultPath,
      filters,
    });
    return typeof selected === "string" ? selected : null;
  },
  async pickSaveFile(
    defaultPath?: string,
    filters?: { name: string; extensions: string[] }[],
  ) {
    if (!isTauriRuntime()) return null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({ defaultPath, filters });
    return typeof selected === "string" ? selected : null;
  },
  async listenToJobEvents(
    handler: (event: JobEventEnvelope) => void,
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => undefined;
    return listen<JobEventEnvelope>("job-event", ({ payload }) =>
      handler(payload),
    );
  },
  async listenToLegendJobEvents(
    handler: (event: LegendJobEvent) => void,
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => undefined;
    return listen<LegendJobEvent>("legend-job-event", ({ payload }) =>
      handler(payload),
    );
  },
  takePendingLaunchFile: () =>
    command<string | null>("take_pending_launch_file"),
  classifyDroppedPath: (path: string) =>
    command<ClassifiedDrop>("classify_dropped_path", { path }),
  shutdownRuntime: () => command<void>("shutdown_runtime"),
  checkAppUpdate: (timeout?: number) =>
    command<{
      rid: number;
      currentVersion: string;
      version: string;
      date?: string;
      body?: string;
      rawJson: Record<string, unknown>;
    } | null>("check_app_update", { timeout }),
  async listenToOpenLegendFile(
    handler: (path: string) => void,
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => undefined;
    return listen<string>("open-legend-file", ({ payload }) =>
      handler(payload),
    );
  },
  async listenToOpenAppUpdate(handler: () => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => undefined;
    return listen(OPEN_APP_UPDATE_EVENT, () => handler());
  },
};
