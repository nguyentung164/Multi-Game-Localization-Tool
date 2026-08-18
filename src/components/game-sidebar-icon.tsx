import { ImageIcon } from "lucide-react"
import type { GameNavigationId } from "@/lib/navigation"
import { cn } from "@/lib/utils"

type GameSidebarIconProps = {
  gameId: GameNavigationId
  label: string
  src?: string
  onPick: (gameId: GameNavigationId) => void
  className?: string
}

export function GameSidebarIcon({
  gameId,
  label,
  src,
  onPick,
  className,
}: GameSidebarIconProps) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={cn(
        "relative flex size-4 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-sm ring-sidebar-ring outline-hidden hover:opacity-80 focus-visible:ring-2",
        className,
      )}
      title="Chọn icon trò chơi (.ico)"
      aria-label={`Chọn icon cho ${label}`}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onPick(gameId)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        event.stopPropagation()
        onPick(gameId)
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="size-4 object-contain"
          draggable={false}
        />
      ) : (
        <ImageIcon aria-hidden="true" className="size-4 opacity-60" />
      )}
    </span>
  )
}
