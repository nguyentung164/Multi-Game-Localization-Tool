import { DownloadIcon, XIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { AppUpdater } from "@/hooks/use-app-updater";
import {
  formatDownloadProgress,
  formatUpdateDate,
  UPDATE_HANDLE_RESTORING_MESSAGE,
  UPDATE_RESTART_REQUIRED_MESSAGE,
} from "@/lib/app-updater";

export function AppUpdateDialog({
  updater,
  busy,
}: {
  updater: AppUpdater;
  busy: boolean;
}) {
  const downloading = updater.status === "downloading";
  const installing = updater.status === "installing";
  const restartRequired = updater.status === "restartRequired";
  const restoring = updater.restoringHandle;
  const inProgress = downloading || installing;
  const percent = updater.progress.percent;
  const notes = updater.available?.body?.trim();
  const releasedAt = formatUpdateDate(updater.available?.date);

  return (
    <AlertDialog open={updater.dialogOpen} onOpenChange={updater.setDialogOpen}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {restartRequired
              ? "Đã cài bản mới"
              : updater.available
                ? `Có bản ${updater.available.version}`
                : "Cập nhật ứng dụng"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {restartRequired
              ? UPDATE_RESTART_REQUIRED_MESSAGE
              : updater.available
                ? [
                    `Bạn đang dùng ${updater.available.currentVersion}.`,
                    releasedAt ? `Phát hành ${releasedAt}.` : null,
                    "Cài bản mới sẽ khởi động lại app (kèm engine dịch).",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "Không có bản cập nhật."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {notes && !restartRequired ? (
          <div className="max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">
            {notes}
          </div>
        ) : null}
        {inProgress ? (
          <div>
            <div className="flex justify-between gap-3 text-sm">
              <span className="font-medium">
                {installing ? "Đang cài đặt…" : "Đang tải…"}
              </span>
              <span className="shrink-0 tabular-nums">
                {percent !== null
                  ? `${percent}%`
                  : formatDownloadProgress(updater.progress)}
              </span>
            </div>
            {percent !== null ? (
              <>
                <Progress
                  value={percent}
                  aria-label="Tiến độ tải cập nhật"
                  className="mt-2"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDownloadProgress(updater.progress)}
                </p>
              </>
            ) : (
              <div className="loading-progress-track mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <div className="loading-progress-indeterminate h-full w-2/5 rounded-full bg-primary-gradient" />
              </div>
            )}
          </div>
        ) : null}
        {restoring ? (
          <p className="text-sm text-muted-foreground">
            {UPDATE_HANDLE_RESTORING_MESSAGE}
          </p>
        ) : null}
        {busy && !restartRequired ? (
          <p className="text-sm text-warning">
            Đang có tác vụ chạy hoặc tạm dừng. Đợi job xong rồi mới cài.
          </p>
        ) : null}
        {updater.status === "error" && updater.error ? (
          <p className="text-sm text-destructive">{updater.error}</p>
        ) : null}
        <AlertDialogFooter>
          {downloading ? (
            <Button
              type="button"
              variant="outline"
              disabled={restoring}
              onClick={() => void updater.cancelDownload()}
            >
              <XIcon data-icon="inline-start" />
              Hủy tải
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={installing}
              onClick={updater.dismissUpdate}
            >
              {restartRequired ? "Đóng" : "Để sau"}
            </Button>
          )}
          {restartRequired ? null : (
            <Button
              type="button"
              disabled={busy || inProgress || restoring || !updater.available}
              onClick={() => void updater.installUpdate()}
            >
              <DownloadIcon data-icon="inline-start" />
              Cài ngay
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
