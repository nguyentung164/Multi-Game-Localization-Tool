import type { AppConfig, InspectDiff } from "@/lib/app-types"

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
