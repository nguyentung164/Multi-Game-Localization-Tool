import { describe, expect, it } from "vitest"
import type { ApiKeyMeta } from "@/lib/app-types"
import {
  applyTranslateKeyUsage,
  getTranslateKeyOrder,
  resolveTranslateKeyId,
} from "@/lib/translate-session"

const keys: ApiKeyMeta[] = [
  {
    id: "key-1",
    label: "API Chính",
    maskedSuffix: "•••• A9P3",
    priority: 1,
    enabled: true,
    status: "valid",
    localRequests: 0,
  },
  {
    id: "key-2",
    label: "API Phụ",
    maskedSuffix: "•••• 7K2M",
    priority: 2,
    enabled: true,
    status: "valid",
    localRequests: 3,
  },
]

describe("translate-session", () => {
  it("map keyIndex sang keyId theo thứ tự enabled", () => {
    expect(
      resolveTranslateKeyId(keys, {
        id: "job-1",
        step: "translate",
        status: "running",
        startedAt: "00:00",
        elapsed: "00:01",
        progress: 0,
        batchProgress: 0,
        currentFile: "",
        processed: 0,
        total: 0,
        throughput: "",
        keyIndex: 2,
      }),
    ).toBe("key-2")
  })

  it("cập nhật key đang active và đếm request", () => {
    const next = applyTranslateKeyUsage(keys, "key-2", { countRequest: true })
    expect(getTranslateKeyOrder(next)[1]?.status).toBe("active")
    expect(next.find((key) => key.id === "key-2")?.localRequests).toBe(4)
  })
})
