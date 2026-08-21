import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { ProgressBarStatus } from "@tauri-apps/api/window"
import { readFileSync } from "node:fs"
import path from "node:path"
import { resolveTaskbarState, useTaskbarProgress } from "@/hooks/use-taskbar-progress"
import {
  buildLegendJsonProgress,
  clearLegendJsonProgress,
  publishLegendJsonProgress,
} from "@/lib/legend-json-progress-store"

const mocks = vi.hoisted(() => ({
  setProgressBar: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@tauri-apps/api/window", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/window")>()
  return {
    ...actual,
    getCurrentWindow: () => ({
      setProgressBar: mocks.setProgressBar,
    }),
  }
})

describe("resolveTaskbarState", () => {
  it("returns None when idle", () => {
    expect(
      resolveTaskbarState({
        civ7Running: false,
        legendPhase: "idle",
      }),
    ).toEqual({ status: ProgressBarStatus.None })
  })

  it("returns None for paused, failed, or error phases", () => {
    expect(
      resolveTaskbarState({
        civ7Running: false,
        legendPhase: "error",
      }),
    ).toEqual({ status: ProgressBarStatus.None })

    expect(
      resolveTaskbarState({
        civ7Running: false,
        legendPhase: "starting",
      }),
    ).toEqual({ status: ProgressBarStatus.None })
  })

  it("returns Normal progress only while running", () => {
    expect(
      resolveTaskbarState({
        civ7Running: true,
        civ7Progress: 42.6,
      }),
    ).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 43,
    })

    expect(
      resolveTaskbarState({
        legendPhase: "running",
        legendProgress: 12,
      }),
    ).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 12,
    })
  })

  it("returns Legend JSON progress when that job is running", () => {
    expect(
      resolveTaskbarState({
        legendJsonRunning: true,
        legendJsonProgress: 37.4,
      }),
    ).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 37,
    })
  })

  it("prefers CIV7, then Legend TK, then Legend JSON", () => {
    expect(
      resolveTaskbarState({
        civ7Running: true,
        civ7Progress: 10,
        legendPhase: "running",
        legendProgress: 20,
        legendJsonRunning: true,
        legendJsonProgress: 30,
      }),
    ).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 10,
    })

    expect(
      resolveTaskbarState({
        legendPhase: "running",
        legendProgress: 20,
        legendJsonRunning: true,
        legendJsonProgress: 30,
      }),
    ).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 20,
    })
  })
})

describe("useTaskbarProgress", () => {
  beforeEach(() => {
    mocks.setProgressBar.mockClear()
    window.__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    clearLegendJsonProgress()
    delete window.__TAURI_INTERNALS__
  })

  it("reads Legend JSON progress from the store", async () => {
    renderHook(() => useTaskbarProgress({ legendJsonRunning: true }))

    await waitFor(() => {
      expect(mocks.setProgressBar).toHaveBeenCalled()
    })

    act(() => {
      publishLegendJsonProgress(
        buildLegendJsonProgress({
          jobId: "json-job",
          processed: 37,
          total: 100,
        }),
      )
    })

    await waitFor(() => {
      expect(mocks.setProgressBar).toHaveBeenCalledWith({
        status: ProgressBarStatus.Normal,
        progress: 37,
      })
    })
  })
})

describe("JSON progress isolation", () => {
  it("does not subscribe to JSON progress from App", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../App.tsx"),
      "utf8",
    )
    expect(source).not.toMatch(/useLegendJsonProgress/)
  })
})
