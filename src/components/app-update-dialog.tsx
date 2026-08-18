import { DownloadIcon } from "lucide-react";
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
import { formatDownloadProgress } from "@/lib/app-updater";

export function AppUpdateDialog({
  updater,
  busy,
}: {
  updater: AppUpdater;
  busy: boolean;
}) {
  const installing =
    updater.status === "downloading" || updater.status === "installing";
  const percent = updater.progress.percent;
  const notes = updater.available?.body?.trim();

  return (
    <AlertDialog open={updater.dialogOpen} onOpenChange={updater.setDialogOpen}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {updater.available
              ? `Có bản ${updater.available.version}`
              : "Cập nhật ứng dụng"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {updater.available
              ? `Bạn đang dùng ${updater.available.currentVersion}. Cài bản mới sẽ khởi động lại app (kèm engine dịch).`
              : "Không có bản cập nhật."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {notes ? (
          <div className="max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">
            {notes}
          </div>
        ) : null}
        {installing ? (
          <div>
            <div className="flex justify-between gap-3 text-sm">
              <span className="font-medium">
                {updater.status === "installing"
                  ? "Đang cài đặt…"
                  : "Đang tải…"}
              </span>
              <span className="shrink-0 tabular-nums">
                {percent !== null
                  ? `${percent}%`
                  : formatDownloadProgress(updater.progress)}
              </span>
            </div>
            <Progress
              value={percent ?? 0}
              aria-label="Tiến độ tải cập nhật"
              className="mt-2"
            />
            {percent !== null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDownloadProgress(updater.progress)}
              </p>
            ) : null}
          </div>
        ) : null}
        {busy ? (
          <p className="text-sm text-warning">
            Đang có tác vụ chạy. Dừng hoặc đợi job xong rồi mới cài.
          </p>
        ) : null}
        {updater.status === "error" && updater.error ? (
          <p className="text-sm text-destructive">{updater.error}</p>
        ) : null}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={installing}
            onClick={updater.dismissUpdate}
          >
            Để sau
          </Button>
          <Button
            type="button"
            disabled={busy || installing || !updater.available}
            onClick={() => void updater.installUpdate()}
          >
            <DownloadIcon data-icon="inline-start" />
            Cài ngay
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
