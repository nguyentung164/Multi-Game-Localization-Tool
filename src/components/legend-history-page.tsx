import { useCallback, useEffect, useState } from "react"
import {
  ArchiveRestoreIcon,
  CalendarDaysIcon,
  DatabaseBackupIcon,
  FileDiffIcon,
  FileJsonIcon,
  FolderOpenIcon,
  HistoryIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { AsyncPageShell } from "@/components/async-page-shell"
import { useAsyncTask } from "@/hooks/use-async-task"
import {
  PageHeader,
  formatNumber,
  pageContainerClass,
} from "@/components/product-ui"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { formatDateTime } from "@/lib/format-date"
import type { LegendBackup, LegendPreviewSummary } from "@/lib/legend-types"
import { displayWindowsPath } from "@/lib/path-utils"
import { cn } from "@/lib/utils"
import { formatInvokeError, invokeErrorCode, ipc } from "@/lib/tauri-ipc"

function pathDirname(filePath: string): string {
  const normalized = displayWindowsPath(filePath).replace(/[/\\]+$/, "")
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  )
  return index >= 0 ? normalized.slice(0, index) : normalized
}

export function LegendHistoryPage({
  locked = false,
  onRestored,
  onAdoptPreview,
}: {
  locked?: boolean
  onRestored?: (sourcePath: string) => void
  onAdoptPreview?: (previewPath: string) => Promise<boolean | void>
}) {
  const [previews, setPreviews] = useState<LegendPreviewSummary[]>([])
  const [backups, setBackups] = useState<LegendBackup[]>([])
  const [backupDetail, setBackupDetail] = useState<LegendBackup | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<LegendBackup | null>(null)
  const [forceRestoreTarget, setForceRestoreTarget] = useState<LegendBackup | null>(
    null,
  )
  const [deleteTarget, setDeleteTarget] = useState<LegendBackup | null>(null)
  const {
    run: runAsyncTask,
    loading,
    title: loadingTitle,
    description: loadingDescription,
    phase: loadingPhase,
    phaseLabel: loadingPhaseLabel,
    progress: loadingProgress,
  } = useAsyncTask({ title: "Đang tải báo cáo…" })

  const refresh = useCallback(async () => {
    try {
      await runAsyncTask({
        title: "Đang tải báo cáo…",
        description: "Liệt kê preview và backup Legend.",
        task: async () => {
          const [nextPreviews, nextBackups] = await Promise.all([
            ipc.listLegendPreviews(),
            ipc.listLegendBackups(),
          ])
          return { nextPreviews, nextBackups }
        },
        renderResult: ({ nextPreviews, nextBackups }) => {
          setPreviews(nextPreviews)
          setBackups(nextBackups)
        },
      })
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }, [runAsyncTask])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function restore(backup: LegendBackup, force = false) {
    try {
      const source = await runAsyncTask({
        title: "Đang khôi phục backup…",
        description: "Engine đang ghi file nguồn từ backup.",
        phase: "applying",
        task: () => ipc.restoreLegendBackup(backup.id, force),
      })
      if (!source) return
      toast.success(
        force ? "Đã force restore backup Legend." : "Đã khôi phục backup Legend.",
      )
      onRestored?.(source)
      await refresh()
    } catch (error) {
      const message = formatInvokeError(error)
      if (!force && invokeErrorCode(error) === "fingerprint_conflict") {
        setForceRestoreTarget(backup)
        toast.message(message)
        return
      }
      toast.error(message)
    }
  }

  const openPreviewFolder = () => {
    const folderPath =
      previews[0]?.previewPath != null
        ? pathDirname(previews[0].previewPath)
        : null
    if (!folderPath) {
      toast.message("Chưa có preview — thư mục sẽ có sau lần dịch đầu tiên.")
      return
    }
    void ipc
      .openFile(folderPath)
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  const openPreviewArtifact = (
    preview: LegendPreviewSummary,
    kind: "json" | "folder",
  ) => {
    const path =
      kind === "json" ? preview.previewPath : pathDirname(preview.previewPath)
    void ipc
      .openFile(path)
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  const adoptPreview = (previewPath: string) => {
    if (!onAdoptPreview) {
      toast.message("Mở preview chỉ khả dụng trong ứng dụng desktop.")
      return
    }
    void onAdoptPreview(previewPath).then((ok) => {
      if (ok === false) return
      toast.success("Đã mở preview trong trang Dịch.")
    })
  }

  const hasPreviews = previews.length > 0

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <AsyncPageShell
        className={cn(pageContainerClass, "flex min-h-0 flex-1 flex-col")}
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
          eyebrow="Lịch sử & phục hồi"
          title="Báo cáo"
          description="Theo dõi preview dịch, mở artifact chi tiết và quản lý backup Apply."
          action={
            <Button variant="outline" disabled={loading} onClick={openPreviewFolder}>
              <FolderOpenIcon data-icon="inline-start" />
              Mở thư mục preview
            </Button>
          }
        />

        <Tabs defaultValue="history" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="history">
              <HistoryIcon />
              Lịch sử chạy
            </TabsTrigger>
            <TabsTrigger value="backups">
              <DatabaseBackupIcon />
              Backup Center
            </TabsTrigger>
          </TabsList>

          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <Card className="flex min-h-0 flex-1 flex-col">
              <CardHeader className="shrink-0">
                <div>
                  <CardTitle>Preview dịch gần đây</CardTitle>
                  <CardDescription>
                    Artifact JSON trong AppData — mở bảng diff hoặc file kỹ thuật
                  </CardDescription>
                </div>
                <CardAction>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading}
                    onClick={() => void refresh()}
                  >
                    Làm mới
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
                  <Table
                    className="table-fixed"
                    containerClassName="overflow-visible"
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10 whitespace-normal text-center">
                          No
                        </TableHead>
                        <TableHead className="w-40">Thời gian</TableHead>
                        <TableHead className="whitespace-normal">Preview</TableHead>
                        <TableHead className="w-28 text-center">Diff</TableHead>
                        <TableHead className="w-32 text-center">Artifact</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!hasPreviews ? (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="text-center text-sm text-muted-foreground"
                          >
                            Chưa có preview nào — chạy dịch từ trang Dịch.
                          </TableCell>
                        </TableRow>
                      ) : (
                        previews.map((preview, index) => (
                          <TableRow key={preview.previewPath}>
                            <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                              {index + 1}
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-2 text-xs leading-tight">
                                <CalendarDaysIcon
                                  aria-hidden="true"
                                  className="size-4 shrink-0 text-muted-foreground"
                                />
                                {formatDateTime(preview.createdAt)}
                              </span>
                            </TableCell>
                            <TableCell className="max-w-0 truncate text-xs font-medium leading-tight">
                              {preview.previewId}
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge variant="secondary">
                                {formatNumber(preview.changedLines)} dòng
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              <div className="flex items-center justify-center gap-0.5">
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label="Mở bảng diff"
                                  disabled={locked || loading}
                                  onClick={() => adoptPreview(preview.previewPath)}
                                >
                                  <FileDiffIcon />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label="Mở JSON"
                                  onClick={() =>
                                    openPreviewArtifact(preview, "json")
                                  }
                                >
                                  <FileJsonIcon />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label="Mở thư mục"
                                  onClick={() =>
                                    openPreviewArtifact(preview, "folder")
                                  }
                                >
                                  <FolderOpenIcon />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="backups" className="min-h-0 flex-1 overflow-y-auto">
            {backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Chưa có backup Legend. Backup sẽ xuất hiện sau lần Apply đầu tiên.
              </p>
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
                        <Badge
                          variant={backup.valid ? "secondary" : "destructive"}
                        >
                          {backup.safety
                            ? "Safety"
                            : backup.valid
                              ? "Hợp lệ"
                              : "Lỗi"}
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
                          variant="outline"
                          onClick={() => setBackupDetail(backup)}
                        >
                          Chi tiết
                        </Button>
                        <Button
                          size="sm"
                          variant={actionBtn.restore}
                          disabled={
                            locked || !backup.valid || backup.safety || loading
                          }
                          onClick={() => setRestoreTarget(backup)}
                        >
                          <ArchiveRestoreIcon data-icon="inline-start" />
                          Khôi phục
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void ipc.openLegendBackupFolder(backup.id)
                          }
                        >
                          <FolderOpenIcon data-icon="inline-start" />
                          Mở backup
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={locked || loading}
                          onClick={() => setDeleteTarget(backup)}
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
          </TabsContent>
        </Tabs>
      </AsyncPageShell>

      <Dialog
        open={Boolean(backupDetail)}
        onOpenChange={(value) => !value && setBackupDetail(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chi tiết backup</DialogTitle>
            <DialogDescription>
              {backupDetail
                ? `${formatDateTime(backupDetail.createdAt)} · ${backupDetail.id}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {backupDetail && (
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">File nguồn: </span>
                {displayWindowsPath(backupDetail.sourcePath)}
              </p>
              <p>
                <span className="text-muted-foreground">Thư mục backup: </span>
                {displayWindowsPath(backupDetail.backupPath)}
              </p>
              <p className="break-all">
                <span className="text-muted-foreground">Fingerprint nguồn: </span>
                {backupDetail.sourceFingerprint}
              </p>
              <p className="break-all">
                <span className="text-muted-foreground">Fingerprint áp dụng: </span>
                {backupDetail.appliedFingerprint}
              </p>
            </div>
          )}
          <Button
            variant="outline"
            onClick={() => {
              if (!backupDetail) return
              void ipc.openLegendBackupFolder(backupDetail.id)
            }}
          >
            <FolderOpenIcon data-icon="inline-start" />
            Mở thư mục backup
          </Button>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(restoreTarget)}
        onOpenChange={(value) => !value && setRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Khôi phục backup này?</AlertDialogTitle>
            <AlertDialogDescription>
              Ứng dụng sẽ tạo safety backup rồi ghi file nguồn từ snapshot{" "}
              {restoreTarget?.id}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant={actionBtn.restore}
              onClick={() => {
                if (!restoreTarget) return
                const backup = restoreTarget
                setRestoreTarget(null)
                void restore(backup)
              }}
            >
              <ArchiveRestoreIcon data-icon="inline-start" />
              Khôi phục an toàn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(forceRestoreTarget)}
        onOpenChange={(value) => !value && setForceRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fingerprint không khớp</AlertDialogTitle>
            <AlertDialogDescription>
              File nguồn đã thay đổi kể từ khi backup được tạo. Vẫn khôi phục và
              tạo safety backup trước khi ghi?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant={actionBtn.restore}
              onClick={() => {
                if (!forceRestoreTarget) return
                const backup = forceRestoreTarget
                setForceRestoreTarget(null)
                void restore(backup, true)
              }}
            >
              Force restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(value) => !value && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa backup này?</AlertDialogTitle>
            <AlertDialogDescription>
              Thư mục backup {deleteTarget?.id} sẽ bị xóa vĩnh viễn khỏi ổ đĩa.
              Thao tác này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return
                const backupId = deleteTarget.id
                if (backupDetail?.id === backupId) {
                  setBackupDetail(null)
                }
                setDeleteTarget(null)
                void runAsyncTask({
                  title: "Đang xóa backup…",
                  description: "Đang cập nhật danh sách backup Legend.",
                  phase: "saving",
                  task: async () => {
                    await ipc.deleteLegendBackup(backupId)
                    const [nextPreviews, nextBackups] = await Promise.all([
                      ipc.listLegendPreviews(),
                      ipc.listLegendBackups(),
                    ])
                    return { nextPreviews, nextBackups }
                  },
                  renderResult: ({ nextPreviews, nextBackups }) => {
                    setPreviews(nextPreviews)
                    setBackups(nextBackups)
                  },
                })
                  .then(() => toast.success("Đã xóa backup."))
                  .catch((error) => toast.error(formatInvokeError(error)))
              }}
            >
              <Trash2Icon data-icon="inline-start" />
              Xóa vĩnh viễn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
