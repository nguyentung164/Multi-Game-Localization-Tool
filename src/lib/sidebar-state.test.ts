import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SIDEBAR_STATE,
  loadSidebarState,
  saveSidebarState,
  SIDEBAR_STATE_STORAGE_KEY,
} from "@/lib/sidebar-state"

describe("sidebar state storage", () => {
  afterEach(() => {
    window.localStorage.removeItem(SIDEBAR_STATE_STORAGE_KEY)
    document.cookie = "sidebar_state=; path=/; max-age=0"
  })

  it("returns defaults when storage is missing", () => {
    expect(loadSidebarState()).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  it("persists sidebar open, view, and open groups", () => {
    saveSidebarState({
      open: false,
      view: "legend-three-kingdoms",
      openGroups: { civ7: false, legend: true },
    })

    expect(loadSidebarState()).toEqual({
      open: false,
      view: "legend-three-kingdoms",
      openGroups: { civ7: false, legend: true },
    })
  })

  it("merges partial updates", () => {
    saveSidebarState({
      open: false,
      view: "pipeline",
      openGroups: { civ7: true, legend: true },
    })
    saveSidebarState({ view: "legend-glossary" })

    expect(loadSidebarState()).toEqual({
      open: false,
      view: "legend-glossary",
      openGroups: { civ7: true, legend: true },
    })
  })

  it("ignores invalid stored json", () => {
    window.localStorage.setItem(SIDEBAR_STATE_STORAGE_KEY, "{not-json")
    expect(loadSidebarState()).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  it("falls back when view or group flags are invalid", () => {
    window.localStorage.setItem(
      SIDEBAR_STATE_STORAGE_KEY,
      JSON.stringify({
        open: "yes",
        view: "unknown-page",
        openGroups: { civ7: "open", legend: true },
      }),
    )

    expect(loadSidebarState()).toEqual({
      open: true,
      view: "dashboard",
      openGroups: { civ7: true, legend: true },
    })
  })

  it("reads the legacy sidebar cookie when localStorage is empty", () => {
    document.cookie = "sidebar_state=false; path=/"
    expect(loadSidebarState().open).toBe(false)
  })
})
