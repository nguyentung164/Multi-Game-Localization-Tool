import { describe, expect, it } from "vitest"
import type { JobEventEnvelope, StepId } from "@/lib/app-types"
import { demoState } from "@/lib/demo-state"
import { applyJobEvent } from "@/hooks/use-app-controller"

function jobEvent(
  step: StepId,
  type: JobEventEnvelope["type"],
  command?: string,
): JobEventEnvelope {
  return {
    protocolVersion: 1,
    jobId: "job-test",
    seq: 1,
    step,
    timestamp: "2026-08-10T10:00:00Z",
    type,
    payload: command ? { command } : {},
  }
}

describe("applyJobEvent applied flags", () => {
  it("không coi sync preview là đã áp dụng", () => {
    const state = structuredClone(demoState)
    state.syncApplied = false

    const next = applyJobEvent(
      state,
      jobEvent("sync", "completed", "sync-preview"),
    )

    expect(next.syncApplied).toBe(false)
  })

  it("chỉ đánh dấu sync đã áp dụng sau sync-apply", () => {
    const state = structuredClone(demoState)
    state.syncApplied = false

    const next = applyJobEvent(
      state,
      jobEvent("sync", "completed", "sync-apply"),
    )

    expect(next.syncApplied).toBe(true)
  })

  it("không coi deploy preview là đã triển khai", () => {
    const state = structuredClone(demoState)
    state.deployApplied = false

    const next = applyJobEvent(
      state,
      jobEvent("deploy", "completed", "deploy-preview"),
    )

    expect(next.deployApplied).toBe(false)
  })

  it("reset cờ áp dụng cũ khi pipeline chạy lại từ bước trước", () => {
    const state = structuredClone(demoState)
    state.syncApplied = true
    state.deployApplied = true

    const next = applyJobEvent(state, jobEvent("export", "started"))

    expect(next.syncApplied).toBe(false)
    expect(next.deployApplied).toBe(false)
  })
})
