import { FileUpIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function FileDropOverlay({
  visible,
  className,
}: {
  visible: boolean
  className?: string
}) {
  if (!visible) return null

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm",
        className,
      )}
    >
      <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-primary/50 bg-background/95 px-8 py-10 text-center shadow-lg">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary-soft-gradient text-primary">
          <FileUpIcon aria-hidden="true" className="size-7" />
        </span>
        <div className="space-y-1">
          <p className="text-base font-medium">Thả file để mở</p>
          <p className="text-sm text-muted-foreground">
            Legend.txt hoặc glossary JSON (CIV7 / Tam Quốc)
          </p>
        </div>
      </div>
    </div>
  )
}
