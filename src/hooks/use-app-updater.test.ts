import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_CHECK_STORAGE_KEY,
  DISMISSED_VERSION_STORAGE_KEY,
  UPDATE_CHECK_TIMEOUT_MS,
} from "@/lib/app-updater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
  shutdownRuntime: vi.fn(async () => undefined),
  toast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-update", () => ({
  checkDesktopUpdate: mocks.check,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
}));

vi.mock("@/lib/tauri-ipc", () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
  formatInvokeError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ipc: {
    shutdownRuntime: () => mocks.shutdownRuntime(),
  },
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

import { useAppUpdater } from "@/hooks/use-app-updater";

function mockUpdate(overrides?: {
  version?: string;
  currentVersion?: string;
  body?: string;
  download?: ReturnType<typeof vi.fn>;
  install?: ReturnType<typeof vi.fn>;
}) {
  return {
    version: overrides?.version ?? "1.2.0",
    currentVersion: overrides?.currentVersion ?? "1.1.0",
    body: overrides?.body ?? "Sửa lỗi updater",
    download: overrides?.download ?? vi.fn(async () => undefined),
    install: overrides?.install ?? vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("useAppUpdater", () => {
  beforeEach(() => {
    mocks.check.mockReset();
    mocks.relaunch.mockReset().mockResolvedValue(undefined);
    mocks.getVersion.mockReset().mockResolvedValue("1.1.0");
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.shutdownRuntime.mockReset().mockResolvedValue(undefined);
    mocks.toast.message.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    window.localStorage.removeItem(AUTO_CHECK_STORAGE_KEY);
    window.localStorage.removeItem(DISMISSED_VERSION_STORAGE_KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(AUTO_CHECK_STORAGE_KEY);
    window.localStorage.removeItem(DISMISSED_VERSION_STORAGE_KEY);
  });

  it("skips auto-check in dev mode", async () => {
    renderHook(() => useAppUpdater({ busy: false, ready: true, isDev: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("auto-checks and opens the dialog when idle", async () => {
    mocks.check.mockResolvedValue(mockUpdate());
    const { result } = renderHook(() =>
      useAppUpdater({ busy: false, ready: true, isDev: false }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("available");
    });
    expect(mocks.check).toHaveBeenCalledWith({
      timeout: UPDATE_CHECK_TIMEOUT_MS,
    });
    expect(result.current.available?.version).toBe("1.2.0");
    expect(result.current.dialogOpen).toBe(true);
  });

  it("toasts instead of installing while a job is running", async () => {
    mocks.check.mockResolvedValue(mockUpdate());
    const { result, rerender } = renderHook(
      ({ busy }: { busy: boolean }) =>
        useAppUpdater({ busy, ready: true, isDev: false }),
      { initialProps: { busy: true } },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("available");
    });
    expect(result.current.dialogOpen).toBe(false);
    expect(mocks.toast.message).toHaveBeenCalled();

    rerender({ busy: false });
    await waitFor(() => {
      expect(result.current.dialogOpen).toBe(true);
    });
  });

  it("does not auto-prompt a dismissed version", async () => {
    window.localStorage.setItem(DISMISSED_VERSION_STORAGE_KEY, "1.2.0");
    mocks.check.mockResolvedValue(mockUpdate());
    const { result } = renderHook(() =>
      useAppUpdater({ busy: false, ready: true, isDev: false }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("available");
    });
    expect(result.current.dialogOpen).toBe(false);
  });

  it("blocks install while busy then downloads when idle", async () => {
    const download = vi.fn(async () => undefined);
    const install = vi.fn(async () => undefined);
    mocks.check.mockResolvedValue(mockUpdate({ download, install }));
    const { result, rerender } = renderHook(
      ({ busy }: { busy: boolean }) =>
        useAppUpdater({ busy, ready: true, isDev: false }),
      { initialProps: { busy: true } },
    );

    await waitFor(() => {
      expect(result.current.available?.version).toBe("1.2.0");
    });

    await act(async () => {
      await result.current.installUpdate();
    });
    expect(download).not.toHaveBeenCalled();

    rerender({ busy: false });
    await act(async () => {
      await result.current.installUpdate();
    });
    expect(download).toHaveBeenCalled();
    expect(mocks.shutdownRuntime).toHaveBeenCalled();
    expect(install).toHaveBeenCalled();
    expect(mocks.relaunch).toHaveBeenCalled();
  });

  it("keeps the download and skips install if a job starts after download", async () => {
    let finishDownload!: () => void;
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    const install = vi.fn(async () => undefined);
    mocks.check.mockResolvedValue(mockUpdate({ download, install }));
    const { result, rerender } = renderHook(
      ({ busy }: { busy: boolean }) =>
        useAppUpdater({ busy, ready: true, isDev: false }),
      { initialProps: { busy: false } },
    );

    await waitFor(() => {
      expect(result.current.available?.version).toBe("1.2.0");
    });

    let installPromise!: Promise<void>;
    act(() => {
      installPromise = result.current.installUpdate();
    });
    await waitFor(() => {
      expect(download).toHaveBeenCalled();
    });

    rerender({ busy: true });
    await act(async () => {
      finishDownload();
      await installPromise;
    });

    expect(mocks.shutdownRuntime).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(result.current.status).toBe("available");

    rerender({ busy: false });
    await act(async () => {
      await result.current.installUpdate();
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownRuntime).toHaveBeenCalled();
    expect(install).toHaveBeenCalled();
  });

  it("does not install when sidecar shutdown fails", async () => {
    const download = vi.fn(async () => undefined);
    const install = vi.fn(async () => undefined);
    mocks.check.mockResolvedValue(mockUpdate({ download, install }));
    mocks.shutdownRuntime
      .mockRejectedValueOnce(new Error("Không tắt được engine"))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAppUpdater({ busy: false, ready: true, isDev: false }),
    );

    await waitFor(() => {
      expect(result.current.available?.version).toBe("1.2.0");
    });

    await act(async () => {
      await result.current.installUpdate();
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");

    await act(async () => {
      await result.current.installUpdate();
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("ignores a second install click while download is in flight", async () => {
    let finishDownload!: () => void;
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    const install = vi.fn(async () => undefined);
    mocks.check.mockResolvedValue(mockUpdate({ download, install }));
    const { result } = renderHook(() =>
      useAppUpdater({ busy: false, ready: true, isDev: false }),
    );

    await waitFor(() => {
      expect(result.current.available?.version).toBe("1.2.0");
    });

    act(() => {
      void result.current.installUpdate();
      void result.current.installUpdate();
    });
    await waitFor(() => {
      expect(download).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      finishDownload();
    });
    await waitFor(() => {
      expect(install).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the dialog without snoozing when dismissed by overlay", async () => {
    mocks.check.mockResolvedValue(mockUpdate());
    const { result } = renderHook(() =>
      useAppUpdater({ busy: false, ready: true, isDev: false }),
    );

    await waitFor(() => {
      expect(result.current.dialogOpen).toBe(true);
    });

    act(() => {
      result.current.setDialogOpen(false);
    });

    expect(result.current.dialogOpen).toBe(false);
    expect(window.localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY)).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(result.current.dialogOpen).toBe(false);
    expect(window.localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY)).toBeNull();
  });

  it("snoozes the version only when the user clicks Để sau", async () => {
    mocks.check.mockResolvedValue(mockUpdate());
    const { result } = renderHook(() =>
      useAppUpdater({ busy: false, ready: true, isDev: false }),
    );

    await waitFor(() => {
      expect(result.current.dialogOpen).toBe(true);
    });

    act(() => {
      result.current.dismissUpdate();
    });

    expect(result.current.dialogOpen).toBe(false);
    expect(window.localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY)).toBe(
      "1.2.0",
    );
  });
});
