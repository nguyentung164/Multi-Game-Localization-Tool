import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { useLegendJsonPipeline } from "@/hooks/use-legend-json-pipeline"
import {
  clearLegendJsonProgress,
  getLegendJsonProgressSnapshot,
} from "@/lib/legend-json-progress-store"
import type { LegendJsonListResult } from "@/lib/legend-json-types"
import type { LegendJobEvent } from "@/lib/legend-types"

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  legendEventHandler: null as ((event: LegendJobEvent) => void) | null,
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("@/lib/tauri-ipc", () => ({
  formatInvokeError: (error: unknown) => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    return String(error);
  },
  invokeErrorCode: (error: unknown) =>
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null,
  ipc: {
    getLegendDeployPath: vi.fn().mockResolvedValue(null),
    runLegendJsonCommand: mocks.run,
    listenToLegendJobEvents: vi.fn().mockImplementation((handler) => {
      mocks.legendEventHandler = handler
      return Promise.resolve(() => undefined)
    }),
    cancelJob: mocks.cancel,
  },
}))

function listPage(status: string = "New"): LegendJsonListResult {
  return {
    scanId: "scan-1",
    fingerprint: "fingerprint",
    offset: 0,
    limit: 50,
    total: 1,
    items: [
      {
        sourceHash: "hash-0",
        source: "原文 0",
        target: status === "Translated" ? "Bản dịch 0" : null,
        status: status === "Translated" ? "Translated" : "New",
        translationSource: status === "Translated" ? "model" : null,
        accepted: status === "Translated",
        explicitUpdate: false,
        occurrenceCount: 1,
        file: "Game.json",
        field: "dialog",
      },
    ],
    stats: {
      New: status === "Translated" ? 0 : 1,
      Translated: status === "Translated" ? 1 : 0,
      "Needs review": 0,
      "Needs classification": 0,
      Excluded: 0,
      Orphan: 0,
      Conflict: 0,
      total: 1,
    },
  }
}

function jobEvent(
  type: LegendJobEvent["type"],
  payload: Record<string, unknown>,
): LegendJobEvent {
  return {
    protocolVersion: 1,
    jobId: "legend-json-job",
    seq: 1,
    timestamp: "2026-08-21T00:00:00.000Z",
    type,
    payload,
  }
}

function listCallCount() {
  return mocks.run.mock.calls.filter(([command]) => command === "legend-json-list")
    .length
}

