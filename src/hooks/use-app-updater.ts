import { useCallback, useEffect, useRef, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { relaunch } from "@tauri-apps/plugin-process"
import type { Update } from "@tauri-apps/plugin-updater"
import { toast } from "sonner"
import { APP_VERSION } from "@/lib/app-meta"
import {
  applyDownloadEvent,
  EMPTY_DOWNLOAD_PROGRESS,
  loadAutoCheckEnabled,
  loadDismissedVersion,
  saveAutoCheckEnabled,
  saveDismissedVersion,
  shouldAutoCheck,
  shouldPrompt,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_JOB_RUNNING_MESSAGE,
  type AvailableAppUpdate,
  type DownloadProgress,
  type UpdaterStatus,
} from "@/lib/app-updater"
import { checkDesktopUpdate } from "@/lib/desktop-update"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"

export type AppUpdater = ReturnType<typeof useAppUpdater>

type UseAppUpdaterOptions = {
  busy: boolean
  ready: boolean
  isDev?: boolean
}

function toAvailableUpdate(update: Update): AvailableAppUpdate {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body?.trim() ?? "",
    date: update.date,
  }
}

async function readRuntimeVersion(): Promise<string> {
  if (!isTauriRuntime()) return APP_VERSION
  try {
    return await getVersion()
  } catch {
    return APP_VERSION
  }
}

