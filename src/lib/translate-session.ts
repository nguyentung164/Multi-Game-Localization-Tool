import type { ActiveJob, ApiKeyMeta, AppState } from "@/lib/app-types"
import { formatDateTime } from "@/lib/format-date"

export function isApiKeyAvailable(key: ApiKeyMeta): boolean {
  return (
    key.enabled &&
    key.status !== "invalid" &&
    key.status !== "quota-exhausted"
  )
}

export function getTranslateKeyOrder(apiKeys: ApiKeyMeta[]): ApiKeyMeta[] {
  return [...apiKeys]
    .filter((key) => key.enabled)
    .sort((left, right) => left.priority - right.priority)
}

export function resolveTranslateKeyId(
  apiKeys: ApiKeyMeta[],
  job: ActiveJob | null | undefined,
): string | undefined {
  if (!job) return undefined
  if (job.keyId) return job.keyId
  if (job.keyIndex && job.keyIndex >= 1) {
    return getTranslateKeyOrder(apiKeys)[job.keyIndex - 1]?.id
  }
  return getTranslateKeyOrder(apiKeys)[0]?.id
}

export function resolveActiveTranslateKey(state: AppState): ApiKeyMeta | null {
  const fromJob = resolveTranslateKeyId(state.apiKeys, state.activeJob)
  if (fromJob) {
    return state.apiKeys.find((key) => key.id === fromJob) ?? null
  }
  return (
    state.apiKeys.find((key) => key.status === "active") ??
    state.apiKeys.find(isApiKeyAvailable) ??
    null
  )
}

export function applyTranslateKeyUsage(
  apiKeys: ApiKeyMeta[],
  keyId: string,
  options?: { countRequest?: boolean },
): ApiKeyMeta[] {
  return apiKeys.map((key) => {
    if (key.id === keyId) {
      return {
        ...key,
        status: "active",
        activeSince: key.activeSince ?? formatDateTime(new Date()),
        localRequests: key.localRequests + (options?.countRequest ? 1 : 0),
      }
    }
    if (key.status === "active") {
      return { ...key, status: "valid" }
    }
    return key
  })
}

export function getTranslateModelChain(config: AppState["config"]): string[] {
  const models = [config.model, ...config.fallbackModels]
  return [...new Set(models.filter(Boolean))]
}
