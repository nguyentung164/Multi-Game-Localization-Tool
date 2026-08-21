import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildLegendJsonProgress,
  clearLegendJsonProgress,
  getLegendJsonProgressSnapshot,
  publishLegendJsonProgress,
  useLegendJsonProgress,
} from "@/lib/legend-json-progress-store"

describe("legend-json-progress-store", () => {
  afterEach(() => {
    clearLegendJsonProgress()
  })

  it("derives percent from processed/total", () => {
    expect(
      buildLegendJsonProgress({
        jobId: "job-1",
        processed: 25,
        total: 100,
      }).progress,
    ).toBe(25)
    expect(
      buildLegendJsonProgress({
        jobId: null,
        processed: 0,
        total: 0,
      }).progress,
    ).toBe(0)
  })

  it("dedups identical publishes and keeps the same snapshot", () => {
    const next = buildLegendJsonProgress({
      jobId: "job-1",
      processed: 4,
      total: 10,
      file: "Game.json",
    })
    publishLegendJsonProgress(next)
    const first = getLegendJsonProgressSnapshot()
    publishLegendJsonProgress({ ...next })
    expect(getLegendJsonProgressSnapshot()).toBe(first)
  })

  it("notifies useSyncExternalStore subscribers on change", () => {
    const { result } = renderHook(() => useLegendJsonProgress())
    expect(result.current).toBeNull()

    act(() => {
      publishLegendJsonProgress(
        buildLegendJsonProgress({
          jobId: "job-1",
          processed: 2,
          total: 8,
        }),
      )
    })

    expect(result.current?.processed).toBe(2)
    expect(result.current?.progress).toBe(25)

    act(() => {
      clearLegendJsonProgress()
    })
    expect(result.current).toBeNull()
  })
})
