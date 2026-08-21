import { useEffect, useState } from "react"
import {
  ArchiveRestoreIcon,
  CalendarDaysIcon,
  DatabaseBackupIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { InlineLoadingBlock } from "@/components/presence-fade"
import { useAsyncTask } from "@/hooks/use-async-task"
import {
  PageHeader,
  StatusBadge,
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
import type { AppController } from "@/hooks/use-app-controller"
import type { Backup } from "@/lib/app-types"
import { STEP_LABELS } from "@/lib/app-types"
import { displayWindowsPath } from "@/lib/path-utils"
import { cn } from "@/lib/utils"
import { formatInvokeError, ipc } from "@/lib/tauri-ipc"

function isCiv7Backup(backup: Backup) {
  return backup.kind !== "legend" && backup.productId !== "legend-three-kingdoms"
}

export function ReportsPage({ controller }: { controller: AppController }) {
  const { state, actions, isDesktop } = controller
  const [backupDetail, setBackupDetail] = useState<Backup | null>(null)
  const [backupFiles, setBackupFiles] = useState<string[]>([])
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null)
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false)
  const {
    run: runBackupFilesTask,
    loading: backupFilesLoading,
  } = useAsyncTask({ title: "Đang tải danh sách file…" })
  const running = state.activeJob?.status === "running"
  const hasReports = state.reports.length > 0
  const civ7Backups = state.backups.filter(isCiv7Backup)

  const backupDetailId = backupDetail?.id ?? null
  const [loadedBackupId, setLoadedBackupId] = useState<string | null>(null)
  if (backupDetailId !== loadedBackupId) {
    setLoadedBackupId(backupDetailId)
    setBackupFiles([])
  }

  useEffect(() => {
    if (!backupDetail) return

    const timer = window.setTimeout(() => {
      if (!isDesktop) {
        setBackupFiles([
          "DLC/yi-sun-sin/modules/text/en_us/AttributesText.xml",
          "DLC/nepal/modules/text/en_us/LegacyText.xml",
          "base/modules/text/en_us/UnitText.xml",
        ])
        return
      }
      void runBackupFilesTask({
        title: "Đang tải danh sách file…",
        description: "Đọc manifest backup.",
        task: () => ipc.listBackupFiles(backupDetail.id),
        renderResult: setBackupFiles,
      }).catch((error) => {
        setBackupFiles([])
        toast.error(formatInvokeError(error))
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [backupDetail, isDesktop, runBackupFilesTask])

  const openBackupFolder = () => {
    if (!backupDetail) return
    if (!isDesktop) {
      toast.message("Mở thư mục backup chỉ khả dụng trong ứng dụng desktop.")
      return
    }
    void ipc
      .openBackupFolder(backupDetail.id)
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  const openReportsFolder = () => {
    void ipc
      .openReportsFolder()
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  const openReportArtifact = (
    reportId: string,
    kind: "json" | "txt" | "folder",
  ) => {
    void ipc
      .openReport(reportId, kind)
      .catch((error) => toast.error(formatInvokeError(error)))
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className={cn(pageContainerClass, "flex min-h-0 flex-1 flex-col")}>
      <PageHeader
        eyebrow="Lịch sử & phục hồi"
        title="Báo cáo"
        description="Theo dõi các lần chạy, mở artifact chi tiết và quản lý backup mà không xóa cache hay credential."
        action={
          <Button variant="outline" onClick={openReportsFolder}>
            <FolderOpenIcon data-icon="inline-start" />
            Mở thư mục báo cáo
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
                <CardTitle>Các lần chạy gần đây</CardTitle>
                <CardDescription>
                  Dữ liệu tóm tắt dễ đọc; JSON kỹ thuật chỉ mở khi cần
                </CardDescription>
              </div>
              <CardAction>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!hasReports || running}
                  onClick={() => setClearHistoryOpen(true)}
                >
                  <Trash2Icon data-icon="inline-start" />
                  Xóa lịch sử hiển thị
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
                      <TableHead className="whitespace-normal">Bước</TableHead>
                      <TableHead className="w-28">Trạng thái</TableHead>
                      <TableHead className="w-28">Artifact</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!hasReports ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-sm text-muted-foreground"
                        >
                          Chưa có báo cáo nào.
                        </TableCell>
                      </TableRow>
                    ) : (
                      state.reports.map((report, index) => (
                        <TableRow key={report.id}>
                          <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                            {index + 1}
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2 text-xs leading-tight">
                              <CalendarDaysIcon
                                aria-hidden="true"
                                className="size-4 shrink-0 text-muted-foreground"
                              />
                              {report.createdAt}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-0 truncate text-xs font-medium leading-tight">
                            {report.title}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge status={report.status} />
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex items-center justify-center gap-0.5">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Mở JSON"
                              onClick={() =>
                                openReportArtifact(report.id, "json")
                              }
                            >
                              <FileJsonIcon />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Mở TXT"
                              onClick={() =>
                                openReportArtifact(report.id, "txt")
                              }
                            >
                              <FileTextIcon />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Mở thư mục"
                              onClick={() =>
                                openReportArtifact(report.id, "folder")
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
          {civ7Backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Chưa có backup Civilization VII. Backup Legend nằm ở Báo cáo
              của Legend.
            </p>
          ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {civ7Backups.map((backup) => (
              <Card key={backup.id}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <DatabaseBackupIcon aria-hidden="true" />
                    <CardTitle>{backup.id}</CardTitle>
                  </div>
                  <CardDescription>{backup.createdAt}</CardDescription>
                  <CardAction>
                    <Badge variant={backup.valid ? "secondary" : "destructive"}>
                      {backup.kind === "safety"
                        ? "Safety"
                        : backup.valid
                          ? "Hợp lệ"
                          : "Thiếu file"}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="truncate text-sm text-muted-foreground">
                    {backup.targetPath
                      ? displayWindowsPath(backup.targetPath)
                      : `Tạo bởi bước ${STEP_LABELS[backup.step]} · ${backup.files} file · ${backup.size}`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setBackupDetail(backup)}
                    >
                      <FileTextIcon data-icon="inline-start" />
                      Xem file
                    </Button>
                    <Button
                      size="sm"
                      variant={actionBtn.restore}
                      disabled={!backup.valid || running}
                      onClick={() => setRestoreTarget(backup)}
                    >
                      <ArchiveRestoreIcon data-icon="inline-start" />
                      Khôi phục
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={running}
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
      </div>

      <Dialog
        open={Boolean(backupDetail)}
        onOpenChange={(value) => !value && setBackupDetail(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File trong backup</DialogTitle>
            <DialogDescription>
              {backupDetail?.createdAt} · {backupDetail?.files} file ·{" "}
              {backupDetail?.size}
            </DialogDescription>
          </DialogHeader>
          <InlineLoadingBlock
            loading={backupFilesLoading}
            label="Đang tải danh sách file…"
            className="max-h-72 overflow-auto rounded-lg border"
          >
            {backupFiles.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Không có file trong manifest.
              </div>
            ) : (
              backupFiles.map((file) => (
                <div
                  key={file}
                  className="border-b px-3 py-2 text-xs last:border-0"
                >
                  {file}
                </div>
              ))
            )}
          </InlineLoadingBlock>
          <Button variant="outline" onClick={openBackupFolder}>
            <FolderOpenIcon data-icon="inline-start" />
            Mở thư mục backup
          </Button>
        </DialogContent>
      </Dialog>

      <AlertDialog open={clearHistoryOpen} onOpenChange={setClearHistoryOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa lịch sử báo cáo?</AlertDialogTitle>
            <AlertDialogDescription>
              Danh sách các lần chạy và file JSON/TXT trong thư mục báo cáo sẽ bị
              xóa. Cache dịch và credential không bị ảnh hưởng.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void actions
                  .clearReports()
                  .then(() => {
                    toast.success("Đã xóa lịch sử báo cáo.")
                    setClearHistoryOpen(false)
                  })
                  .catch((error) =>
                    toast.error(formatInvokeError(error)),
                  )
              }}
            >
              <Trash2Icon data-icon="inline-start" />
              Xóa lịch sử
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
              Thư mục backup ({deleteTarget?.files} file · {deleteTarget?.size}) sẽ bị xóa vĩnh
              viễn khỏi ổ đĩa. Thao tác này không thể hoàn tác.
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
                void actions
                  .deleteBackup(backupId)
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

      <AlertDialog
        open={Boolean(restoreTarget)}
        onOpenChange={(value) => !value && setRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Khôi phục backup này?</AlertDialogTitle>
            <AlertDialogDescription>
              Trước khi khôi phục, ứng dụng sẽ tạo safety snapshot. Kết quả bước
              Dịch bị vô hiệu hóa và bạn cần chạy lại Kiểm tra/Đồng bộ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant={actionBtn.restore}
              onClick={() => {
                if (!restoreTarget) return
                const backupId = restoreTarget.id
                setRestoreTarget(null)
                void actions
                  .restoreBackup(backupId)
                  .then(() =>
                    toast.success(
                      "Đã khôi phục backup và tạo safety snapshot.",
                    ),
                  )
                  .catch((error) =>
                    toast.error(formatInvokeError(error)),
                  )
              }}
            >
              <ArchiveRestoreIcon data-icon="inline-start" />
              Khôi phục an toàn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

