import { useEffect, useState } from "react"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { toast } from "sonner"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"

export type DroppedFileKind =
  | "legend-source"
  | "civ7-glossary"
  | "legend-glossary"
  | "unsupported"

export type ClassifiedDrop = {
  path: string
  kind: DroppedFileKind
}

export function useFileDrop(
  onDrop: (classified: ClassifiedDrop, extraCount: number) => void,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (!isTauriRuntime() || !enabled) return

    let unlisten: (() => void) | undefined
    let cancelled = false

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragOver(true)
          return
        }

        setDragOver(false)
        if (event.payload.type !== "drop") return

        const paths = event.payload.paths
        if (paths.length === 0) return

        const extraCount = Math.max(0, paths.length - 1)
        void ipc
          .classifyDroppedPath(paths[0])
          .then((classified) => onDrop(classified, extraCount))
          .catch((error) => {
            toast.error(formatInvokeError(error))
          })
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })

    return () => {
      cancelled = true
      unlisten?.()
      setDragOver(false)
    }
  }, [enabled, onDrop])

  return { dragOver: enabled && dragOver }
}
