import { useCallback, useEffect, useState } from "react"
import {
  ArchiveRestoreIcon,
  DatabaseBackupIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { AsyncPageShell } from "@/components/async-page-shell"
import { PageHeader, pageContainerClass } from "@/components/product-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { actionBtn } from "@/lib/action-button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { formatDateTime } from "@/lib/format-date"
import type { LegendBackup } from "@/lib/legend-types"
import { displayWindowsPath } from "@/lib/path-utils"
import { formatInvokeError, invokeErrorCode, ipc } from "@/lib/tauri-ipc"
import { useAsyncTask } from "@/hooks/use-async-task"

export function LegendHistoryPage({
  locked = false,
  onRestored,
}: {
  locked?: boolean
  onRestored?: (sourcePath: string) => void
}) {
  const [backups, setBackups] = useState<LegendBackup[]>([])
  const {
    run: runAsyncTask,
    loading,
    title: loadingTitle,
    description: loadingDescription,
    phase: loadingPhase,
    phaseLabel: loadingPhaseLabel,
    progress: loadingProgress,
  } = useAsyncTask({ title: "Đang tải lịch sử…" })

  const refresh = useCallback(async () => {
    try {
      await runAsyncTask({
        title: "Đang tải lịch sử…",
        description: "Liệt kê backup Legend.",
        task: () => ipc.listLegendBackups(),
        renderResult: setBackups,
      })
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }, [runAsyncTask])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function restore(backup: LegendBackup, force = false) {
    if (
      !force &&
      !window.confirm(
        "Ứng dụng sẽ tạo safety backup rồi khôi phục file này. Tiếp tục?",
      )
    ) {
      return
    }
    try {
      const source = await runAsyncTask({
        title: "Đang khôi phục backup…",
        description: "Engine đang ghi file nguồn từ backup.",
        phase: "applying",
        task: () => ipc.restoreLegendBackup(backup.id, force),
      })
      if (!source) return
      toast.success(force ? "Đã force restore backup Legend." : "Đã khôi phục backup Legend.")
      onRestored?.(source)
      await refresh()
    } catch (error) {
      const message = formatInvokeError(error)
      if (
        !force &&
        invokeErrorCode(error) === "fingerprint_conflict" &&
        window.confirm(`${message}\n\nVẫn khôi phục và tạo safety backup?`)
      ) {
        await restore(backup, true)
        return
      }
      toast.error(message)
    }
  }

  return (
    <AsyncPageShell
      className={pageContainerClass}
      loading={loading}
      overlay={{
        title: loadingTitle,
        description: loadingDescription,
        phase: loadingPhase ?? undefined,
        phaseLabel: loadingPhaseLabel ?? undefined,
        progress: loadingProgress,
      }}
    >
      <PageHeader
        eyebrow="Legend of Heroes Three Kingdoms"
        title="Lịch sử & hoàn tác"
        description="Mỗi lần Apply đều có backup; restore luôn tạo safety snapshot trước khi ghi."
        action={
          <Button variant="outline" disabled={loading} onClick={refresh}>
            <RefreshCwIcon data-icon="inline-start" />
            Làm mới
          </Button>
        }
      />
      {backups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Chưa có backup Legend</EmptyTitle>
            <EmptyDescription>
              Backup sẽ xuất hiện sau lần Apply đầu tiên.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {backups.map((backup) => (
            <Card key={backup.id}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <DatabaseBackupIcon aria-hidden="true" />
                  <CardTitle>{backup.id}</CardTitle>
                </div>
                <CardDescription>
                  {formatDateTime(backup.createdAt)}
                </CardDescription>
                <CardAction>
                  <Badge variant={backup.valid ? "secondary" : "destructive"}>
                    {backup.safety ? "Safety" : backup.valid ? "Hợp lệ" : "Lỗi"}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="truncate text-sm text-muted-foreground">
                  {displayWindowsPath(backup.sourcePath)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={actionBtn.restore}
                    disabled={locked || !backup.valid || backup.safety}
                    onClick={() => void restore(backup)}
                  >
                    <ArchiveRestoreIcon data-icon="inline-start" />
                    Khôi phục
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void ipc.openLegendBackupFolder(backup.id)}
                  >
                    <FolderOpenIcon data-icon="inline-start" />
                    Mở backup
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={locked}
                    onClick={() => {
                      if (!window.confirm("Xóa vĩnh viễn backup này?")) return
                      void runAsyncTask({
                        title: "Đang xóa backup…",
                        description: "Đang cập nhật danh sách backup Legend.",
                        phase: "saving",
                        task: async () => {
                          await ipc.deleteLegendBackup(backup.id)
                          return ipc.listLegendBackups()
                        },
                        renderResult: setBackups,
                      }).catch((error) =>
                        toast.error(formatInvokeError(error)),
                      )
                    }}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Xóa
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </AsyncPageShell>
  )
}
