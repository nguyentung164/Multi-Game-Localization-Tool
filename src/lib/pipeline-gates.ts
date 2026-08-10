import type {
  AppState,
  DeployChange,
  StepId,
  StepStatus,
  SyncChange,
} from "@/lib/app-types"
import { STEP_ORDER } from "@/lib/app-types"

const SYNC_APPLY_LOCK_REASON = "Cần áp dụng bản xem trước Đồng bộ."
export const TRANSLATE_SKIP_AFTER_DELETE_SYNC =
  "Đồng bộ chỉ xóa mục thừa — không có nội dung mới cần dịch."
export const DEPLOY_SKIP_NOTHING_TO_WRITE =
  "Mod đã khớp game — không có file nào cần triển khai."

export function syncChangeRequiresTranslation(change: SyncChange): boolean {
  if (change.kind === "add" || change.kind === "update") return true
  if (change.kind === "delete" || change.kind === "warning") return false
  if (change.kind === "vtt") {
    return Boolean(change.after?.trim())
  }
  return false
}

export function syncRequiresTranslation(changes: SyncChange[]): boolean {
  return changes.some(syncChangeRequiresTranslation)
}

export function deployChangeRequiresApply(change: DeployChange): boolean {
  return change.kind === "copy" || change.kind === "create"
}

export function deployRequiresApply(changes: DeployChange[]): boolean {
  return changes.some(deployChangeRequiresApply)
}

/** Có file cần ghi vào game (dùng summary trước — tránh quét deployChanges lớn). */
export function deployApplyActionable(state: AppState): boolean {
  const deploy = state.steps.find((step) => step.id === "deploy")
  const summaryCount = deploy?.summary.changes ?? 0
  if (summaryCount > 0) return true
  return deployRequiresApply(state.deployChanges)
}

export function shouldSkipTranslateAfterSync(state: AppState): boolean {
  return Boolean(state.syncApplied && !syncRequiresTranslation(state.syncChanges))
}

export function translateSkippedAfterDeleteOnlySync(state: AppState): boolean {
  if (!shouldSkipTranslateAfterSync(state)) return false
  const sync = state.steps.find((step) => step.id === "sync")
  if (!sync || !isStepComplete(sync.status)) return false
  const translate = state.steps.find((step) => step.id === "translate")
  return translate ? isStepComplete(translate.status) : false
}

function applyTranslateSkipAfterDeleteOnlySync(state: AppState): AppState {
  if (!state.setupComplete || !shouldSkipTranslateAfterSync(state)) return state
  const sync = state.steps.find((step) => step.id === "sync")
  if (!sync || !isStepComplete(sync.status)) return state
  const translate = state.steps.find((step) => step.id === "translate")
  if (
    !translate ||
    ["running", "failed", "paused"].includes(translate.status)
  ) {
    return state
  }
  return {
    ...state,
    steps: state.steps.map((step) =>
      step.id === "translate"
        ? {
            ...step,
            status: "success" as const,
            lockedReason: undefined,
            summary: {
              ...step.summary,
              translated: 0,
              warnings: 0,
            },
          }
        : step,
    ),
  }
}

function applyDeploySkipWhenNothingToApply(state: AppState): AppState {
  const translate = state.steps.find((step) => step.id === "translate")
  const deploy = state.steps.find((step) => step.id === "deploy")
  if (
    state.deployApplied ||
    !translate ||
    !isStepComplete(translate.status) ||
    !deploy ||
    !isStepComplete(deploy.status) ||
    deployApplyActionable(state) ||
    ["running", "failed", "paused", "locked"].includes(deploy.status)
  ) {
    return state
  }
  return {
    ...state,
    deployApplied: true,
    steps: state.steps.map((step) =>
      step.id === "deploy"
        ? {
            ...step,
            status: "success" as const,
            lockedReason: undefined,
            summary: {
              ...step.summary,
              changes: 0,
              warnings: 0,
            },
          }
        : step,
    ),
  }
}

