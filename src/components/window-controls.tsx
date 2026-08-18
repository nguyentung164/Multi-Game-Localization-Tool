import { useEffect, useState, type ReactNode } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { MinusIcon, SquareIcon, XIcon } from "lucide-react"
import { isTauriRuntime } from "@/lib/tauri-ipc"
import { cn } from "@/lib/utils"

type ControlAction = "minimize" | "maximize" | "close"

async function runWindowAction(action: ControlAction) {
  const win = getCurrentWindow()
  if (action === "minimize") await win.minimize()
  else if (action === "maximize") await win.toggleMaximize()
  else await win.close()
}

function RestoreIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      fill="none"
      className={className}
    >
      <path
        d="M3.5 4.5H8.5V9.5H3.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M4.5 4.5V3H9.5V8H8.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  )
}

export function WindowControls({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!isTauriRuntime()) return

    const win = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined

    void win.isMaximized().then((value) => {
      if (!disposed) setMaximized(value)
    })

    void win
      .onResized(async () => {
        const value = await win.isMaximized()
        if (!disposed) setMaximized(value)
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  if (!isTauriRuntime()) return null

  return (
    <div
      data-no-drag
      className={cn(
        "flex h-full shrink-0 items-stretch self-stretch border-l border-border/60",
        className,
      )}
    >
      <ControlButton
        label="Thu nhỏ"
        onClick={() => void runWindowAction("minimize")}
      >
        <MinusIcon className="size-3.5" strokeWidth={2.25} />
      </ControlButton>
      <ControlButton
        label={maximized ? "Khôi phục" : "Phóng to"}
        onClick={() => void runWindowAction("maximize")}
      >
        {maximized ? (
          <RestoreIcon className="size-3" />
        ) : (
          <SquareIcon className="size-3" strokeWidth={2.25} />
        )}
      </ControlButton>
      <ControlButton
        label="Đóng"
        danger
        onClick={() => void runWindowAction("close")}
      >
        <XIcon className="size-3.5" strokeWidth={2.25} />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group relative flex w-9 items-center justify-center text-sidebar-foreground/70 outline-none transition-colors duration-150",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground",
        "active:bg-sidebar-accent/80",
        danger &&
        "hover:bg-destructive hover:text-white focus-visible:bg-destructive focus-visible:text-white active:bg-destructive/90",
      )}
    >
      <span
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md transition-transform duration-150",
          "group-active:scale-95",
          danger && "group-hover:scale-105",
        )}
      >
        {children}
      </span>
    </button>
  )
}
