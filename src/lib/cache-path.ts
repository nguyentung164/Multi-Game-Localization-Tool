import type { AppConfig } from "@/lib/app-types"

export const CACHE_FILENAME = "translation_cache_gemini.json"
const REPORTS_DIR = "translation_reports"

/** Mirror logic Rust `AppConfig::resolved_cache_path` for UI hints. */
export function resolveCachePath(config: AppConfig): string {
  const manual = config.cachePath.trim()
  if (manual) return manual

  const report = config.reportPath.trim()
  if (!report) return ""

  const nested = `${report}\\${REPORTS_DIR}\\${CACHE_FILENAME}`
  const flat = `${report}\\${CACHE_FILENAME}`
  const insideReports = report
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop()
    ?.toLowerCase() === REPORTS_DIR

  return insideReports ? flat : nested
}
