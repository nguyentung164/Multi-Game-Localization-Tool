import { useState } from "react"
import {
  FolderOpenIcon,
  KeyRoundIcon,
  Loader2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { APP_NAME } from "@/lib/app-meta"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { AppController } from "@/hooks/use-app-controller"
import type { AppConfig } from "@/lib/app-types"
import { formatInvokeError, ipc } from "@/lib/tauri-ipc"

function normalizePath(path: string) {
  return path
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLocaleLowerCase()
}

export function getPathConflict(config: AppConfig): string | null {
  const entries = [
    ["thư mục game", normalizePath(config.gamePath)],
    ["thư mục export", normalizePath(config.exportPath)],
    ["thư mục mod VN", normalizePath(config.modPath)],
  ] as const
  if (entries.some(([, path]) => !path)) return null
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftLabel, leftPath] = entries[left]
      const [rightLabel, rightPath] = entries[right]
      if (
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}\\`) ||
        rightPath.startsWith(`${leftPath}\\`)
      ) {
        return `${leftLabel} và ${rightLabel} không được trùng hoặc lồng nhau.`
      }
    }
  }
  return null
}

export function SetupDialog({
  open,
  onOpenChange,
  controller,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  controller: AppController
}) {
  const { state, actions, isDesktop } = controller
  const [config, setConfig] = useState(state.config)
  const [keyLabel, setKeyLabel] = useState("API Chính")
  const [keySecret, setKeySecret] = useState("")
  const [saving, setSaving] = useState(false)
  const [pathErrors, setPathErrors] = useState<Record<string, string>>({})
  const conflict = getPathConflict(config)
  const requiredMissing =
    !config.gamePath.trim() ||
    !config.exportPath.trim() ||
    !config.modPath.trim()
  const needsKey = state.apiKeys.length === 0

  async function choosePath(
    key: "gamePath" | "exportPath" | "modPath",
    current: string,
  ) {
    const selected = await ipc.pickDirectory(current)
    if (selected) setConfig((value) => ({ ...value, [key]: selected }))
  }

  async function submit() {
    if (requiredMissing || conflict || (needsKey && keySecret.length < 8)) {
      toast.error("Hãy hoàn tất các trường bắt buộc.")
      return
    }
    setSaving(true)
    setPathErrors({})
    try {
      if (isDesktop) {
        const validation = await ipc.validatePaths({
          gamePath: config.gamePath,
          exportPath: config.exportPath,
          modPath: config.modPath,
        })
        if (!validation.valid) {
          setPathErrors(validation.errors)
          toast.error("Một hoặc nhiều đường dẫn không hợp lệ.")
          return
        }
      }
      if (needsKey) await actions.addKey(keyLabel.trim(), keySecret.trim())
      await actions.saveConfig(config)
      onOpenChange(false)
      toast.success("Thiết lập hoàn tất. Pipeline đã sẵn sàng.")
    } catch (error) {
      toast.error(formatInvokeError(error))
    } finally {
      setSaving(false)
    }
  }

  const pathFields = [
    {
      key: "gamePath" as const,
      label: "Thư mục Civilization VII",
      description: "Thư mục cài đặt chứa Base, DLC và executable của game.",
    },
    {
      key: "exportPath" as const,
      label: "Thư mục export tiếng Anh",
      description: "Nơi lưu bản dữ liệu nguồn do bước Export tạo ra.",
    },
    {
      key: "modPath" as const,
      label: "Thư mục mod tiếng Việt",
      description: "Đích được backup và cập nhật ở bước Đồng bộ/Dịch.",
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <SparklesIcon aria-hidden="true" />
          </div>
          <DialogTitle>Thiết lập {APP_NAME}</DialogTitle>
          <DialogDescription>
            Kết nối ba thư mục làm việc và một Gemini API key. Mọi đường dẫn sẽ
            được kiểm tra trước khi pipeline được mở khóa.
          </DialogDescription>
        </DialogHeader>

        {!isDesktop && (
          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>Chế độ xem trước trên web</AlertTitle>
            <AlertDescription>
              Nút chọn thư mục và kho credential chỉ hoạt động trong Tauri. Dữ
              liệu demo vẫn cho phép kiểm tra toàn bộ giao diện.
            </AlertDescription>
          </Alert>
        )}

        <FieldGroup>
          {pathFields.map((field) => (
            <Field
              key={field.key}
              data-invalid={Boolean(
                conflict || pathErrors[field.key] || pathErrors.paths,
              )}
            >
              <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={field.key}
                  value={config[field.key]}
                  aria-invalid={Boolean(conflict || pathErrors[field.key])}
                  onChange={(event) => {
                    setPathErrors((current) => {
                      if (!current[field.key] && !current.paths) return current
                      const next = { ...current }
                      delete next[field.key]
                      delete next.paths
                      return next
                    })
                    setConfig((value) => ({
                      ...value,
                      [field.key]: event.target.value,
                    }))
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void choosePath(field.key, config[field.key])}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  Chọn
                </Button>
              </div>
              <FieldDescription>{field.description}</FieldDescription>
              {pathErrors[field.key] && (
                <FieldError>{pathErrors[field.key]}</FieldError>
              )}
            </Field>
          ))}
          {conflict && <FieldError>{conflict}</FieldError>}
          {pathErrors.paths && <FieldError>{pathErrors.paths}</FieldError>}

          {needsKey && (
            <>
              <FieldSeparator>Gemini API</FieldSeparator>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="setup-key-label">Nhãn key</FieldLabel>
                  <Input
                    id="setup-key-label"
                    value={keyLabel}
                    onChange={(event) => setKeyLabel(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-key-secret">API key</FieldLabel>
                  <Input
                    id="setup-key-secret"
                    type="password"
                    autoComplete="off"
                    value={keySecret}
                    onChange={(event) => setKeySecret(event.target.value)}
                    placeholder="Không được lưu trong frontend"
                  />
                  <FieldDescription>
                    Chỉ gửi qua IPC để lưu trong Windows Credential Manager.
                  </FieldDescription>
                </Field>
              </div>
            </>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {state.setupComplete ? "Hủy" : "Để sau"}
          </Button>
          <Button
            variant={actionBtn.verify}
            disabled={
              requiredMissing ||
              Boolean(conflict) ||
              saving ||
              (needsKey && keySecret.length < 8)
            }
            onClick={() => void submit()}
          >
            {saving ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <KeyRoundIcon data-icon="inline-start" />
            )}
            Kiểm tra và tiếp tục
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
