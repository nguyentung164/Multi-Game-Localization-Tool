import { afterEach, describe, expect, it } from "vitest"
import {
  GAME_ICONS_STORAGE_KEY,
  loadGameIcons,
  saveGameIcons,
  setGameIconDataUrl,
} from "@/lib/game-icons"

describe("game icons storage", () => {
  afterEach(() => {
    window.localStorage.removeItem(GAME_ICONS_STORAGE_KEY)
  })

  it("returns empty map when storage is missing", () => {
    expect(loadGameIcons()).toEqual({})
  })

  it("persists icon data urls by game id", () => {
    const dataUrl = "data:image/x-icon;base64,abc"
    setGameIconDataUrl("civ7", dataUrl)

    expect(loadGameIcons()).toEqual({ civ7: dataUrl })
  })

  it("ignores invalid stored json", () => {
    window.localStorage.setItem(GAME_ICONS_STORAGE_KEY, "{not-json")
    expect(loadGameIcons()).toEqual({})
  })

  it("replaces the full map when saving", () => {
    saveGameIcons({ legend: "data:image/x-icon;base64,xyz" })
    expect(loadGameIcons()).toEqual({ legend: "data:image/x-icon;base64,xyz" })
  })
})