export function useAppUpdater({
  busy,
  ready,
  isDev = import.meta.env.DEV,
}: UseAppUpdaterOptions) {
  const [status, setStatus] = useState<UpdaterStatus>("idle")
  const [currentVersion, setCurrentVersion] = useState(APP_VERSION)
  const [available, setAvailable] = useState<AvailableAppUpdate | null>(null)
  const [progress, setProgress] = useState<DownloadProgress>(
    EMPTY_DOWNLOAD_PROGRESS,
  )
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [autoCheckEnabled, setAutoCheckEnabledState] =
    useState(loadAutoCheckEnabled)
  const updateRef = useRef<Update | null>(null)
  const busyRef = useRef(busy)
  const autoCheckedRef = useRef(false)
  const toastedVersionRef = useRef<string | null>(null)
  const suppressAutoPromptRef = useRef(false)
  const downloadedRef = useRef(false)
  const installInFlightRef = useRef(false)

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const replaceUpdate = useCallback(async (next: Update | null) => {
    const previous = updateRef.current
    updateRef.current = next
    if (previous !== next) downloadedRef.current = false
    if (previous && previous !== next) {
      try {
        await previous.close()
      } catch {
        /* resource may already be gone */
      }
    }
  }, [])

  const openPrompt = useCallback(
    (update: AvailableAppUpdate, jobRunning: boolean) => {
      if (jobRunning) {
        if (toastedVersionRef.current !== update.version) {
          toastedVersionRef.current = update.version
          toast.message("Có bản cập nhật mới", {
            description: `Phiên bản ${update.version} sẵn sàng. Cài sau khi tác vụ hiện tại kết thúc.`,
            action: {
              label: "Xem",
              onClick: () => setDialogOpen(true),
            },
          })
        }
        return
      }
      setDialogOpen(true)
    },
    [],
  )

  const checkForUpdate = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false
      if (!isTauriRuntime() || isDev) {
        if (!silent) {
          toast.message("Cập nhật trong app chỉ khả dụng ở bản cài desktop.")
        }
        return null
      }

      setStatus("checking")
      setError(null)
      const runtimeVersion = await readRuntimeVersion()
      setCurrentVersion(runtimeVersion)

      try {
        const update = await checkDesktopUpdate({
          timeout: UPDATE_CHECK_TIMEOUT_MS,
        })
        await replaceUpdate(update)
        if (!update) {
          setAvailable(null)
          setStatus("upToDate")
          return null
        }

        const availableUpdate = toAvailableUpdate(update)
        setAvailable(availableUpdate)
        setStatus("available")
        suppressAutoPromptRef.current = false

        const dismissed = loadDismissedVersion()
        const prompt = shouldPrompt({
          currentVersion: runtimeVersion,
          latestVersion: availableUpdate.version,
          dismissedVersion: silent ? dismissed : null,
        })
        if (prompt) openPrompt(availableUpdate, busyRef.current)
        else if (!silent) setDialogOpen(true)
        return availableUpdate
      } catch (caught) {
        const message = formatInvokeError(caught)
        setStatus("error")
        setError(message)
        if (!silent) toast.error(message)
        return null
      }
    },
    [isDev, openPrompt, replaceUpdate],
  )

  const installUpdate = useCallback(async () => {
    if (installInFlightRef.current) return
    installInFlightRef.current = true
    try {
      if (busyRef.current) {
        toast.message(UPDATE_JOB_RUNNING_MESSAGE)
        return
      }
      const update = updateRef.current
      if (!update) {
        toast.error("Không có bản cập nhật để cài.")
        return
      }

      setError(null)
      try {
        if (!downloadedRef.current) {
          setStatus("downloading")
          setProgress(EMPTY_DOWNLOAD_PROGRESS)
          await update.download((event) => {
            setProgress((current) => applyDownloadEvent(current, event))
            if (event.event === "Finished") setStatus("installing")
          })
          downloadedRef.current = true
        }
        setStatus("installing")
        if (busyRef.current) {
          setStatus("available")
          toast.message(UPDATE_JOB_RUNNING_MESSAGE)
          return
        }
        await ipc.shutdownRuntime()
        await update.install()
        downloadedRef.current = false
        try {
          await relaunch()
        } catch {
          /* NSIS thường tự khởi động lại trên Windows */
        }
      } catch (caught) {
        const message = formatInvokeError(caught)
        setStatus("error")
        setError(message)
        toast.error(message)
      }
    } finally {
      installInFlightRef.current = false
    }
  }, [])

  const closeDialog = useCallback(() => {
    suppressAutoPromptRef.current = true
    setDialogOpen(false)
  }, [])

  const dismissUpdate = useCallback(() => {
    const version = available?.version
    if (version) saveDismissedVersion(version)
    closeDialog()
  }, [available?.version, closeDialog])

  const setAutoCheckEnabled = useCallback((enabled: boolean) => {
    saveAutoCheckEnabled(enabled)
    setAutoCheckEnabledState(enabled)
  }, [])

  const setDialogOpenSafe = useCallback(
    (open: boolean) => {
      if (!open && (status === "downloading" || status === "installing"))
        return
      if (!open) {
        closeDialog()
        return
      }
      setDialogOpen(true)
    },
    [closeDialog, status],
  )

  useEffect(() => {
    if (!ready) return
    void readRuntimeVersion().then(setCurrentVersion)
  }, [ready])

  useEffect(() => {
    if (!ready || autoCheckedRef.current) return
    if (
      !shouldAutoCheck({
        isTauri: isTauriRuntime(),
        isDev,
        autoCheckEnabled,
      })
    ) {
      return
    }
    autoCheckedRef.current = true
    const timer = window.setTimeout(() => {
      void checkForUpdate({ silent: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [autoCheckEnabled, checkForUpdate, isDev, ready])

  useEffect(() => {
    if (busy || !available || status !== "available" || dialogOpen) return
    if (suppressAutoPromptRef.current) return
    if (
      !shouldPrompt({
        currentVersion,
        latestVersion: available.version,
        dismissedVersion: loadDismissedVersion(),
      })
    ) {
      return
    }
    const timer = window.setTimeout(() => setDialogOpen(true), 0)
    return () => window.clearTimeout(timer)
  }, [available, busy, currentVersion, dialogOpen, status])

  return {
    status,
    currentVersion,
    available,
    progress,
    error,
    dialogOpen,
    autoCheckEnabled,
    setAutoCheckEnabled,
    setDialogOpen: setDialogOpenSafe,
    checkForUpdate,
    installUpdate,
    dismissUpdate,
  }
}
