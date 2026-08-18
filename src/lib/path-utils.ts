import type { AppConfig, InspectDiff } from "@/lib/app-types"

/** Windows `canonicalize()` / dialog paths may start with `\\?\`. */
export function displayWindowsPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${trimmed.slice("\\\\?\\UNC\\".length)}`
  }
  if (trimmed.startsWith("\\\\?\\")) {
    return trimmed.slice("\\\\?\\".length)
  }
  return trimmed
}

/** Tên file hoặc segment cuối — dùng hiển thị progress thay vì full path. */
export function pathBasename(path: string): string {
  const normalized = displayWindowsPath(path).replace(/[/\\]+$/, "")
  const parts = normalized.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? normalized
}

export function joinRelativePath(basePath: string, relativeFile: string): string {
  const base = basePath.trim().replace(/[/\\]+$/, "")
  const file = relativeFile.replace(/^[/\\]+/, "").replace(/\//g, "\\")
  return `${base}\\${file}`
}

export function resolveModFilePath(modPath: string, relativeFile: string): string {
  return joinRelativePath(modPath, relativeFile)
}

export function resolveExportFilePath(exportPath: string, relativeFile: string): string {
  return joinRelativePath(exportPath, relativeFile)
}

export function resolveInspectFilePath(
  config: AppConfig,
  diff: Pick<InspectDiff, "file" | "status">,
): string | null {
  const base =
    diff.status === "english-only"
      ? config.exportPath.trim()
      : config.modPath.trim()
  if (!base || !diff.file.trim()) return null
  return joinRelativePath(base, diff.file)
}
