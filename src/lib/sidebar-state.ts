import type { AppView } from "@/lib/app-types"
import {
  getGameNavigationGroup,
  VIEW_LABELS,
  type GameNavigationId,
} from "@/lib/navigation"

export const SIDEBAR_STATE_STORAGE_KEY = "sidebar-ui-state"
const LEGACY_SIDEBAR_COOKIE_NAME = "sidebar_state"

export type SidebarUiState = {
  open: boolean
  view: AppView
  openGroups: Record<GameNavigationId, boolean>
}

export const DEFAULT_SIDEBAR_STATE: SidebarUiState = {
  open: true,
  view: "dashboard",
  openGroups: {
    civ7: true,
    legend: false,
  },
}

function isAppView(value: unknown): value is AppView {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VIEW_LABELS, value)
}

function readLegacySidebarCookie(): boolean | undefined {
  if (typeof document === "undefined") return undefined
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${LEGACY_SIDEBAR_COOKIE_NAME}=`))
  if (!match) return undefined
  const value = match.slice(`${LEGACY_SIDEBAR_COOKIE_NAME}=`.length)
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

function parseOpenGroups(
  value: unknown,
  view: AppView,
): Record<GameNavigationId, boolean> {
  const stored =
    value && typeof value === "object"
      ? (value as Partial<Record<GameNavigationId, unknown>>)
      : {}
  const activeGroupId = getGameNavigationGroup(view)?.id

  return {
    civ7:
      typeof stored.civ7 === "boolean" ? stored.civ7 : activeGroupId === "civ7",
    legend:
      typeof stored.legend === "boolean"
        ? stored.legend
        : activeGroupId === "legend",
  }
}

export function loadSidebarState(): SidebarUiState {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_STATE

  try {
    const raw = window.localStorage.getItem(SIDEBAR_STATE_STORAGE_KEY)
    if (!raw) {
      const cookieOpen = readLegacySidebarCookie()
      if (cookieOpen === undefined) return DEFAULT_SIDEBAR_STATE
      return { ...DEFAULT_SIDEBAR_STATE, open: cookieOpen }
    }

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return DEFAULT_SIDEBAR_STATE

    const record = parsed as Record<string, unknown>
    const view = isAppView(record.view) ? record.view : DEFAULT_SIDEBAR_STATE.view
    const open =
      typeof record.open === "boolean" ? record.open : DEFAULT_SIDEBAR_STATE.open

    return {
      open,
      view,
      openGroups: parseOpenGroups(record.openGroups, view),
    }
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

export function saveSidebarState(
  partial: Partial<SidebarUiState>,
): SidebarUiState {
  const current = loadSidebarState()
  const next: SidebarUiState = {
    open: partial.open ?? current.open,
    view: partial.view ?? current.view,
    openGroups: {
      ...current.openGroups,
      ...(partial.openGroups ?? {}),
    },
  }
  window.localStorage.setItem(SIDEBAR_STATE_STORAGE_KEY, JSON.stringify(next))
  return next
}
