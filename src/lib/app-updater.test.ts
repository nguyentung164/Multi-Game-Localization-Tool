import { afterEach, describe, expect, it } from "vitest";
import {
  applyDownloadEvent,
  AUTO_CHECK_STORAGE_KEY,
  compareVersions,
  DISMISSED_VERSION_STORAGE_KEY,
  EMPTY_DOWNLOAD_PROGRESS,
  formatByteSize,
  formatDownloadProgress,
  loadAutoCheckEnabled,
  loadDismissedVersion,
  saveAutoCheckEnabled,
  saveDismissedVersion,
  shouldAutoCheck,
  shouldPrompt,
  updaterStatusLabel,
} from "@/lib/app-updater";

describe("compareVersions", () => {
  it("orders semver numerically", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
  });

  it("orders prerelease below the same core version", () => {
    expect(compareVersions("1.2.0", "1.2.0-beta")).toBe(1);
    expect(compareVersions("1.2.0-beta", "1.2.0")).toBe(-1);
    expect(compareVersions("1.2.0-alpha", "1.2.0-beta")).toBe(-1);
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.11")).toBe(-1);
    expect(compareVersions("1.2.0+build", "1.2.0")).toBe(0);
  });
});

describe("shouldAutoCheck", () => {
  it("only runs in production Tauri with the preference on", () => {
    expect(
      shouldAutoCheck({ isTauri: true, isDev: false, autoCheckEnabled: true }),
    ).toBe(true);
    expect(
      shouldAutoCheck({ isTauri: true, isDev: true, autoCheckEnabled: true }),
    ).toBe(false);
    expect(
      shouldAutoCheck({ isTauri: false, isDev: false, autoCheckEnabled: true }),
    ).toBe(false);
    expect(
      shouldAutoCheck({ isTauri: true, isDev: false, autoCheckEnabled: false }),
    ).toBe(false);
  });
});

describe("shouldPrompt", () => {
  it("prompts for a newer version that was not dismissed", () => {
    expect(
      shouldPrompt({
        currentVersion: "1.1.0",
        latestVersion: "1.2.0",
        dismissedVersion: null,
      }),
    ).toBe(true);
  });

  it("does not prompt when already on latest or older", () => {
    expect(
      shouldPrompt({
        currentVersion: "1.2.0",
        latestVersion: "1.2.0",
        dismissedVersion: null,
      }),
    ).toBe(false);
    expect(
      shouldPrompt({
        currentVersion: "1.2.0",
        latestVersion: "1.1.0",
        dismissedVersion: null,
      }),
    ).toBe(false);
  });

  it("hides auto-prompt only for the dismissed version", () => {
    expect(
      shouldPrompt({
        currentVersion: "1.1.0",
        latestVersion: "1.2.0",
        dismissedVersion: "1.2.0",
      }),
    ).toBe(false);
    expect(
      shouldPrompt({
        currentVersion: "1.1.0",
        latestVersion: "1.3.0",
        dismissedVersion: "1.2.0",
      }),
    ).toBe(true);
  });
});

describe("updater storage", () => {
  afterEach(() => {
    window.localStorage.removeItem(AUTO_CHECK_STORAGE_KEY);
    window.localStorage.removeItem(DISMISSED_VERSION_STORAGE_KEY);
  });

  it("defaults auto-check to enabled", () => {
    expect(loadAutoCheckEnabled()).toBe(true);
    saveAutoCheckEnabled(false);
    expect(loadAutoCheckEnabled()).toBe(false);
    saveAutoCheckEnabled(true);
    expect(loadAutoCheckEnabled()).toBe(true);
  });

  it("persists dismissed version", () => {
    expect(loadDismissedVersion()).toBeNull();
    saveDismissedVersion("1.2.0");
    expect(loadDismissedVersion()).toBe("1.2.0");
  });
});

describe("download progress", () => {
  it("accumulates chunks and reports percent", () => {
    const started = applyDownloadEvent(EMPTY_DOWNLOAD_PROGRESS, {
      event: "Started",
      data: { contentLength: 1000 },
    });
    expect(started).toEqual({
      downloaded: 0,
      contentLength: 1000,
      percent: 0,
    });

    const midway = applyDownloadEvent(started, {
      event: "Progress",
      data: { chunkLength: 250 },
    });
    expect(midway.downloaded).toBe(250);
    expect(midway.percent).toBe(25);

    const finished = applyDownloadEvent(midway, { event: "Finished" });
    expect(finished.percent).toBe(100);
    expect(finished.downloaded).toBe(1000);
  });

  it("formats byte sizes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2 KB");
    expect(
      formatDownloadProgress({
        downloaded: 512,
        contentLength: 1024,
        percent: 50,
      }),
    ).toBe("512 B / 1 KB");
  });
});

describe("updaterStatusLabel", () => {
  it("describes each status", () => {
    expect(updaterStatusLabel({ status: "idle" })).toMatch(/GitHub/);
    expect(
      updaterStatusLabel({ status: "available", availableVersion: "1.2.0" }),
    ).toBe("Có bản 1.2.0");
    expect(updaterStatusLabel({ status: "error", error: "Mất mạng" })).toBe(
      "Mất mạng",
    );
  });
});
