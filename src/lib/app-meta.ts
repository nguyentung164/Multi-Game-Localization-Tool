export const APP_NAME = "Multi-Game Localization Tool"
export const APP_VERSION = "1.3.0"
export const APP_REPO_URL = "https://github.com/nguyentung164/Multi-Game-Localization-Tool"

export function formatAppVersionLabel(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) return `v${APP_VERSION}`
  return /^v/i.test(trimmed) ? `v${trimmed.slice(1)}` : `v${trimmed}`
}
