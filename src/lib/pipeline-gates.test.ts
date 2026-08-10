import { describe, expect, it } from "vitest"
import { demoState } from "@/lib/demo-state"
import {
  deployRequiresApply,
  normalizePipelineGates,
  syncRequiresTranslation,
} from "@/lib/pipeline-gates"

describe("normalizePipelineGates", () => {
  it("mở khóa inspect sau khi export thành công", () => {
    const state = structuredClone(demoState)
    state.setupComplete = true
    state.steps = state.steps.map((step) =>
      step.id === "export"
        ? { ...step, status: "success" }
        : step.id === "inspect"
          ? { ...step, status: "locked", lockedReason: "Cần hoàn tất Export." }
          : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "inspect")?.status).toBe("ready")
    expect(next.steps.find((step) => step.id === "inspect")?.lockedReason).toBeUndefined()
  })

  it("giữ translate bị khóa cho đến khi áp dụng đồng bộ", () => {
    const state = structuredClone(demoState)
    state.syncApplied = false
    state.steps = state.steps.map((step) =>
      step.id === "sync"
        ? { ...step, status: "success" }
        : step.id === "translate"
          ? { ...step, status: "ready" }
          : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "translate")?.status).toBe(
      "locked",
    )
    expect(
      next.steps.find((step) => step.id === "translate")?.lockedReason,
    ).toContain("Đồng bộ")
  })

  it("bỏ qua dịch khi đồng bộ chỉ có thay đổi loại xóa", () => {
    const state = structuredClone(demoState)
    state.syncApplied = true
    state.syncChanges = [
      {
        id: "del-1",
        kind: "delete",
        file: "Base/Text.xml",
        tag: "LOC_KEY",
        before: "Bản dịch cũ",
      },
    ]
    state.steps = state.steps.map((step) =>
      step.id === "sync"
        ? { ...step, status: "success" }
        : step.id === "translate"
          ? {
              ...step,
              status: "locked",
              lockedReason: "Cần áp dụng bản xem trước Đồng bộ.",
            }
          : step.id === "deploy"
            ? {
                ...step,
                status: "locked",
                lockedReason: "Cần hoàn tất Dịch.",
              }
            : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "translate")?.status).toBe(
      "success",
    )
    expect(
      next.steps.find((step) => step.id === "translate")?.summary.translated,
    ).toBe(0)
    expect(next.steps.find((step) => step.id === "deploy")?.status).toBe("ready")
    expect(
      next.steps.find((step) => step.id === "deploy")?.lockedReason,
    ).toBeUndefined()
  })

  it("bỏ qua dịch và mở deploy khi đồng bộ không có thay đổi", () => {
    const state = structuredClone(demoState)
    state.setupComplete = true
    state.syncApplied = true
    state.syncChanges = []
    state.steps = state.steps.map((step) =>
      step.id === "sync"
        ? { ...step, status: "success" }
        : step.id === "translate" || step.id === "deploy"
          ? { ...step, status: "locked" }
          : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "translate")?.status).toBe(
      "success",
    )
    expect(next.steps.find((step) => step.id === "deploy")?.status).toBe("ready")
  })

  it("giữ deploy bị khóa khi đồng bộ có nội dung mới cần dịch", () => {
    const state = structuredClone(demoState)
    state.setupComplete = true
    state.syncApplied = true
    state.syncChanges = [
      {
        id: "add-1",
        kind: "add",
        file: "Base/Text.xml",
        tag: "LOC_NEW",
        after: "New text",
      },
    ]
    state.steps = state.steps.map((step) =>
      step.id === "sync"
        ? { ...step, status: "success" }
        : step.id === "translate"
          ? { ...step, status: "ready" }
          : step.id === "deploy"
            ? { ...step, status: "locked", lockedReason: "Cần hoàn tất Dịch." }
            : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "translate")?.status).toBe(
      "ready",
    )
    expect(next.steps.find((step) => step.id === "deploy")?.status).toBe(
      "locked",
    )
  })

  it("không tự bỏ qua phiên dịch đang chạy, lỗi hoặc tạm dừng", () => {
    for (const status of ["running", "failed", "paused"] as const) {
      const state = structuredClone(demoState)
      state.setupComplete = true
      state.syncApplied = true
      state.syncChanges = []
      state.steps = state.steps.map((step) =>
        step.id === "sync"
          ? { ...step, status: "success" }
          : step.id === "translate"
            ? { ...step, status }
            : step.id === "deploy"
              ? { ...step, status: "locked" }
              : step,
      )

      const next = normalizePipelineGates(state)
      expect(next.steps.find((step) => step.id === "translate")?.status).toBe(
        status,
      )
      expect(next.steps.find((step) => step.id === "deploy")?.status).toBe(
        "locked",
      )
    }
  })

  it("không bỏ qua dịch khi quay lại export dù syncApplied còn cũ", () => {
    const state = structuredClone(demoState)
    state.setupComplete = true
    state.syncApplied = true
    state.syncChanges = [
      {
        id: "del-1",
        kind: "delete",
        file: "Base/Text.xml",
        tag: "LOC_KEY",
        before: "Bản dịch cũ",
      },
    ]
    state.steps = state.steps.map((step) =>
      step.id === "export"
        ? { ...step, status: "running" }
        : step.id === "sync"
          ? { ...step, status: "locked", lockedReason: "Cần hoàn tất Kiểm tra." }
          : step.id === "translate"
            ? { ...step, status: "locked", lockedReason: "Cần hoàn tất Đồng bộ." }
            : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "translate")?.status).toBe(
      "locked",
    )
  })

  it("vẫn cần dịch khi đồng bộ có thêm mục mới", () => {
    expect(
      syncRequiresTranslation([
        {
          id: "add-1",
          kind: "add",
          file: "Base/Text.xml",
          tag: "LOC_KEY",
          after: "New English line",
        },
      ]),
    ).toBe(true)
    expect(
      syncRequiresTranslation([
        {
          id: "del-1",
          kind: "delete",
          file: "Base/Text.xml",
          tag: "LOC_KEY",
          before: "Old line",
        },
      ]),
    ).toBe(false)
  })

  it("giữ failed/paused và không ghi đè thành locked", () => {
    const state = structuredClone(demoState)
    state.setupComplete = true
    state.steps = state.steps.map((step) =>
      step.id === "export"
        ? { ...step, status: "success" }
        : step.id === "inspect"
          ? { ...step, status: "failed" }
          : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.steps.find((step) => step.id === "inspect")?.status).toBe("failed")
  })

  it("bỏ qua deploy khi preview chỉ có file không đổi hoặc bỏ qua", () => {
    const state = structuredClone(demoState)
    state.setupComplete = true
    state.deployApplied = false
    state.deployChanges = [
      { id: "dep-1", kind: "unchanged", file: "Text-en-US.xml" },
      { id: "dep-2", kind: "skip", file: "Extra.txt" },
    ]
    state.steps = state.steps.map((step) =>
      step.id === "translate" || step.id === "deploy"
        ? { ...step, status: "success" }
        : step,
    )

    const next = normalizePipelineGates(state)
    expect(next.deployApplied).toBe(true)
    expect(next.steps.find((step) => step.id === "deploy")?.status).toBe("success")
  })

  it("vẫn cần triển khai khi preview có file copy hoặc create", () => {
    expect(
      deployRequiresApply([
        { id: "dep-1", kind: "copy", file: "Text-en-US.xml" },
      ]),
    ).toBe(true)
    expect(
      deployRequiresApply([
        { id: "dep-1", kind: "unchanged", file: "Text-en-US.xml" },
      ]),
    ).toBe(false)
  })
})