describe("useLegendJsonPipeline", () => {
  afterEach(() => {
    clearLegendJsonProgress()
  })

  beforeEach(() => {
    mocks.run.mockReset()
    mocks.cancel.mockReset().mockResolvedValue(undefined)
    mocks.legendEventHandler = null
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.info).mockClear()
    mocks.run.mockImplementation(
      (command: string, config: Record<string, unknown>) => {
        if (command === "legend-json-list") {
          return Promise.resolve(
            listPage(typeof config.status === "string" ? config.status : "New"),
          )
        }
        if (command === "legend-json-list-backups") {
          return Promise.resolve({ items: [], total: 0 })
        }
        if (command === "legend-json-translate") {
          return new Promise(() => undefined)
        }
        return Promise.resolve({})
      },
    )
  })

  it("does not list until the page becomes active, then lists once", async () => {
    const { result, rerender } = renderHook(
      ({ active }) => useLegendJsonPipeline(active),
      { initialProps: { active: false } },
    )
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    expect(listCallCount()).toBe(0)
    expect(result.current.ready).toBe(false)

    rerender({ active: true })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(listCallCount()).toBe(1)

    rerender({ active: false })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    expect(listCallCount()).toBe(1)
    expect(result.current.status).toBe("New")
  })

  it("ignores stale list responses when filters change", async () => {
    let releaseNew: ((value: LegendJsonListResult) => void) | undefined
    mocks.run.mockImplementation(
      (command: string, config: Record<string, unknown>) => {
        if (command === "legend-json-list-backups") {
          return Promise.resolve({ items: [], total: 0 })
        }
        if (command !== "legend-json-list") return Promise.resolve({})
        if (config.status === "Translated") {
          return Promise.resolve(listPage("Translated"))
        }
        return new Promise((resolve) => {
          releaseNew = resolve
        })
      },
    )

    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(releaseNew).toBeTypeOf("function"))

    act(() => {
      result.current.changeStatusFilter("Translated")
    })
    await waitFor(() =>
      expect(result.current.data?.stats.Translated).toBe(1),
    )

    act(() => {
      releaseNew?.(listPage("New"))
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10))
    })
    expect(result.current.data?.stats.Translated).toBe(1)
    expect(result.current.status).toBe("Translated")
  })

  it("routes progress ticks to the store after translate starts", async () => {
    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))
    const data = result.current.data

    await act(async () => {
      void result.current.handleTranslate()
    })
    await waitFor(() => expect(result.current.isJobActive).toBe(true))

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("progress", {
          command: "legend-json-translate",
          processed: 10,
          total: 60,
        }),
      )
    })
    expect(result.current.jobId).toBe("legend-json-job")
    expect(result.current.data).toBe(data)
    expect(getLegendJsonProgressSnapshot()?.processed).toBe(10)

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("progress", {
          command: "legend-json-translate",
          processed: 20,
          total: 60,
        }),
      )
    })
    expect(result.current.data).toBe(data)
    expect(getLegendJsonProgressSnapshot()?.processed).toBe(20)
  })

  it("sets jobId on started and ignores late progress after completed", async () => {
    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("started", { command: "legend-json-translate" }),
      )
    })
    expect(result.current.jobId).toBe("legend-json-job")

    await act(async () => {
      void result.current.handleTranslate()
    })
    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("progress", {
          command: "legend-json-translate",
          processed: 10,
          total: 60,
        }),
      )
    })
    expect(getLegendJsonProgressSnapshot()?.processed).toBe(10)

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("completed", {
          command: "legend-json-translate",
          title: "Hoàn tất dịch JSON",
        }),
      )
    })
    expect(getLegendJsonProgressSnapshot()).toBeNull()

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("progress", {
          command: "legend-json-translate",
          processed: 40,
          total: 60,
        }),
      )
    })
    expect(getLegendJsonProgressSnapshot()).toBeNull()
  })

  it("cancels the active job and does not toast error on cancelled translate", async () => {
    mocks.run.mockImplementation((command: string) => {
      if (command === "legend-json-list") return Promise.resolve(listPage())
      if (command === "legend-json-list-backups") {
        return Promise.resolve({ items: [], total: 0 })
      }
      if (command === "legend-json-translate") {
        return Promise.reject({ code: "cancelled", message: "cancelled" })
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("started", { command: "legend-json-translate" }),
      )
    })
    await act(async () => {
      await result.current.cancelTranslation()
    })
    expect(mocks.cancel).toHaveBeenCalledWith("legend-json-job")
    expect(toast.info).toHaveBeenCalled()

    await act(async () => {
      await result.current.handleTranslate()
    })
    expect(toast.error).not.toHaveBeenCalled()
    expect(result.current.status).toBe("New")
  })

  it("restores a backup without requiring preview", async () => {
    mocks.run.mockImplementation((command: string) => {
      if (command === "legend-json-list") return Promise.resolve(listPage())
      if (command === "legend-json-list-backups") {
        return Promise.resolve({
          items: [
            {
              id: "backup-1",
              createdAt: "2026-08-21T00:00:00.000Z",
              outputPath: "C:\\AutoGeneratedTranslations.txt",
              backupPath: "C:\\backup.txt",
              manifestPath: "C:\\manifest.json",
              beforeFingerprint: "before",
              appliedFingerprint: "after",
              valid: true,
            },
          ],
          total: 1,
        })
      }
      if (command === "legend-json-restore") {
        return Promise.resolve({
          backupId: "backup-1",
          outputPath: "C:\\AutoGeneratedTranslations.txt",
          fingerprint: "after",
          restored: true,
        })
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.preview).toBeNull()

    let outcome: { restored: boolean; needsForce: boolean } | undefined
    await act(async () => {
      outcome = await result.current.handleRestore("backup-1")
    })
    expect(outcome).toEqual({ restored: true, needsForce: false })
    expect(mocks.run).toHaveBeenCalledWith("legend-json-restore", {
      backupId: "backup-1",
      force: false,
    })
    expect(toast.success).toHaveBeenCalled()
  })

  it("signals force restore instead of toasting fingerprint errors", async () => {
    mocks.run.mockImplementation((command: string, config: Record<string, unknown>) => {
      if (command === "legend-json-list") return Promise.resolve(listPage())
      if (command === "legend-json-list-backups") {
        return Promise.resolve({ items: [], total: 0 })
      }
      if (command === "legend-json-restore") {
        if (!config.force) {
          return Promise.reject({
            message:
              "File hiện tại đã thay đổi sau Apply; cần xác nhận force để Restore",
          })
        }
        return Promise.resolve({
          backupId: "backup-1",
          outputPath: "C:\\AutoGeneratedTranslations.txt",
          fingerprint: "after",
          restored: true,
        })
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))

    let first: { restored: boolean; needsForce: boolean } | undefined
    await act(async () => {
      first = await result.current.handleRestore("backup-1")
    })
    expect(first).toEqual({ restored: false, needsForce: true })
    expect(toast.error).not.toHaveBeenCalled()

    let second: { restored: boolean; needsForce: boolean } | undefined
    await act(async () => {
      second = await result.current.handleRestore("backup-1", true)
    })
    expect(second).toEqual({ restored: true, needsForce: false })
    expect(mocks.run).toHaveBeenCalledWith("legend-json-restore", {
      backupId: "backup-1",
      force: true,
    })
  })

  it("reloads the table after translate cancel or fail", async () => {
    mocks.run.mockImplementation((command: string) => {
      if (command === "legend-json-list") return Promise.resolve(listPage())
      if (command === "legend-json-list-backups") {
        return Promise.resolve({ items: [], total: 0 })
      }
      if (command === "legend-json-translate") {
        return Promise.reject({ code: "cancelled", message: "cancelled" })
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))
    const before = listCallCount()

    await act(async () => {
      await result.current.handleTranslate()
    })
    await waitFor(() => expect(listCallCount()).toBeGreaterThan(before))
    expect(result.current.status).toBe("New")
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("does not list again on completed after a successful translate invoke", async () => {
    mocks.run.mockImplementation(
      (command: string, config: Record<string, unknown>) => {
        if (command === "legend-json-list") {
          return Promise.resolve(
            listPage(typeof config.status === "string" ? config.status : "New"),
          )
        }
        if (command === "legend-json-list-backups") {
          return Promise.resolve({ items: [], total: 0 })
        }
        if (command === "legend-json-translate") {
          return Promise.resolve({ translated: 1, reused: 0 })
        }
        return Promise.resolve({})
      },
    )

    const { result } = renderHook(() => useLegendJsonPipeline(true))
    await waitFor(() => expect(result.current.ready).toBe(true))

    await act(async () => {
      await result.current.handleTranslate()
    })
    await waitFor(() => expect(result.current.status).toBe("Translated"))
    const afterInvoke = listCallCount()

    act(() => {
      mocks.legendEventHandler?.(
        jobEvent("completed", {
          command: "legend-json-translate",
          title: "Hoàn tất dịch JSON",
        }),
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    expect(listCallCount()).toBe(afterInvoke)
  })
})
