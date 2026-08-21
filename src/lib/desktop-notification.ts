import { APP_NAME } from "@/lib/app-meta"
import { isTauriRuntime } from "@/lib/tauri-ipc"

export async function sendDesktopNotification(input: {
  title: string
  body: string
  enabled: boolean
}): Promise<void> {
  if (!input.enabled || !isTauriRuntime()) return
  try {
    const {
      isPermissionGranted,
      requestPermission,
      sendNotification,
    } = await import("@tauri-apps/plugin-notification")
    let granted = await isPermissionGranted()
    if (!granted) {
      granted = (await requestPermission()) === "granted"
    }
    if (!granted) return
    sendNotification({
      title: input.title.trim() || APP_NAME,
      body: input.body,
    })
  } catch {
    /* plugin / permission / OS may reject */
  }
}

export async function isMainWindowVisible(): Promise<boolean> {
  if (!isTauriRuntime()) return true
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    return await getCurrentWindow().isVisible()
  } catch {
    return true
  }
}
