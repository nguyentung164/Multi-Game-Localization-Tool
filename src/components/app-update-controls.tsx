import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppUpdater } from "@/hooks/use-app-updater";
import { updaterStatusLabel } from "@/lib/app-updater";

export function AppUpdateControls({ updater }: { updater: AppUpdater }) {
  const checking = updater.status === "checking";
  const installing =
    updater.status === "downloading" || updater.status === "installing";

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        {updaterStatusLabel({
          status: updater.status,
          availableVersion: updater.available?.version,
          error: updater.error,
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={checking || installing}
        onClick={() => void updater.checkForUpdate()}
      >
        <RefreshCwIcon data-icon="inline-start" />
        Kiểm tra cập nhật
      </Button>
    </div>
  );
}