export function deploySkippedAfterEmptyPreview(state: AppState): boolean {
  if (deployApplyActionable(state)) return false
  const translate = state.steps.find((step) => step.id === "translate")
  if (!translate || !isStepComplete(translate.status)) return false
  const deploy = state.steps.find((step) => step.id === "deploy")
  return Boolean(state.deployApplied && deploy && isStepComplete(deploy.status))
}

const LOCK_REASONS: Record<StepId, string> = {
  export: "Hoàn tất thiết lập đường dẫn trước.",
  inspect: "Cần hoàn tất Export.",
  sync: "Cần hoàn tất Kiểm tra.",
  translate: "Cần hoàn tất Đồng bộ.",
  deploy: "Cần hoàn tất Dịch.",
}

export function isStepComplete(status: StepStatus): boolean {
  return status === "success" || status === "warning"
}

export function syncApplyPending(state: AppState): boolean {
  if (state.syncApplied) return false
  const sync = state.steps.find((step) => step.id === "sync")
  return sync ? isStepComplete(sync.status) : false
}

export function deployApplyPending(state: AppState): boolean {
  if (state.deployApplied) return false
  const deploy = state.steps.find((step) => step.id === "deploy")
  return deploy ? isStepComplete(deploy.status) : false
}

function prerequisiteComplete(state: AppState, stepId: StepId): boolean {
  const index = STEP_ORDER.indexOf(stepId)
  if (index <= 0) return true
  const previous = state.steps.find((item) => item.id === STEP_ORDER[index - 1])
  return previous ? isStepComplete(previous.status) : false
}

export function normalizePipelineGates(state: AppState): AppState {
  let steps = state.steps.map((step) => ({ ...step, summary: { ...step.summary } }))

  for (const stepId of STEP_ORDER) {
    const step = steps.find((item) => item.id === stepId)
    if (!step) continue

    const ready = prerequisiteComplete({ ...state, steps }, stepId)

    if (!state.setupComplete) {
      step.status = "locked"
      step.lockedReason = "Hoàn tất thiết lập đường dẫn trước."
      continue
    }

    if (ready) {
      if (step.status === "locked") {
        step.status = "ready"
      }
      step.lockedReason = undefined
      continue
    }

    if (!["running", "failed", "paused"].includes(step.status)) {
      step.status = "locked"
      step.lockedReason = LOCK_REASONS[stepId]
    }
  }

  if (syncApplyPending({ ...state, steps })) {
    const translate = steps.find((step) => step.id === "translate")
    if (
      translate &&
      !["running", "failed", "paused"].includes(translate.status)
    ) {
      translate.status = "locked"
      translate.lockedReason = SYNC_APPLY_LOCK_REASON
    }
  }

  const afterTranslateSkip = applyTranslateSkipAfterDeleteOnlySync({
    ...state,
    steps,
  })
  steps = afterTranslateSkip.steps

  // B4 vừa được bỏ qua phải mở khóa B5 trong cùng một lần normalize.
  const deploy = steps.find((step) => step.id === "deploy")
  const translate = steps.find((step) => step.id === "translate")
  if (
    deploy?.status === "locked" &&
    translate &&
    isStepComplete(translate.status)
  ) {
    deploy.status = "ready"
    deploy.lockedReason = undefined
  }

  return applyDeploySkipWhenNothingToApply({
    ...afterTranslateSkip,
    steps,
  })
}

export function findNextRunnableStep(
  steps: AppState["steps"],
): StepId | null {
  for (const stepId of STEP_ORDER) {
    const step = steps.find((item) => item.id === stepId)
    if (!step) continue
    if (["ready", "paused", "warning"].includes(step.status)) {
      return stepId
    }
  }
  return null
}

export const STATE_SYNC_EVENT_TYPES = new Set([
  "completed",
  "failed",
  "paused",
  "report",
])
