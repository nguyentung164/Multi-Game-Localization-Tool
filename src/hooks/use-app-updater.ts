import { useCallback, useEffect, useRef, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { relaunch } from "@tauri-apps/plugin-process"
import type { Update } from "@tauri-apps/plugin-updater"
import { APP_NAME, APP_VERSION } from "@/lib/app-meta"
import {
  applyDownloadEvent,
  EMPTY_DOWNLOAD_PROGRESS,
  loadAutoCheckEnabled,
  loadDismissedVersion,
  saveAutoCheckEnabled,
  saveDismissedVersion,
  shouldAutoCheck,
  shouldPrompt,
  shouldSuppressUpdateAutoPrompt,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_HANDLE_RESTORING_MESSAGE,
  UPDATE_JOB_RUNNING_MESSAGE,
  UPDATE_RESTART_REQUIRED_MESSAGE,
  UPDATE_RUNTIME_SHUTDOWN_HINT,
  type AvailableAppUpdate,
  type DownloadProgress,
  type UpdaterStatus,
} from "@/lib/app-updater"
import {
  isMainWindowVisible,
  sendDesktopNotification,
} from "@/lib/desktop-notification"
import { checkDesktopUpdate } from "@/lib/desktop-update"
import { toast } from "@/lib/safe-toast"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"

export type AppUpdater = ReturnType<typeof useAppUpdater>

type UseAppUpdaterOptions = {
  busy: boolean
  ready: boolean
  isDev?: boolean
  notificationsEnabled?: boolean
}

function toAvailableUpdate(
  update: Update,
  detectedAtMs = Date.now(),
): AvailableAppUpdate {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body?.trim() ?? "",
    date: update.date,
    detectedAtMs,
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
  notificationsEnabled = true,
}: UseAppUpdaterOptions) {
  const [status, setStatus] = useState<UpdaterStatus>("idle")
  const [currentVersion, setCurrentVersion] = useState(APP_VERSION)
  const [available, setAvailable] = useState<AvailableAppUpdate | null>(null)
  const [progress, setProgress] = useState<DownloadProgress>(
    EMPTY_DOWNLOAD_PROGRESS,
  )
  const [error, setError] = useState<string | null>(null)
  const [errorAtMs, setErrorAtMs] = useState<number | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [autoCheckEnabled, setAutoCheckEnabledState] =
    useState(loadAutoCheckEnabled)
  const [restoringHandle, setRestoringHandle] = useState(false)
  const updateRef = useRef<Update | null>(null)
  const availableRef = useRef<AvailableAppUpdate | null>(null)
  const busyRef = useRef(busy)
  const notificationsEnabledRef = useRef(notificationsEnabled)
  const autoCheckedRef = useRef(false)
  const toastedVersionRef = useRef<string | null>(null)
  const suppressAutoPromptRef = useRef(false)
  const downloadedRef = useRef(false)
  const installInFlightRef = useRef(false)
  const cancelledRef = useRef(false)
  const restoreInFlightRef = useRef(false)

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled
  }, [notificationsEnabled])

  useEffect(() => {
    availableRef.current = available
  }, [available])

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

  const notifyIfWindowHidden = useCallback(
    async (title: string, body: string) => {
      if (!(await isMainWindowVisible())) {
        await sendDesktopNotification({
          title,
          body,
          enabled: notificationsEnabledRef.current,
        })
      }
    },
    [],
  )

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
          void notifyIfWindowHidden(
            APP_NAME,
            `Phiên bản ${update.version} sẵn sàng. Cài sau khi tác vụ hiện tại kết thúc.`,
          )
        }
        return
      }
      setDialogOpen(true)
      void notifyIfWindowHidden(
        APP_NAME,
        `Có bản ${update.version}. Mở app để cài đặt.`,
      )
    },
    [notifyIfWindowHidden],
  )

  const restoreUpdateHandle = useCallback(async () => {
    if (restoreInFlightRef.current) return
    restoreInFlightRef.current = true
    setRestoringHandle(true)
    setStatus("available")
    try {
      const update = await checkDesktopUpdate({
        timeout: UPDATE_CHECK_TIMEOUT_MS,
      })
      const previous = availableRef.current
      await replaceUpdate(update)
      if (!update) {
        setAvailable(null)
        setStatus("upToDate")
        return
      }
      setAvailable(
        toAvailableUpdate(
          update,
          previous?.version === update.version
            ? previous.detectedAtMs
            : Date.now(),
        ),
      )
      setStatus("available")
    } catch (caught) {
      const message = formatInvokeError(caught)
      setStatus("error")
      setError(message)
      setErrorAtMs(Date.now())
    } finally {
      restoreInFlightRef.current = false
      setRestoringHandle(false)
    }
  }, [replaceUpdate])

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
      setErrorAtMs(null)
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
          if (!silent) {
            toast.message("Đang dùng phiên bản mới nhất")
          }
          return null
        }

        const previous = availableRef.current
        const availableUpdate = toAvailableUpdate(
          update,
          previous?.version === update.version
            ? previous.detectedAtMs
            : Date.now(),
        )
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
        setErrorAtMs(Date.now())
        toast.error("Không kiểm tra được bản cập nhật", {
          description: message,
        })
        void notifyIfWindowHidden(
          APP_NAME,
          `Không kiểm tra được bản cập nhật: ${message}`,
        )
        return null
      }
    },
    [isDev, notifyIfWindowHidden, openPrompt, replaceUpdate],
  )

  const installUpdate = useCallback(async () => {
    if (installInFlightRef.current) return
    if (restoreInFlightRef.current) {
      toast.message(UPDATE_HANDLE_RESTORING_MESSAGE)
      return
    }
    installInFlightRef.current = true
    cancelledRef.current = false
    try {
      if (busyRef.current) {
        toast.message(UPDATE_JOB_RUNNING_MESSAGE)
        return
      }
      const update = updateRef.current
      if (!update) {
        toast.message(UPDATE_HANDLE_RESTORING_MESSAGE)
        void restoreUpdateHandle()
        return
      }

      setError(null)
      setErrorAtMs(null)
      let didShutdownRuntime = false
      try {
        if (!downloadedRef.current) {
          setStatus("downloading")
          setProgress(EMPTY_DOWNLOAD_PROGRESS)
          await update.download((event) => {
            if (cancelledRef.current) return
            setProgress((current) => applyDownloadEvent(current, event))
            if (event.event === "Finished") setStatus("installing")
          })
          if (cancelledRef.current) {
            downloadedRef.current = false
            setProgress(EMPTY_DOWNLOAD_PROGRESS)
            toast.message("Đã hủy tải bản cập nhật.")
            await restoreUpdateHandle()
            return
          }
          downloadedRef.current = true
        }
        setStatus("installing")
        if (busyRef.current) {
          setStatus("available")
          toast.message(UPDATE_JOB_RUNNING_MESSAGE)
          return
        }
        await ipc.shutdownRuntime()
        didShutdownRuntime = true
        await update.install()
        downloadedRef.current = false
        try {
          await relaunch()
        } catch {
          setStatus("restartRequired")
          setAvailable(null)
          toast.message(UPDATE_RESTART_REQUIRED_MESSAGE)
        }
      } catch (caught) {
        if (cancelledRef.current) {
          downloadedRef.current = false
          setProgress(EMPTY_DOWNLOAD_PROGRESS)
          toast.message("Đã hủy tải bản cập nhật.")
          await restoreUpdateHandle()
          return
        }
        const message = formatInvokeError(caught)
        const detail = didShutdownRuntime
          ? `${message} ${UPDATE_RUNTIME_SHUTDOWN_HINT}`
          : message
        setStatus("error")
        setError(detail)
        setErrorAtMs(Date.now())
        toast.error(message, {
          description: didShutdownRuntime
            ? UPDATE_RUNTIME_SHUTDOWN_HINT
            : undefined,
        })
      }
    } finally {
      installInFlightRef.current = false
    }
  }, [restoreUpdateHandle])

  const cancelDownload = useCallback(async () => {
    if (status !== "downloading") return
    cancelledRef.current = true
    setRestoringHandle(true)
    const current = updateRef.current
    if (current) {
      try {
        await current.close()
      } catch {
        /* download abort / resource already gone */
      }
    }
  }, [status])

  const closeDialog = useCallback((options?: { dismiss?: boolean }) => {
    setDialogOpen(false)
    suppressAutoPromptRef.current = shouldSuppressUpdateAutoPrompt({
      dismissed: options?.dismiss === true,
      busy: busyRef.current,
    })
  }, [])

  const dismissUpdate = useCallback(() => {
    const version = available?.version
    if (version) saveDismissedVersion(version)
    closeDialog({ dismiss: true })
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

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void ipc.listenToOpenAppUpdate(() => {
      if (availableRef.current) {
        setDialogOpen(true)
        return
      }
      void checkForUpdate()
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [checkForUpdate])

  return {
    status,
    currentVersion,
    available,
    progress,
    error,
    errorAtMs,
    dialogOpen,
    autoCheckEnabled,
    restoringHandle,
    setAutoCheckEnabled,
    setDialogOpen: setDialogOpenSafe,
    checkForUpdate,
    installUpdate,
    cancelDownload,
    dismissUpdate,
  }
}
