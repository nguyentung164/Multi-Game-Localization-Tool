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
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { ApiKeyMeta } from "@/lib/app-types"
import type { AppController } from "@/hooks/use-app-controller"
import { cn } from "@/lib/utils"
import { formatInvokeError } from "@/lib/tauri-ipc"

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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  controller: AppController
}) {
  const { state, actions } = controller
  const [label, setLabel] = useState("")
  const [secret, setSecret] = useState("")
  const [adding, setAdding] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyMeta | null>(null)
  const [renameTarget, setRenameTarget] = useState<ApiKeyMeta | null>(null)
  const [renameLabel, setRenameLabel] = useState("")
  const isLocked = state.activeJob?.status === "running"

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
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRoundIcon aria-hidden="true" />
              Quản lý Gemini API
            </DialogTitle>
            <DialogDescription>
              Key được lưu trong Windows Credential Manager. Frontend chỉ nhận
              metadata đã che, không thể đọc lại giá trị đầy đủ.
            </DialogDescription>
          </DialogHeader>

          {isLocked && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
              Tác vụ dịch đang chạy. Danh sách ở chế độ chỉ đọc để bảo vệ phiên
              đang hoạt động.
            </div>
          )}

          <div className="flex flex-col gap-2">
            {state.apiKeys.map((key, index) => (
              <div
                key={key.id}
                className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
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
                        key.status === "valid" &&
                          "border-success/20 bg-success/10 text-success",
                        key.status === "active" &&
                          "border-info/20 bg-info/10 text-info",
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
                    variant="outline"
                    disabled={testingId === key.id}
                    onClick={() => void handleTest(key)}
                  >
                    {testingId === key.id ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
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
            ))}
          </div>

          <Separator />

          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
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

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Đóng
            </Button>
            <Button
              disabled={isLocked || adding}
              onClick={() => void handleAdd()}
            >
              {adding ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Đổi nhãn API key</DialogTitle>
            <DialogDescription>
              Chỉ đổi tên hiển thị; credential và thứ tự ưu tiên được giữ nguyên.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rename-key">Nhãn mới</FieldLabel>
            <Input
              id="rename-key"
              value={renameLabel}
              onChange={(event) => setRenameLabel(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Hủy
            </Button>
            <Button
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa {deleteTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Credential sẽ bị xóa khỏi Windows và không thể khôi phục. Tác vụ
              hiện tại không bị ảnh hưởng.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
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

