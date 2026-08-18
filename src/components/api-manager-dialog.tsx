import { useState } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { ApiKeyMeta } from "@/lib/app-types"
import type { AppController } from "@/hooks/use-app-controller"
import { cn } from "@/lib/utils"
import { formatInvokeError } from "@/lib/tauri-ipc"

const surfaceTileClass =
  "rounded-lg bg-surface-gradient shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"

const dialogSurfaceClass =
  "flex flex-col gap-0 overflow-hidden bg-card-surface p-0 ring-0 shadow-xl"

const dialogFooterClass =
  "mx-0 mb-0 shrink-0 border-t-0 bg-transparent p-4 pt-3 shadow-none"

const dialogBodyClass = "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"

const keyStatus: Record<ApiKeyMeta["status"], string> = {
  unknown: "Chưa kiểm tra",
  valid: "Sẵn sàng",
  active: "Đang dùng",
  "rate-limited": "Giới hạn tốc độ",
  "quota-exhausted": "Hết quota",
  invalid: "Không hợp lệ",
}

export function ApiManagerDialog({
  open,
  onOpenChange,
  controller,
  locked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  controller: AppController
  locked?: boolean
}) {
  const { state, actions } = controller
  const [label, setLabel] = useState("")
  const [secret, setSecret] = useState("")
  const [adding, setAdding] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyMeta | null>(null)
  const [renameTarget, setRenameTarget] = useState<ApiKeyMeta | null>(null)
  const [renameLabel, setRenameLabel] = useState("")
  const isLocked = Boolean(locked || state.activeJob?.status === "running")

  async function handleAdd() {
    if (!label.trim() || secret.trim().length < 8) {
      toast.error("Hãy nhập nhãn và API key hợp lệ.")
      return
    }
    setAdding(true)
    try {
      await actions.addKey(label.trim(), secret.trim())
      setLabel("")
      setSecret("")
      toast.success("Đã lưu API key vào kho bảo mật.")
    } catch (error) {
      toast.error(formatInvokeError(error))
    } finally {
      setAdding(false)
    }
  }

  async function handleTest(key: ApiKeyMeta) {
    setTestingId(key.id)
    try {
      await actions.testKey(key)
      toast.success(`${key.label} kết nối thành công.`)
    } catch (error) {
      toast.error(formatInvokeError(error))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn("max-h-[88vh] sm:max-w-3xl", dialogSurfaceClass)}
        >
          <div className={dialogBodyClass}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft-gradient text-primary">
                  <KeyRoundIcon aria-hidden="true" className="size-4" />
                </span>
                Quản lý Gemini API
              </DialogTitle>
              <DialogDescription>
                Key được lưu trong Windows Credential Manager. Frontend chỉ nhận
                metadata đã che, không thể đọc lại giá trị đầy đủ.
              </DialogDescription>
            </DialogHeader>

            {isLocked && (
              <div
                className={cn(
                  surfaceTileClass,
                  "bg-warning-soft-gradient p-3 text-sm text-warning dark:text-warning",
                )}
              >
                Tác vụ dịch đang chạy. Danh sách ở chế độ chỉ đọc để bảo vệ phiên
                đang hoạt động.
              </div>
            )}

            <div className="flex flex-col gap-2">
            {state.apiKeys.length === 0 ? (
              <p
                className={cn(
                  surfaceTileClass,
                  "border border-dashed border-muted-foreground/25 px-3 py-4 text-center text-sm text-muted-foreground",
                )}
              >
                Chưa có API key. Thêm key mới ở form bên dưới.
              </p>
            ) : (
              state.apiKeys.map((key, index) => (
                <div
                  key={key.id}
                  className={cn(
                    surfaceTileClass,
                    "flex flex-col gap-3 p-4 sm:flex-row sm:items-center",
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft-gradient text-sm font-semibold text-primary">
                    {key.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{key.label}</p>
                      <Badge
                        variant={
                          key.status === "invalid" ? "destructive" : "outline"
                        }
                        className={cn(
                          key.status === "valid" && "text-success",
                          key.status === "active" && "text-info",
                        )}
                      >
                        {keyStatus[key.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {key.maskedSuffix} · {key.localRequests} request hôm nay ·{" "}
                      {key.lastUsed ?? "Chưa sử dụng"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={isLocked || index === 0}
                      onClick={() => void actions.moveKey(key.id, -1)}
                      aria-label={`Tăng ưu tiên ${key.label}`}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={isLocked || index === state.apiKeys.length - 1}
                      onClick={() => void actions.moveKey(key.id, 1)}
                      aria-label={`Giảm ưu tiên ${key.label}`}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      size="sm"
                      variant={actionBtn.verify}
                      disabled={testingId === key.id}
                      onClick={() => void handleTest(key)}
                    >
                      {testingId === key.id ? (
                        <Loader2Icon
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : (
                        <ShieldCheckIcon data-icon="inline-start" />
                      )}
                      Kiểm tra
                    </Button>
                    <Switch
                      checked={key.enabled}
                      disabled={isLocked}
                      aria-label={`Bật ${key.label}`}
                      onCheckedChange={(enabled) =>
                        void actions.toggleKey(key, enabled)
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={isLocked || key.status === "active"}
                      onClick={() => {
                        setRenameTarget(key)
                        setRenameLabel(key.label)
                      }}
                      aria-label={`Đổi nhãn ${key.label}`}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="destructive"
                      disabled={isLocked || key.status === "active"}
                      onClick={() => setDeleteTarget(key)}
                      aria-label={`Xóa ${key.label}`}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
              ))
            )}
            </div>

            <FieldGroup>
              <div
                className={cn(
                  surfaceTileClass,
                  "grid gap-4 p-4 sm:grid-cols-2",
                )}
              >
                <Field data-disabled={isLocked}>
                  <FieldLabel htmlFor="api-label">Nhãn dễ nhớ</FieldLabel>
                  <Input
                    id="api-label"
                    disabled={isLocked}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Ví dụ: API dự phòng 2"
                  />
                </Field>
                <Field data-disabled={isLocked}>
                  <FieldLabel htmlFor="api-secret">API key mới</FieldLabel>
                  <Input
                    id="api-secret"
                    type="password"
                    disabled={isLocked}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="Dán key tại đây"
                    autoComplete="off"
                  />
                  <FieldDescription>
                    Key không xuất hiện trong log, report hoặc state frontend.
                  </FieldDescription>
                </Field>
              </div>
            </FieldGroup>
          </div>

          <DialogFooter className={dialogFooterClass}>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Đóng
            </Button>
            <Button
              variant={actionBtn.save}
              disabled={isLocked || adding}
              onClick={() => void handleAdd()}
            >
              {adding ? (
                <Loader2Icon
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              Thêm API key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(value) => !value && setRenameTarget(null)}
      >
        <DialogContent className={cn("sm:max-w-md", dialogSurfaceClass)}>
          <div className={dialogBodyClass}>
            <DialogHeader>
              <DialogTitle>Đổi nhãn API key</DialogTitle>
              <DialogDescription>
                Chỉ đổi tên hiển thị; credential và thứ tự ưu tiên được giữ
                nguyên.
              </DialogDescription>
            </DialogHeader>
            <Field className={cn(surfaceTileClass, "p-4")}>
              <FieldLabel htmlFor="rename-key">Nhãn mới</FieldLabel>
              <Input
                id="rename-key"
                value={renameLabel}
                onChange={(event) => setRenameLabel(event.target.value)}
              />
            </Field>
          </div>
          <DialogFooter className={dialogFooterClass}>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Hủy
            </Button>
            <Button
              variant={actionBtn.save}
              disabled={!renameLabel.trim()}
              onClick={() => {
                if (!renameTarget) return
                void actions.renameKey(renameTarget, renameLabel.trim())
                setRenameTarget(null)
                toast.success("Đã đổi nhãn API key.")
              }}
            >
              Lưu nhãn
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(value) => !value && setDeleteTarget(null)}
      >
        <AlertDialogContent className={dialogSurfaceClass}>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa {deleteTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Credential sẽ bị xóa khỏi Windows và không thể khôi phục. Tác vụ
              hiện tại không bị ảnh hưởng.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={dialogFooterClass}>
            <AlertDialogCancel>Giữ lại</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return
                void actions.deleteKey(deleteTarget.id)
                setDeleteTarget(null)
                toast.success("Đã xóa API key.")
              }}
            >
              <Trash2Icon data-icon="inline-start" />
              Xóa vĩnh viễn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
