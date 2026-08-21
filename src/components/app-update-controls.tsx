import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppUpdater } from "@/hooks/use-app-updater";
import { updaterStatusLabel } from "@/lib/app-updater";

export function AppUpdateControls({ updater }: { updater: AppUpdater }) {
  const checking = updater.status === "checking";
  const installing =
    updater.status === "downloading" || updater.status === "installing";
  const restoring = updater.restoringHandle;
  const blocked = checking || installing || restoring;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium">
          Phiên bản {updater.currentVersion}
        </p>
        <p className="text-sm text-muted-foreground">
          {updaterStatusLabel({
            status: updater.status,
            availableVersion: updater.available?.version,
            error: updater.error,
            restoringHandle: restoring,
          })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked}
          onClick={() => void updater.checkForUpdate()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Kiểm tra cập nhật
        </Button>
        {updater.available ? (
          <Button
            type="button"
            size="sm"
            disabled={blocked}
            onClick={() => updater.setDialogOpen(true)}
          >
            <DownloadIcon data-icon="inline-start" />
            Cài ngay
          </Button>
        ) : null}
      </div>
    </div>
  );
}
