import type { VariantProps } from "class-variance-authority"

import type { StepId, StepStatus } from "@/lib/app-types"
import { buttonVariants } from "@/components/ui/button"

export type ActionButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>

/** Nền gradient theme + chữ semantic theo chức năng */
export const actionBtn = {
  deploy: "success",
  run: "success",
  apply: "success",
  translateNew: "success",
  inspect: "info",
  search: "info",
  report: "info",
  verify: "info",
  retry: "warning",
  restore: "warning",
  translateAll: "warning",
  retranslate: "warning",
  stop: "destructive",
  save: "success",
  manageApi: "info",
} as const satisfies Record<string, ActionButtonVariant>

export function dashboardStepActionVariant(step: StepId): ActionButtonVariant {
  if (step === "inspect") return actionBtn.inspect
  if (step === "deploy") return actionBtn.deploy
  return actionBtn.run
}

export function pipelineFooterActionVariant(input: {
  running: boolean
  deploySelected: boolean
  previewReady: boolean
  stepStatus: StepStatus
  isRerun: boolean
}): ActionButtonVariant {
  if (input.running) return actionBtn.stop
  if (input.deploySelected || input.previewReady) return actionBtn.deploy
  if (input.isRerun) return actionBtn.retry
  return actionBtn.run
}
