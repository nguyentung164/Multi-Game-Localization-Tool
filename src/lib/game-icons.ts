import type { GameNavigationId } from "@/lib/navigation"

export const GAME_ICONS_STORAGE_KEY = "multi-game-nav-icons"

export type GameIconMap = Partial<Record<GameNavigationId, string>>

export function loadGameIcons(): GameIconMap {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(GAME_ICONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as GameIconMap
  } catch {
    return {}
  }
}

export function saveGameIcons(icons: GameIconMap) {
  window.localStorage.setItem(GAME_ICONS_STORAGE_KEY, JSON.stringify(icons))
}

export function setGameIconDataUrl(
  gameId: GameNavigationId,
  dataUrl: string,
): GameIconMap {
  const next = { ...loadGameIcons(), [gameId]: dataUrl }
  saveGameIcons(next)
  return next
}
