import { describe, expect, it } from "vitest"
import {
  formatUpdateDate,
  shouldPrompt,
  shouldSuppressUpdateAutoPrompt,
  updaterErrorNotificationTitle,
} from "@/lib/app-updater"

describe("shouldSuppressUpdateAutoPrompt", () => {
  it("keeps auto-prompt after Esc while a job is running", () => {
    expect(
      shouldSuppressUpdateAutoPrompt({ dismissed: false, busy: true }),
    ).toBe(false)
  })

  it("does not reopen immediately after Esc while idle", () => {
    expect(
      shouldSuppressUpdateAutoPrompt({ dismissed: false, busy: false }),
    ).toBe(true)
  })

  it("never auto-prompts after Để sau", () => {
    expect(
      shouldSuppressUpdateAutoPrompt({ dismissed: true, busy: true }),
    ).toBe(true)
    expect(
      shouldSuppressUpdateAutoPrompt({ dismissed: true, busy: false }),
    ).toBe(true)
  })
})

describe("shouldPrompt", () => {
  it("prompts when latest is newer and not dismissed", () => {
    expect(
      shouldPrompt({
        currentVersion: "1.2.1",
        latestVersion: "1.3.0",
        dismissedVersion: null,
      }),
    ).toBe(true)
  })

  it("skips a dismissed version but prompts a newer one", () => {
    expect(
      shouldPrompt({
        currentVersion: "1.2.1",
        latestVersion: "1.3.0",
        dismissedVersion: "1.3.0",
      }),
    ).toBe(false)
    expect(
      shouldPrompt({
        currentVersion: "1.2.1",
        latestVersion: "1.3.1",
        dismissedVersion: "1.3.0",
      }),
    ).toBe(true)
  })
})

describe("formatUpdateDate", () => {
  it("formats ISO dates", () => {
    const formatted = formatUpdateDate("2026-08-19T12:00:00.000Z")
    expect(formatted).toMatch(/2026/)
    expect(formatted.length).toBeGreaterThan(0)
  })

  it("returns empty for missing dates", () => {
    expect(formatUpdateDate(null)).toBe("")
    expect(formatUpdateDate("  ")).toBe("")
  })
})

describe("updaterErrorNotificationTitle", () => {
  it("distinguishes check errors from install errors", () => {
    expect(updaterErrorNotificationTitle(false)).toBe(
      "Không kiểm tra được bản cập nhật",
    )
    expect(updaterErrorNotificationTitle(true)).toBe(
      "Không cài được bản cập nhật",
    )
  })
})
