import { useCallback, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import {
  loadGameIcons,
  setGameIconDataUrl,
  type GameIconMap,
} from "@/lib/game-icons"
import type { GameNavigationId } from "@/lib/navigation"
import { ipc, isTauriRuntime } from "@/lib/tauri-ipc"

const ICO_FILTERS = [{ name: "Icon", extensions: ["ico"] }]

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () =>
      reject(reader.error ?? new Error("Không đọc được file"))
    reader.readAsDataURL(file)
  })
}

async function pathToDataUrl(path: string): Promise<string> {
  const response = await fetch(convertFileSrc(path))
  if (!response.ok) {
    throw new Error("Không đọc được file icon")
  }
  const blob = await response.blob()
  return fileToDataUrl(new File([blob], "game.ico", { type: blob.type }))
}

function pickIcoViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".ico,image/x-icon,image/vnd.microsoft.icon"
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

export function useGameIcons() {
  const [icons, setIcons] = useState<GameIconMap>(() => loadGameIcons())

  const pickGameIcon = useCallback(async (gameId: GameNavigationId) => {
    try {
      let dataUrl: string | null = null

      if (isTauriRuntime()) {
        const path = await ipc.pickFile(undefined, ICO_FILTERS)
        if (!path) return
        dataUrl = await pathToDataUrl(path)
      } else {
        const file = await pickIcoViaInput()
        if (!file) return
        dataUrl = await fileToDataUrl(file)
      }

      if (!dataUrl.startsWith("data:")) return
      setIcons(setGameIconDataUrl(gameId, dataUrl))
    } catch {
      // Ignore pick/read failures silently.
    }
  }, [])

  return { icons, pickGameIcon }
}
