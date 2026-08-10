import { describe, expect, it } from "vitest"
import { demoState } from "@/lib/demo-state"
import { findNextRunnableStep } from "@/lib/pipeline-gates"

describe("findNextRunnableStep", () => {
  it("returns first ready or paused step in order", () => {
    const steps = demoState.steps.map((step) => {
      if (step.id === "inspect" || step.id === "export" || step.id === "sync") {
        return { ...step, status: "success" as const }
      }
      if (step.id === "translate") {
        return { ...step, status: "paused" as const }
      }
      if (step.id === "deploy") {
        return { ...step, status: "locked" as const }
      }
      return step
    })
    expect(findNextRunnableStep(steps)).toBe("translate")
  })

  it("returns null when nothing runnable", () => {
    const steps = demoState.steps.map((step) => ({
      ...step,
      status: "success" as const,
    }))
    expect(findNextRunnableStep(steps)).toBeNull()
  })
})
