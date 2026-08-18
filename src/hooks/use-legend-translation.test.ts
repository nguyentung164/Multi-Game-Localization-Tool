import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LegendJobEvent } from "@/lib/legend-types"

const mocks = vi.hoisted(() => {
  let handler: ((event: LegendJobEvent) => void) | null = null
  return {
    inspect: vi.fn(),
    start: vi.fn(),
    getPreview: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
    updatePreview: vi.fn(),
    retranslate: vi.fn(),
    listen: vi.fn(async (next: (event: LegendJobEvent) => void) => {
      handler = next
      return () => {
        handler = null
      }
    }),
    emit(event: LegendJobEvent) {
      handler?.(event)
    },
  }
})

vi.mock("@/lib/tauri-ipc", () => ({
  isTauriRuntime: () => true,
  formatInvokeError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ipc: {
    inspectLegendFile: mocks.inspect,
    listLegendFileEntries: vi.fn(),
    startLegendTranslation: mocks.start,
    getLegendTranslationPreview: mocks.getPreview,
    getLegendSourcePath: vi.fn(async () => null),
    getLegendDeployPath: vi.fn(async () => null),
    setLegendDeployPath: vi.fn(async (path: string) => path || null),
    applyLegendTranslation: mocks.apply,
    updateLegendTranslationPreview: mocks.updatePreview,
    retranslateLegendPreview: mocks.retranslate,
    cancelJob: mocks.cancel,
    listenToLegendJobEvents: mocks.listen,
    pickFile: vi.fn(),
  },
}))

import {
  adaptLegendEstimate,
  estimateLegendTranslation,
  legendEstimateSummary,
  legendInspectEstimateTitle,
  legendTranslateButtonLabel,
  useLegendTranslation,
} from "@/hooks/use-legend-translation"

const inspection = {
  sourcePath: "B:\\legend-translations.txt",
  fingerprint: "source-hash",
  totalLines: 2,
  entryCount: 2,
  invalidLines: 0,
  duplicateSources: 0,
  uniqueSourceCount: 2,
  syntaxSourceCount: 0,
  encoding: "utf-8",
  newline: "crlf",
  hasBom: false,
  sample: [],
  warnings: [],
}

const preview = {
  previewId: "preview-1",
  sourcePath: inspection.sourcePath,
  sourceFingerprint: inspection.fingerprint,
  createdAt: "2026-08-16T00:00:00Z",
  revision: 1,
  mode: "full" as const,
  glossaryHash: "sha256:glossary",
  coverageTranslated: 2,
  coverageTotal: 2,
  diffs: [
    {
      lineNumber: 1,
      source: "黄巾渠帅",
      before: "Khăn vàng Cừ soái",
      after: "Cừ soái Khăn Vàng",
      effectiveTarget: "Cừ soái Khăn Vàng",
      effectiveAfter: "Cừ soái Khăn Vàng",
      selected: true,
      status: "pending" as const,
    },
  ],
  stats: {
    itemsTotal: 2,
    itemsTranslated: 2,
    cacheHits: 0,
    apiCalls: 1,
  },
  qa: {
    passed: true,
    blocking: false,
    revision: 1,
    errors: 0,
    warnings: 0,
    issues: [],
  },
  warnings: [],
}

