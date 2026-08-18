import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { resolvePageLoadingState, useAsyncTask } from "@/hooks/use-async-task"

vi.mock("@/lib/yield-to-main-thread", () => ({
  yieldToMainThread: vi.fn(async () => undefined),
}))

vi.mock("@/lib/sync-progress", () => ({
  listenToSyncProgress: vi.fn(async () => () => undefined),
  formatSyncProgressLabel: vi.fn(() => null),
  syncProgressPercent: vi.fn(() => null),
}))

describe("useAsyncTask", () => {
  it("sets loading while task runs then clears", async () => {
    const { result } = renderHook(() => useAsyncTask())

    await act(async () => {
      await result.current.run({
        title: "Đang tải…",
        task: async () => "done",
      })
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.title).toBe("Đang tải…")
  })

  it("applies renderResult via transition", async () => {
    const onSuccess = vi.fn()
    const { result } = renderHook(() => useAsyncTask())

    await act(async () => {
      await result.current.run({
        task: async () => 42,
        renderResult: onSuccess,
      })
    })

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(42)
    })
  })
})

describe("resolvePageLoadingState", () => {
  it("prioritizes sync overlay over local flags", () => {
    const state = resolvePageLoadingState({
      syncOverlay: {
        loading: true,
        title: "Đang kiểm tra file…",
        description: "Engine",
      },
      inspectRowsLoading: true,
      estimateLoading: true,
    })
    expect(state.loading).toBe(true)
    expect(state.title).toBe("Đang kiểm tra file…")
  })

  it("falls back to inspect rows then saving preview", () => {
    expect(
      resolvePageLoadingState({ inspectRowsLoading: true }).title,
    ).toBe("Đang tải dòng kiểm tra…")
    expect(
      resolvePageLoadingState({ savingPreview: true }).title,
    ).toBe("Đang lưu preview…")
  })
})
