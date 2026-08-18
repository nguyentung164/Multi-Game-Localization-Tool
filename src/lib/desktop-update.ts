import { Update } from "@tauri-apps/plugin-updater";
import { ipc } from "@/lib/tauri-ipc";

export async function checkDesktopUpdate(options?: {
  timeout?: number;
}): Promise<Update | null> {
  const metadata = await ipc.checkAppUpdate(options?.timeout);
  if (!metadata) return null;
  return new Update(metadata);
}