describe("useLegendTranslation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPreview.mockResolvedValue(null)
    mocks.inspect.mockResolvedValue(inspection)
    mocks.start.mockResolvedValue({ jobId: "legend-job-1" })
    mocks.updatePreview.mockResolvedValue(preview)
    mocks.retranslate.mockResolvedValue({
      ...preview,
      revision: 2,
      diffs: preview.diffs.map((diff) => ({
        ...diff,
        after: "Tây Xuyên",
        effectiveTarget: "Tây Xuyên",
        effectiveAfter: "Tây Xuyên",
      })),
    })
    mocks.apply.mockResolvedValue({
      previewId: preview.previewId,
      sourcePath: preview.sourcePath,
      backupPath: "C:\\backup\\manifest.json",
      updatedLines: 1,
    })
  })

  it("ước tính batch và thời gian cho toàn bộ file", () => {
    expect(estimateLegendTranslation(100, 12)).toEqual({
      items: 100,
      doneItems: 0,
      reusedItems: 0,
      cachedItems: 0,
      lockedItems: 0,
      pendingItems: 100,
      actionableItems: 100,
      workersUsed: 1,
      spareKeys: 0,
      estimatedBatches: 9,
      estimatedApiCalls: 9,
      estimatedSecondsMin: 45,
      estimatedSecondsMax: 135,
    })
    expect(estimateLegendTranslation(100, 40, 5)).toMatchObject({
      workersUsed: 3,
      spareKeys: 2,
      estimatedBatches: 3,
    })
  })

  it("nút dịch ghi số câu mới, không ghi cả file", () => {
    expect(legendTranslateButtonLabel(null)).toBe("Dịch câu mới")
    expect(
      legendTranslateButtonLabel({
        items: 10,
        doneItems: 10,
        reusedItems: 0,
        cachedItems: 0,
        lockedItems: 0,
        pendingItems: 0,
        actionableItems: 0,
        estimatedBatches: 0,
        estimatedApiCalls: 0,
        estimatedSecondsMin: 0,
        estimatedSecondsMax: 0,
      }),
    ).toBe("Không còn câu mới")
    expect(
      legendTranslateButtonLabel({
        items: 20,
        doneItems: 0,
        reusedItems: 0,
        cachedItems: 0,
        lockedItems: 0,
        pendingItems: 20,
        actionableItems: 20,
        estimatedBatches: 1,
        estimatedApiCalls: 1,
        estimatedSecondsMin: 5,
        estimatedSecondsMax: 15,
      }),
    ).toBe("Dịch 20 câu mới")
    expect(
      legendTranslateButtonLabel({
        items: 5,
        doneItems: 2,
        reusedItems: 1,
        cachedItems: 2,
        lockedItems: 0,
        pendingItems: 0,
        actionableItems: 3,
        estimatedBatches: 0,
        estimatedApiCalls: 0,
        estimatedSecondsMin: 0,
        estimatedSecondsMax: 0,
      }),
    ).toBe("Tạo preview từ cache/khóa")
  })

  it("tiêu đề inspect theo số câu cần API", () => {
    expect(
      legendInspectEstimateTitle({
        estimate: {
          items: 20,
          doneItems: 0,
          reusedItems: 0,
          cachedItems: 0,
          lockedItems: 0,
          pendingItems: 20,
          actionableItems: 20,
          estimatedBatches: 1,
          estimatedApiCalls: 1,
          estimatedSecondsMin: 5,
          estimatedSecondsMax: 15,
        },
        loading: false,
        failed: false,
      }),
    ).toBe("Cần dịch 20 câu mới")
  })

  it("tóm tắt ước tính nhấn mạnh câu cần API, không phải cả file", () => {
    expect(
      legendEstimateSummary({
        estimate: null,
        uniqueSourceCount: 10020,
        loading: true,
        failed: false,
      }),
    ).toContain("Đang đếm câu chưa Việt hóa")
    expect(
      legendEstimateSummary({
        estimate: {
          items: 10020,
          doneItems: 10000,
          reusedItems: 0,
          cachedItems: 0,
          lockedItems: 0,
          pendingItems: 20,
          actionableItems: 20,
          estimatedBatches: 1,
          estimatedApiCalls: 1,
          estimatedSecondsMin: 5,
          estimatedSecondsMax: 15,
        },
        uniqueSourceCount: 10020,
        loading: false,
        failed: false,
      }),
    ).toMatch(/^Cần dịch 20 câu mới · .+ đã Việt · .+ cache · 0 khóa · file có .+ nguồn duy nhất · khoảng 1 phút\.$/)
    expect(
      legendEstimateSummary({
        estimate: {
          items: 10020,
          doneItems: 10020,
          reusedItems: 0,
          cachedItems: 0,
          lockedItems: 0,
          pendingItems: 0,
          actionableItems: 0,
          estimatedBatches: 0,
          estimatedApiCalls: 0,
          estimatedSecondsMin: 0,
          estimatedSecondsMax: 0,
        },
        uniqueSourceCount: 10020,
        loading: false,
        failed: false,
      }),
    ).toContain("Không còn câu mới để tạo preview")
  })

  it("scale ước tính khi đổi số mục", () => {
    expect(
      adaptLegendEstimate(
        {
          items: 30,
          cachedItems: 10,
          lockedItems: 5,
          pendingItems: 15,
          estimatedBatches: 3,
          estimatedApiCalls: 3,
          estimatedSecondsMin: 15,
          estimatedSecondsMax: 45,
        },
        15,
      ),
    ).toEqual({
      items: 15,
      doneItems: 0,
      reusedItems: 0,
      cachedItems: 5,
      lockedItems: 3,
      pendingItems: 7,
      actionableItems: 15,
      workersUsed: 0,
      spareKeys: 0,
      estimatedBatches: 2,
      estimatedApiCalls: 2,
      estimatedSecondsMin: 8,
      estimatedSecondsMax: 23,
    })
  })

  it("gọi backend dịch toàn bộ file", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })
    await act(async () => {
      await result.current.translate()
    })
    expect(mocks.start).toHaveBeenCalledWith(inspection.sourcePath, {
      forceRetranslate: false,
    })
  })

  it("đi qua inspect → translate → review → apply", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())

    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })
    expect(result.current.phase).toBe("ready")
    expect(result.current.inspection).toEqual(inspection)

    await act(async () => {
      await result.current.translate()
    })
    expect(result.current.phase).toBe("running")
    expect(result.current.jobId).toBe("legend-job-1")

    mocks.getPreview.mockResolvedValue(preview)
    await act(async () => {
      mocks.emit({
        protocolVersion: 1,
        jobId: "legend-job-1",
        seq: 3,
        timestamp: "2026-08-16T00:00:00Z",
        type: "completed",
        payload: {},
      })
    })
    await waitFor(() => expect(result.current.phase).toBe("review"))
    expect(result.current.preview).toEqual(preview)

    await act(async () => {
      await result.current.apply()
    })
    expect(mocks.apply).toHaveBeenCalledWith("preview-1")
    expect(result.current.phase).toBe("applied")
    expect(result.current.applyResult?.updatedLines).toBe(1)
  })

  it("ghi lỗi inspect và sự kiện job vào console", async () => {
    mocks.inspect.mockRejectedValueOnce(new Error("Encoding không hỗ trợ"))
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())

    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })
    expect(result.current.events[0]?.title).toBe("Kiểm tra file thất bại")
    expect(result.current.events[0]?.level).toBe("error")

    await act(async () => {
      mocks.emit({
        protocolVersion: 1,
        jobId: "legend-job-1",
        seq: 2,
        timestamp: "2026-08-16T00:00:00Z",
        type: "failed",
        payload: { message: "Hết quota Gemini" },
      })
    })
    expect(result.current.events[0]?.title).toBe("Hết quota Gemini")
    expect(result.current.events[0]?.level).toBe("error")

    await act(async () => {
      result.current.clearEvents()
    })
    expect(result.current.events).toEqual([])
  })

  it("giữ file gốc nguyên trạng khi inspect thất bại", async () => {
    mocks.inspect.mockRejectedValueOnce(new Error("Encoding không hỗ trợ"))
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())

    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })

    expect(result.current.phase).toBe("error")
    expect(result.current.inspection).toBeNull()
    expect(result.current.error).toBe("Encoding không hỗ trợ")
  })

  it("hiển thị tiến độ theo số mục engine đã xử lý", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())

    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })
    await act(async () => {
      await result.current.translate()
    })
    act(() => {
      mocks.emit({
        protocolVersion: 1,
        jobId: "legend-job-1",
        seq: 2,
        timestamp: "2026-08-16T00:00:00Z",
        type: "progress",
        payload: {
          itemsProcessed: 1,
          itemsTotal: 2,
          itemProgress: 50,
          currentItem: "legend-translations.txt",
        },
      })
    })

    expect(result.current.progress).toEqual({
      progress: 50,
      processed: 1,
      total: 2,
      currentItem: "legend-translations.txt",
      model: undefined,
      keyIndex: undefined,
    })
  })

  it("bắt buộc kiểm tra lại sau khi đổi đường dẫn", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })

    act(() => {
      result.current.setSourcePath("B:\\other.txt")
    })
    expect(result.current.inspection).toBeNull()
    await act(async () => {
      await result.current.translate()
    })

    expect(mocks.start).not.toHaveBeenCalled()
    expect(result.current.error).toContain("kiểm tra lại file")
  })

  it("ghi nhớ yêu cầu hủy trong lúc backend đang khởi động", async () => {
    let resolveStart: ((value: { jobId: string }) => void) | undefined
    mocks.start.mockImplementationOnce(
      () =>
        new Promise<{ jobId: string }>((resolve) => {
          resolveStart = resolve
        }),
    )
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })

    act(() => {
      void result.current.translate()
    })
    await waitFor(() => expect(result.current.phase).toBe("starting"))
    act(() => {
      void result.current.cancel()
    })
    expect(result.current.phase).toBe("cancelling")
    expect(mocks.cancel).not.toHaveBeenCalled()

    await act(async () => {
      resolveStart?.({ jobId: "legend-job-1" })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(mocks.cancel).toHaveBeenCalledWith("legend-job-1"),
    )
  })

  it("gọi API dịch lại các dòng còn chữ Hán", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })
    await act(async () => {
      await result.current.translate()
    })
    mocks.getPreview.mockResolvedValue(preview)
    await act(async () => {
      mocks.emit({
        protocolVersion: 1,
        jobId: "legend-job-1",
        seq: 3,
        timestamp: "2026-08-16T00:00:00Z",
        type: "completed",
        payload: {},
      })
    })
    await waitFor(() => expect(result.current.phase).toBe("review"))

    await act(async () => {
      await result.current.retranslateHan([1])
    })
    expect(mocks.retranslate).toHaveBeenCalledWith("preview-1", [1])
    expect(result.current.phase).toBe("review")
    expect(result.current.retranslating).toBe(false)
    expect(result.current.preview?.revision).toBe(2)
    expect(result.current.preview?.diffs[0]?.after).toBe("Tây Xuyên")
    expect(result.current.preview?.diffs[0]?.effectiveAfter).toBe("Tây Xuyên")
  })

  it("chỉ tải preview khi job completed, bỏ qua event result", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.inspect(inspection.sourcePath)
    })
    await act(async () => {
      await result.current.translate()
    })
    mocks.getPreview.mockClear()
    await act(async () => {
      mocks.emit({
        protocolVersion: 1,
        jobId: "legend-job-1",
        seq: 2,
        timestamp: "2026-08-16T00:00:00Z",
        type: "result",
        payload: { diffs: [{ lineNumber: 1 }] },
      })
    })
    expect(mocks.getPreview).not.toHaveBeenCalled()
    mocks.getPreview.mockResolvedValue(preview)
    await act(async () => {
      mocks.emit({
        protocolVersion: 1,
        jobId: "legend-job-1",
        seq: 3,
        timestamp: "2026-08-16T00:00:00Z",
        type: "completed",
        payload: {},
      })
    })
    await waitFor(() => expect(result.current.phase).toBe("review"))
    expect(mocks.getPreview).toHaveBeenCalledOnce()
  })

  it("dò preview im lặng không bật banner khi chưa có artifact hiện tại", async () => {
    const { result } = renderHook(() => useLegendTranslation())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.loadPreview({ silent: true })
    })
    expect(result.current.previewLoading).toBe(false)
    expect(result.current.preview).toBeNull()
  })
})
