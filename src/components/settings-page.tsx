import { useEffect, useState } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  BookAIcon,
  DatabaseIcon,
  FileJsonIcon,
  FolderCogIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MonitorCogIcon,
  PlusIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { ApiManagerDialog } from "@/components/api-manager-dialog"
import { PageHeader, pageContainerClass, pageShellClass } from "@/components/product-ui"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { AppController } from "@/hooks/use-app-controller"
import type { ApiKeyMeta, TranslationCacheInfo } from "@/lib/app-types"
import { CACHE_FILENAME, resolveCachePath } from "@/lib/cache-path"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"
import { cn } from "@/lib/utils"

const MODEL_OPTIONS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
] as const

const keyStatus: Record<ApiKeyMeta["status"], string> = {
  unknown: "Chưa kiểm tra",
  valid: "Sẵn sàng",
  active: "Đang dùng",
  "rate-limited": "Giới hạn tốc độ",
  "quota-exhausted": "Hết quota",
  invalid: "Không hợp lệ",
}

function formatBytes(size: number): string {
  if (size <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

function FallbackModelsField({
  primaryModel,
  models,
  onChange,
}: {
  primaryModel: string
  models: string[]
  onChange: (models: string[]) => void
}) {
  const [addKey, setAddKey] = useState(0)
  const available = MODEL_OPTIONS.filter(
    (model) => model !== primaryModel && !models.includes(model),
  )

  function move(index: number, delta: number) {
    const next = index + delta
    if (next < 0 || next >= models.length) return
    const updated = [...models]
      ;[updated[index], updated[next]] = [updated[next], updated[index]]
    onChange(updated)
  }

  return (
    <Field>
      <FieldLabel>Chuỗi fallback</FieldLabel>
      <div className="flex flex-col gap-2">
        {models.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            Chưa có model dự phòng. Thêm model bên dưới.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {models.map((model, index) => (
              <li
                key={model}
                className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1.5"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-xs font-medium text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {model}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={`Đưa ${model} lên`}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === models.length - 1}
                    aria-label={`Đưa ${model} xuống`}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="destructive"
                    aria-label={`Xóa ${model}`}
                    onClick={() =>
                      onChange(
                        models.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <XIcon />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
        {available.length > 0 ? (
          <Select
            key={addKey}
            onValueChange={(model) => {
              onChange([...models, model])
              setAddKey((current) => current + 1)
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Thêm model dự phòng">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <PlusIcon className="size-3.5" />
                  Thêm model dự phòng
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {available.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">
            Đã dùng hết model trong danh sách.
          </p>
        )}
      </div>
      <FieldDescription>
        Theo thứ tự ưu tiên từ trên xuống khi model chính lỗi hoặc hết quota.
      </FieldDescription>
    </Field>
  )
}

function SettingsCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof FolderCogIcon
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function SettingsPage({
  controller,
  onOpenSetup,
  onNavigate,
}: {
  controller: AppController
  onOpenSetup: () => void
  onNavigate?: (view: import("@/lib/app-types").AppView) => void
}) {
  const { state, actions } = controller
  const [config, setConfig] = useState(state.config)
  const [apiOpen, setApiOpen] = useState(false)
  const [clearCacheOpen, setClearCacheOpen] = useState(false)
  const [cacheInfo, setCacheInfo] = useState<TranslationCacheInfo | null>(null)
  const changed = JSON.stringify(config) !== JSON.stringify(state.config)

  const effectiveCachePath = resolveCachePath(config)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void ipc
      .getTranslationCacheInfo({
        cachePath: config.cachePath,
        reportPath: config.reportPath,
      })
      .then((info) => {
        if (!cancelled) setCacheInfo(info)
      })
      .catch(() => {
        if (!cancelled) setCacheInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [config.cachePath, config.reportPath])

  async function refreshCacheInfo() {
    if (!isTauriRuntime()) return
    try {
      const info = await ipc.getTranslationCacheInfo({
        cachePath: config.cachePath,
        reportPath: config.reportPath,
      })
      setCacheInfo(info)
    } catch {
      setCacheInfo(null)
    }
  }

  async function openTranslationCache() {
    try {
      await ipc.openTranslationCache({
        cachePath: config.cachePath,
        reportPath: config.reportPath,
      })
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  async function clearTranslationCache() {
    try {
      const result = await ipc.clearTranslationCache({
        cachePath: config.cachePath,
        reportPath: config.reportPath,
      })
      await refreshCacheInfo()
      toast.success(
        result.clearedEntries > 0
          ? `Đã xóa ${result.clearedEntries.toLocaleString("vi-VN")} mục cache.`
          : "Cache đã trống.",
      )
      setClearCacheOpen(false)
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  async function chooseDirectory(
    key: "gamePath" | "exportPath" | "modPath" | "reportPath",
  ) {
    const selected = await ipc.pickDirectory(config[key])
    if (selected) setConfig((current) => ({ ...current, [key]: selected }))
  }

  async function chooseGlossaryFile() {
    const selected = await ipc.pickFile(config.glossaryPath, [
      { name: "JSON", extensions: ["json"] },
    ])
    if (selected) {
      setConfig((current) => ({ ...current, glossaryPath: selected }))
    }
  }

  async function chooseCacheFile() {
    const selected = await ipc.pickFile(
      config.cachePath || resolveCachePath(config),
      [{ name: "JSON", extensions: ["json"] }],
    )
    if (selected) {
      setConfig((current) => ({ ...current, cachePath: selected }))
    }
  }

  async function save() {
    try {
      await actions.saveConfig(config)
      toast.success("Đã lưu cài đặt.")
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col">
      <div className={cn(pageContainerClass, "flex-1 pb-6")}>
      <PageHeader
        eyebrow="Cấu hình ứng dụng"
        title="Cài đặt"
        description="Quản lý đường dẫn, API, model, dữ liệu và thông báo. Thay đổi ảnh hưởng pipeline cần được xác nhận khi lưu."
        action={
          <Button variant="outline" onClick={onOpenSetup}>
            <SparklesIcon data-icon="inline-start" />
            Chạy lại thiết lập
          </Button>
        }
      />

      {changed && (
        <Alert className="border-warning/30 bg-warning/10">
          <SlidersHorizontalIcon />
          <AlertTitle>Có thay đổi chưa lưu</AlertTitle>
          <AlertDescription>
            Thay đổi đường dẫn hoặc model có thể vô hiệu hóa kết quả các bước
            downstream sau khi xác nhận.
          </AlertDescription>
        </Alert>
      )}

      <SettingsCard
        icon={FolderCogIcon}
        title="Đường dẫn"
        description="Nguồn game, bản export và thư mục mod tiếng Việt"
      >
        <FieldGroup>
          {[
            ["gamePath", "Civilization VII"],
            ["exportPath", "Export tiếng Anh"],
            ["modPath", "Mod tiếng Việt"],
          ].map(([key, label]) => (
            <Field key={key}>
              <FieldLabel htmlFor={`settings-${key}`}>{label}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={`settings-${key}`}
                  value={config[key as "gamePath"]}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    void chooseDirectory(
                      key as "gamePath" | "exportPath" | "modPath",
                    )
                  }
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  Chọn
                </Button>
              </div>
            </Field>
          ))}
        </FieldGroup>
      </SettingsCard>

      <SettingsCard
        icon={KeyRoundIcon}
        title="Gemini API keys"
        description="Credential bảo mật, ưu tiên và trạng thái kết nối"
      >
        <div className="flex flex-col gap-4">
          {state.apiKeys.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Chưa có API key. Mở trình quản lý để thêm.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {state.apiKeys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-start gap-3 rounded-lg border bg-muted/30 px-3 py-2.5"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-xs font-semibold text-muted-foreground">
                    {key.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{key.label}</p>
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
                      {!key.enabled && (
                        <Badge variant="secondary">Đã tắt</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <code>{key.maskedSuffix}</code>
                      {" · "}
                      {key.localRequests.toLocaleString("vi-VN")} request hôm nay
                      {" · "}
                      {key.lastUsed ?? "Chưa sử dụng"}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <Button className="self-start" onClick={() => setApiOpen(true)}>
            <KeyRoundIcon data-icon="inline-start" />
            Mở trình quản lý API
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={LanguagesIcon}
        title="Model & fallback"
        description="Model ưu tiên và chuỗi dự phòng khi lỗi hoặc hết quota"
      >
        <FieldGroup>
          <Field>
            <FieldLabel>Model chính</FieldLabel>
            <Select
              value={config.model}
              onValueChange={(model) =>
                setConfig((current) => ({
                  ...current,
                  model,
                  fallbackModels: current.fallbackModels.filter(
                    (item) => item !== model,
                  ),
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {MODEL_OPTIONS.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <FallbackModelsField
            primaryModel={config.model}
            models={config.fallbackModels}
            onChange={(fallbackModels) =>
              setConfig((current) => ({ ...current, fallbackModels }))
            }
          />
        </FieldGroup>
      </SettingsCard>

      <SettingsCard
        icon={SlidersHorizontalIcon}
        title="Dịch"
        description="Nhịp request, timeout và kích thước batch"
      >
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="delay">Delay (ms)</FieldLabel>
              <Input
                id="delay"
                type="number"
                min={0}
                value={config.delayMs}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    delayMs: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="timeout">Timeout (giây)</FieldLabel>
              <Input
                id="timeout"
                type="number"
                min={10}
                value={config.timeoutSeconds}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    timeoutSeconds: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="batch-size">Mục mỗi batch</FieldLabel>
              <Input
                id="batch-size"
                type="number"
                min={1}
                value={config.batchSize}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    batchSize: Number(event.target.value),
                  }))
                }
              />
            </Field>
          </div>
        </FieldGroup>
      </SettingsCard>

      <SettingsCard
        icon={DatabaseIcon}
        title="Dữ liệu"
        description="Report, cache và glossary"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="data-reportPath">Thư mục report</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="data-reportPath"
                value={config.reportPath}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    reportPath: event.target.value,
                  }))
                }
              />
              <Button
                variant="outline"
                onClick={() => void chooseDirectory("reportPath")}
              >
                <FolderOpenIcon data-icon="inline-start" />
                Chọn
              </Button>
            </div>
          </Field>
          <Field>
            <div className="flex flex-wrap items-center gap-2">
              <FieldLabel htmlFor="data-cachePath">Cache dịch (Gemini)</FieldLabel>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openTranslationCache()}
              >
                <FolderOpenIcon data-icon="inline-start" />
                Mở file cache
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!cacheInfo?.exists || cacheInfo.entries === 0}
                onClick={() => setClearCacheOpen(true)}
              >
                <Trash2Icon data-icon="inline-start" />
                Xóa cache bản dịch
              </Button>
            </div>
            <FieldDescription>
              {cacheInfo?.exists
                ? `${cacheInfo.entries.toLocaleString("vi-VN")} mục · ${formatBytes(cacheInfo.sizeBytes)}`
                : "Chưa có file cache"}
              {effectiveCachePath ? (
                <>
                  {" "}
                  · Đường dẫn thực tế:{" "}
                  <span className="text-xs leading-tight">{effectiveCachePath}</span>
                </>
              ) : null}
            </FieldDescription>
            <div className="flex gap-2">
              <Input
                id="data-cachePath"
                value={config.cachePath}
                placeholder={effectiveCachePath || CACHE_FILENAME}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    cachePath: event.target.value,
                  }))
                }
              />
              <Button variant="outline" onClick={() => void chooseCacheFile()}>
                <FileJsonIcon data-icon="inline-start" />
                Chọn
              </Button>
            </div>
          </Field>
          <Field>
            <div className="flex flex-wrap items-center gap-2">
              <FieldLabel htmlFor="data-glossaryPath">File glossary</FieldLabel>
              {onNavigate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate("glossary")}
                >
                  <BookAIcon data-icon="inline-start" />
                  Mở Glossary Editor
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                id="data-glossaryPath"
                value={config.glossaryPath}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    glossaryPath: event.target.value,
                  }))
                }
              />
              <Button variant="outline" onClick={() => void chooseGlossaryFile()}>
                <FileJsonIcon data-icon="inline-start" />
                Chọn
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </SettingsCard>

      <AlertDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa cache bản dịch?</AlertDialogTitle>
            <AlertDialogDescription>
              {cacheInfo?.exists && cacheInfo.entries > 0
                ? `Sẽ xóa ${cacheInfo.entries.toLocaleString("vi-VN")} mục trong file cache. Lần dịch sau sẽ gọi API lại cho các câu đã cache.`
                : "File cache sẽ được reset về trống."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void clearTranslationCache()}>
              Xóa cache
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsCard
        icon={BellIcon}
        title="Thông báo Windows"
        description="Chỉ thông báo sự kiện quan trọng, không chứa secret"
      >
        <FieldSet>
          <FieldLegend variant="label">Loại thông báo</FieldLegend>
          <FieldGroup>
            {[
              ["enabled", "Bật thông báo", "Cho phép ứng dụng gửi thông báo native."],
              ["completed", "Hoàn thành", "Tác vụ hoàn tất thành công."],
              ["paused", "Cần tiếp tục", "Tạm dừng do quota hoặc yêu cầu người dùng."],
              ["failed", "Thất bại", "Tác vụ dừng vì lỗi cần xử lý."],
            ].map(([key, label, description]) => (
              <Field key={key} orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`notify-${key}`}>{label}</FieldLabel>
                  <FieldDescription>{description}</FieldDescription>
                </FieldContent>
                <Switch
                  id={`notify-${key}`}
                  checked={
                    config.notifications[
                    key as keyof typeof config.notifications
                    ]
                  }
                  disabled={key !== "enabled" && !config.notifications.enabled}
                  onCheckedChange={(checked) =>
                    setConfig((current) => ({
                      ...current,
                      notifications: {
                        ...current.notifications,
                        [key]: checked,
                      },
                    }))
                  }
                />
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
      </SettingsCard>

      <SettingsCard
        icon={FolderCogIcon}
        title="Nâng cao"
        description="Giới hạn engine và tùy chọn triển khai"
      >
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="max-files">Giới hạn file dịch</FieldLabel>
              <Input
                id="max-files"
                type="number"
                min={0}
                value={config.maxFiles}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    maxFiles: Number(event.target.value),
                  }))
                }
              />
              <FieldDescription>0 = không giới hạn.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="max-api-calls">Giới hạn API calls</FieldLabel>
              <Input
                id="max-api-calls"
                type="number"
                min={0}
                value={config.maxApiCalls}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    maxApiCalls: Number(event.target.value),
                  }))
                }
              />
              <FieldDescription>0 = không giới hạn.</FieldDescription>
            </Field>
          </div>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="deploy-backup">Backup khi deploy</FieldLabel>
              <FieldDescription>
                Sao lưu file game trước khi ghi từ mod VN.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="deploy-backup"
              checked={config.deployBackup}
              onCheckedChange={(checked) =>
                setConfig((current) => ({ ...current, deployBackup: checked }))
              }
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="deploy-only-existing">
                Chỉ ghi file đã có trong game
              </FieldLabel>
              <FieldDescription>
                Không tạo file mới trong thư mục Steam.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="deploy-only-existing"
              checked={config.deployOnlyExisting}
              onCheckedChange={(checked) =>
                setConfig((current) => ({
                  ...current,
                  deployOnlyExisting: checked,
                }))
              }
            />
          </Field>
        </FieldGroup>
      </SettingsCard>

      <SettingsCard
        icon={MonitorCogIcon}
        title="Giao diện"
        description="Chủ đề hiển thị của ứng dụng"
      >
        <Field>
          <FieldLabel>Chủ đề</FieldLabel>
          <Tabs
            value={config.theme}
            onValueChange={(theme) =>
              setConfig((current) => ({
                ...current,
                theme: theme as typeof config.theme,
              }))
            }
          >
            <TabsList>
              <TabsTrigger value="light">Sáng</TabsTrigger>
              <TabsTrigger value="dark">Tối</TabsTrigger>
              <TabsTrigger value="system">Theo Windows</TabsTrigger>
            </TabsList>
          </Tabs>
        </Field>
      </SettingsCard>
      </div>

      <div className="sticky bottom-0 z-20 border-t bg-background/95 backdrop-blur">
        <div className={cn(pageShellClass, "flex items-center justify-end gap-2 py-3")}>
          <Button
            variant="outline"
            disabled={!changed}
            onClick={() => setConfig(state.config)}
          >
            Hoàn tác
          </Button>
          <Button disabled={!changed} onClick={() => void save()}>
            <SaveIcon data-icon="inline-start" />
            Lưu thay đổi
          </Button>
        </div>
      </div>

      <ApiManagerDialog
        open={apiOpen}
        onOpenChange={setApiOpen}
        controller={controller}
      />
    </div>
  )
}

