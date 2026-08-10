import { useEffect, useState } from "react"
import {
  ArchiveRestoreIcon,
  CalendarDaysIcon,
  DatabaseBackupIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderOpenIcon,
  HardDriveIcon,
  HistoryIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
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
import { cn } from "@/lib/utils"
import { formatInvokeError, ipc } from "@/lib/tauri-ipc"

export function ReportsPage({ controller }: { controller: AppController }) {
  const { state, actions, isDesktop } = controller
  const [backupDetail, setBackupDetail] = useState<Backup | null>(null)
  const [backupFiles, setBackupFiles] = useState<string[]>([])
  const [backupFilesLoading, setBackupFilesLoading] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null)
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false)
  const running = state.activeJob?.status === "running"
  const hasReports = state.reports.length > 0

  const backupDetailId = backupDetail?.id ?? null
  const [loadedBackupId, setLoadedBackupId] = useState<string | null>(null)
  if (backupDetailId !== loadedBackupId) {
    setLoadedBackupId(backupDetailId)
    setBackupFiles([])
    setBackupFilesLoading(Boolean(backupDetailId && isDesktop))
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
        setBackupFilesLoading(false)
        return
      }
      void ipc
        .listBackupFiles(backupDetail.id)
        .then(setBackupFiles)
        .catch((error) => {
          setBackupFiles([])
          toast.error(formatInvokeError(error))
        })
        .finally(() => setBackupFilesLoading(false))
    }, 0)

    return () => window.clearTimeout(timer)
  }, [backupDetail, isDesktop])

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
          <div className="grid gap-4 xl:grid-cols-3">
            {state.backups.map((backup) => (
              <Card key={backup.id}>
                <CardHeader>
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <DatabaseBackupIcon aria-hidden="true" />
                  </div>
                  <CardAction>
                    <Badge
                      variant={backup.valid ? "outline" : "destructive"}
                      className={backup.valid ? "text-success" : undefined}
                    >
                      {backup.valid ? (
                        <ShieldCheckIcon data-icon="inline-start" />
                      ) : (
                        <HardDriveIcon data-icon="inline-start" />
                      )}
                      {backup.valid ? "Hợp lệ" : "Thiếu file"}
                    </Badge>
                  </CardAction>
                  <CardTitle className="text-base">{backup.createdAt}</CardTitle>
                  <CardDescription>
                    Tạo bởi bước {STEP_LABELS[backup.step]}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Số file</dt>
                      <dd className="font-semibold">{backup.files}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Dung lượng</dt>
                      <dd className="font-semibold">{backup.size}</dd>
                    </div>
                  </dl>
                </CardContent>
                <div className="flex gap-2 px-4 pb-4">
                  <Button
                    className="flex-1"
                    size="sm"
                    variant="outline"
                    onClick={() => setBackupDetail(backup)}
                  >
                    <FileTextIcon data-icon="inline-start" />
                    Xem file
                  </Button>
                  <Button
                    className="flex-1"
                    size="sm"
                    disabled={!backup.valid || running}
                    onClick={() => setRestoreTarget(backup)}
                  >
                    <ArchiveRestoreIcon data-icon="inline-start" />
                    Khôi phục
                  </Button>
                  <Button
                    className="flex-1"
                    size="sm"
                    variant="destructive"
                    disabled={running}
                    onClick={() => setDeleteTarget(backup)}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Xóa
                  </Button>
                </div>
              </Card>
            ))}
          </div>
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
          <div className="max-h-72 overflow-auto rounded-lg border">
            {backupFilesLoading ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Đang tải danh sách file…
              </div>
            ) : backupFiles.length === 0 ? (
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
          </div>
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

