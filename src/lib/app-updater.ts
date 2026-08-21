import { formatDateTime } from "@/lib/format-date";

export const AUTO_CHECK_STORAGE_KEY = "app-updater-auto-check";
export const DISMISSED_VERSION_STORAGE_KEY = "app-updater-dismissed-version";
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;
export const OPEN_APP_UPDATE_EVENT = "open-app-update";
export const UPDATE_JOB_RUNNING_MESSAGE =
  "Đang có tác vụ chạy. Cài cập nhật sau khi job kết thúc.";
export const UPDATE_RUNTIME_SHUTDOWN_HINT =
  "Engine dịch đã tắt. Hãy khởi động lại app trước khi dịch tiếp.";
export const UPDATE_RESTART_REQUIRED_MESSAGE =
  "Đã cài bản mới. Hãy thoát app rồi mở lại.";
export const UPDATE_HANDLE_RESTORING_MESSAGE =
  "Đang chuẩn bị lại bản cập nhật…";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "restartRequired"
  | "error";

export type AvailableAppUpdate = {
  version: string;
  currentVersion: string;
  body: string;
  date?: string;
  detectedAtMs: number;
};

export type DownloadProgress = {
  downloaded: number;
  contentLength: number | null;
  percent: number | null;
};

export type DownloadProgressEvent = {
  event: "Started" | "Progress" | "Finished";
  data?: {
    contentLength?: number;
    chunkLength?: number;
  };
};

export const EMPTY_DOWNLOAD_PROGRESS: DownloadProgress = {
  downloaded: 0,
  contentLength: null,
  percent: null,
};

export type ParsedVersion = {
  core: [number, number, number];
  pre: Array<number | string> | null;
};

export function parseVersion(version: string): ParsedVersion {
  const cleaned = version.trim().replace(/^v/i, "");
  const noBuild = cleaned.split("+")[0] ?? cleaned;
  const dash = noBuild.indexOf("-");
  const corePart = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const prePart = dash === -1 ? "" : noBuild.slice(dash + 1);
  const parts = corePart.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  const pre = prePart
    ? prePart.split(".").map((identifier) =>
        /^\d+$/.test(identifier)
          ? Number.parseInt(identifier, 10)
          : identifier,
      )
    : null;
  return {
    core: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
    pre,
  };
}

export function parseVersionParts(version: string): [number, number, number] {
  return parseVersion(version).core;
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1;
    }
  }
  if (leftVersion.pre === null && rightVersion.pre === null) return 0;
  if (leftVersion.pre === null) return 1;
  if (rightVersion.pre === null) return -1;
  const count = Math.max(leftVersion.pre.length, rightVersion.pre.length);
  for (let index = 0; index < count; index += 1) {
    if (index >= leftVersion.pre.length) return -1;
    if (index >= rightVersion.pre.length) return 1;
    const leftId = leftVersion.pre[index];
    const rightId = rightVersion.pre[index];
    if (leftId === rightId) continue;
    if (typeof leftId === "number" && typeof rightId === "number") {
      return leftId > rightId ? 1 : -1;
    }
    if (typeof leftId === "number") return -1;
    if (typeof rightId === "number") return 1;
    return leftId > rightId ? 1 : -1;
  }
  return 0;
}

export function shouldAutoCheck(input: {
  isTauri: boolean;
  isDev: boolean;
  autoCheckEnabled: boolean;
}): boolean {
  return input.isTauri && !input.isDev && input.autoCheckEnabled;
}

export function shouldPrompt(input: {
  currentVersion: string;
  latestVersion: string | null | undefined;
  dismissedVersion: string | null | undefined;
}): boolean {
  const latest = input.latestVersion?.trim();
  if (!latest) return false;
  if (compareVersions(latest, input.currentVersion) <= 0) return false;
  const dismissed = input.dismissedVersion?.trim();
  if (dismissed && compareVersions(dismissed, latest) >= 0) return false;
  return true;
}

export function loadAutoCheckEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(AUTO_CHECK_STORAGE_KEY);
    return stored !== "0";
  } catch {
    return true;
  }
}

export function saveAutoCheckEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTO_CHECK_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}

export function loadDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY);
    return stored?.trim() || null;
  } catch {
    return null;
  }
}

export function saveDismissedVersion(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSED_VERSION_STORAGE_KEY, version);
  } catch {
    /* ignore quota / private mode */
  }
}

export function applyDownloadEvent(
  current: DownloadProgress,
  event: DownloadProgressEvent,
): DownloadProgress {
  if (event.event === "Started") {
    const contentLength = event.data?.contentLength ?? null;
    return {
      downloaded: 0,
      contentLength,
      percent: contentLength && contentLength > 0 ? 0 : null,
    };
  }
  if (event.event === "Progress") {
    const downloaded = current.downloaded + (event.data?.chunkLength ?? 0);
    const contentLength = current.contentLength;
    return {
      downloaded,
      contentLength,
      percent:
        contentLength && contentLength > 0
          ? Math.min(100, Math.round((downloaded / contentLength) * 100))
          : null,
    };
  }
  if (event.event === "Finished") {
    return {
      downloaded: current.contentLength ?? current.downloaded,
      contentLength: current.contentLength,
      percent: current.contentLength ? 100 : current.percent,
    };
  }
  return current;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDownloadProgress(progress: DownloadProgress): string {
  const downloaded = formatByteSize(progress.downloaded);
  if (progress.contentLength && progress.contentLength > 0) {
    return `${downloaded} / ${formatByteSize(progress.contentLength)}`;
  }
  return downloaded;
}

export function formatUpdateDate(date?: string | null): string {
  const trimmed = date?.trim();
  if (!trimmed) return "";
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  return formatDateTime(parsed);
}

/** Esc khi đang job → hiện lại lúc rảnh. Để sau / Esc lúc rảnh → không tự hiện. */
export function shouldSuppressUpdateAutoPrompt(input: {
  dismissed: boolean;
  busy: boolean;
}): boolean {
  return input.dismissed || !input.busy;
}

export function updaterErrorNotificationTitle(hasAvailableUpdate: boolean): string {
  return hasAvailableUpdate
    ? "Không cài được bản cập nhật"
    : "Không kiểm tra được bản cập nhật";
}

export function updaterStatusLabel(input: {
  status: UpdaterStatus;
  availableVersion?: string | null;
  error?: string | null;
  restoringHandle?: boolean;
}): string {
  if (input.restoringHandle) return UPDATE_HANDLE_RESTORING_MESSAGE;
  switch (input.status) {
    case "checking":
      return "Đang kiểm tra bản cập nhật…";
    case "upToDate":
      return "Đang dùng phiên bản mới nhất";
    case "available":
      return input.availableVersion
        ? `Có bản ${input.availableVersion}`
        : "Có bản cập nhật mới";
    case "downloading":
      return "Đang tải bản cập nhật…";
    case "installing":
      return "Đang cài đặt…";
    case "restartRequired":
      return UPDATE_RESTART_REQUIRED_MESSAGE;
    case "error":
      return input.error?.trim() || updaterErrorNotificationTitle(Boolean(input.availableVersion));
    default:
      return "Kiểm tra GitHub Releases khi cần";
  }
}
