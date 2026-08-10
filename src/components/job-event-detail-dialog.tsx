import { useEffect, useMemo, useState, startTransition } from "react"
import { Loader2Icon } from "lucide-react"
import { JsonTreeView } from "@/components/json-tree-view"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatJsonByteSize } from "@/lib/json-highlight"
import { cn } from "@/lib/utils"

export function JobEventDetailDialog({
  open,
  onOpenChange,
  title,
  timestamp,
  detail,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  timestamp: string
  detail: unknown
}) {
  const [ready, setReady] = useState(false)
  const [metaText, setMetaText] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState({ open, detail })

  if (open !== snapshot.open || detail !== snapshot.detail) {
    setSnapshot({ open, detail })
    setReady(false)
    setMetaText(null)
  }

  useEffect(() => {
    if (!open) return

    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        try {
          setMetaText(JSON.stringify(detail, null, 2))
        } catch {
          setMetaText(String(detail))
        } finally {
          setReady(true)
        }
      })
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [open, detail])

  const byteSize = useMemo(
    () => (metaText ? new TextEncoder().encode(metaText).length : 0),
    [metaText],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex h-[min(92vh,56rem)] w-[min(96vw,80rem)] max-w-none flex-col gap-3 p-5 sm:max-w-none",
        )}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Chi tiết kỹ thuật</DialogTitle>
          <DialogDescription>
            {title} · {timestamp}
            {metaText && <> · {formatJsonByteSize(byteSize)}</>}
          </DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 rounded-lg border bg-muted/30 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Đang chuẩn bị JSON…
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/40">
            <JsonTreeView value={detail} defaultExpandedDepth={1} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
