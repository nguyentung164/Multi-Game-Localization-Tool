import { useEffect, useState } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  BookAIcon,
  DatabaseIcon,
  DownloadIcon,
  FileJsonIcon,
  FolderCogIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MonitorCogIcon,
  PlusIcon,
  PowerIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { ApiManagerDialog } from "@/components/api-manager-dialog"
import { AsyncLoadingOverlay } from "@/components/async-loading-overlay"
import { PageHeader, pageContainerClass, pageShellClass } from "@/components/product-ui"
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
import { actionBtn } from "@/lib/action-button"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppUpdateControls } from "@/components/app-update-controls"
import { ThemePresetPicker } from "@/components/theme-preset-picker"
import { useAppAutostart } from "@/hooks/use-app-autostart"
import type { AppController } from "@/hooks/use-app-controller"
import type { AppUpdater } from "@/hooks/use-app-updater"
import { useAsyncTask } from "@/hooks/use-async-task"
import type { ApiKeyMeta, AppView, TranslationCacheInfo } from "@/lib/app-types"
import {
  applyAppearance,
  resolveThemePreset,
  resolveThemeGradients,
  resolveDark,
  type ThemePreset,
} from "@/lib/theme"
import { formatInvokeError, ipc, isTauriRuntime } from "@/lib/tauri-ipc"
import { cn } from "@/lib/utils"

const MODEL_OPTIONS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
] as const

const APP_SETTINGS_TAB_KEY = "app-settings-tab"

type AppSettingsTab = "gemini" | "engine" | "system" | "appearance"

const LEGACY_APP_SETTINGS_TABS = new Set(["notifications", "updates"])

function isAppSettingsTab(value: string): value is AppSettingsTab {
  return (
    value === "gemini" ||
    value === "engine" ||
    value === "system" ||
    value === "appearance"
  )
}

function loadAppSettingsTab(): AppSettingsTab {
  if (typeof window === "undefined") return "gemini"
  try {
    const stored = window.localStorage.getItem(APP_SETTINGS_TAB_KEY)
    if (stored && LEGACY_APP_SETTINGS_TABS.has(stored)) return "system"
    return stored && isAppSettingsTab(stored) ? stored : "gemini"
  } catch {
    return "gemini"
  }
}

function saveAppSettingsTab(tab: AppSettingsTab) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(APP_SETTINGS_TAB_KEY, tab)
  } catch {
    /* ignore storage failures */
  }
}

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
                className="flex items-center gap-2 rounded-lg bg-surface-gradient px-2 py-1.5 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
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
  action,
  children,
}: {
  icon: typeof FolderCogIcon
  title: string
  description: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft-gradient text-primary">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>{title}</CardTitle>
              {action}
            </div>
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
  section = "game",
  updater,
}: {
  controller: AppController
  onOpenSetup?: () => void
  onNavigate?: (view: AppView) => void
  section?: "app" | "game"
  updater?: AppUpdater
}) {
  const { state, actions } = controller
  const [config, setConfig] = useState(() => ({
    ...state.config,
    themePreset: resolveThemePreset(state.config.themePreset),
    themeGradients: resolveThemeGradients(state.config.themeGradients),
  }))
  const [apiOpen, setApiOpen] = useState(false)
  const [clearCacheOpen, setClearCacheOpen] = useState(false)
  const [cacheInfo, setCacheInfo] = useState<TranslationCacheInfo | null>(null)
  const {
    run: runCacheTask,
    loading: cacheLoading,
    title: cacheLoadingTitle,
    description: cacheLoadingDescription,
    phase: cacheLoadingPhase,
    phaseLabel: cacheLoadingPhaseLabel,
    progress: cacheLoadingProgress,
  } = useAsyncTask()
  const [appTab, setAppTab] = useState<AppSettingsTab>(() => loadAppSettingsTab())
  const autostart = useAppAutostart()
  const themePreset = resolveThemePreset(config.themePreset)
  const themeGradients = resolveThemeGradients(config.themeGradients)
  const previewMode = resolveDark(config.theme) ? "dark" : "light"
  const changed = JSON.stringify(config) !== JSON.stringify(state.config)

  useEffect(() => {
    applyAppearance(config.theme, themePreset, themeGradients)
  }, [config.theme, themePreset, themeGradients])

  useEffect(() => {
    const savedPreset = resolveThemePreset(state.config.themePreset)
    const savedGradients = resolveThemeGradients(state.config.themeGradients)
    return () => {
      applyAppearance(state.config.theme, savedPreset, savedGradients)
    }
  }, [state.config.theme, state.config.themePreset, state.config.themeGradients])

  useEffect(() => {
    if (section !== "game" || !isTauriRuntime()) return
    void refreshCacheInfo()
  }, [section])

  async function refreshCacheInfo() {
    if (!isTauriRuntime()) return
    try {
      await runCacheTask({
        title: "Đang đọc cache dịch…",
        description: "Đếm mục trong file cache Gemini.",
        task: () => ipc.getTranslationCacheInfo(),
        renderResult: setCacheInfo,
      })
    } catch {
      setCacheInfo(null)
    }
  }

  async function openTranslationCache() {
    try {
      await ipc.openTranslationCache()
    } catch (error) {
      toast.error(formatInvokeError(error))
    }
  }

  async function clearTranslationCache() {
    try {
      const result = await runCacheTask({
        title: "Đang xóa cache…",
        description: "Reset file cache bản dịch.",
        phase: "saving",
        task: () => ipc.clearTranslationCache(),
      })
      if (!result) return
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
        eyebrow={section === "app" ? "Ứng dụng" : "Civilization VII"}
        title={section === "app" ? "Cài đặt ứng dụng" : "Cài đặt"}
        description={
          section === "app"
            ? "API, model, thông báo, khởi động cùng Windows và giao diện."
            : "Đường dẫn game, glossary, report, cache dịch và tùy chọn deploy. API, model và giao diện nằm ở Cài đặt ứng dụng."
        }
        action={
          section === "game" && onOpenSetup ? (
            <Button variant="outline" onClick={onOpenSetup}>
              <SparklesIcon data-icon="inline-start" />
              Chạy lại thiết lập
            </Button>
          ) : undefined
        }
      />

      {section === "game" && (
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
      )}

      {section === "app" && (
      <Tabs
        value={appTab}
        onValueChange={(value) => {
          if (!isAppSettingsTab(value)) return
          setAppTab(value)
          saveAppSettingsTab(value)
        }}
        className="gap-4"
      >
        <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="gemini">
            <KeyRoundIcon />
            Gemini
          </TabsTrigger>
          <TabsTrigger value="engine">
            <LanguagesIcon />
            Engine dịch
          </TabsTrigger>
          <TabsTrigger value="system">
            <PowerIcon />
            Hệ thống
          </TabsTrigger>
          <TabsTrigger value="appearance">
            <MonitorCogIcon />
            Giao diện
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gemini" className="flex flex-col gap-4">
      <SettingsCard
        icon={KeyRoundIcon}
        title="Gemini API keys"
        description="Credential bảo mật, ưu tiên và trạng thái kết nối"
        action={
          <Button
            className="shrink-0"
            variant={actionBtn.manageApi}
            onClick={() => setApiOpen(true)}
          >
            <KeyRoundIcon data-icon="inline-start" />
            Mở trình quản lý API
          </Button>
        }
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
                  className="flex items-start gap-3 rounded-lg bg-surface-gradient px-3 py-2.5 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
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
                          key.status === "valid" && "text-success",
                          key.status === "active" && "text-info",
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
        </TabsContent>

        <TabsContent value="engine" className="flex flex-col gap-4">
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
        </FieldGroup>
      </SettingsCard>
        </TabsContent>

        <TabsContent value="system" className="flex flex-col gap-4">
      <SettingsCard
        icon={PowerIcon}
        title="Khởi động cùng Windows"
        description="Đăng ký với Windows để mở ứng dụng khi đăng nhập"
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="autostart-enabled">
                Tự động khởi chạy ứng dụng của bạn khi hệ thống khởi động
              </FieldLabel>
              <FieldDescription>
                {autostart.available
                  ? "Mở app khi đăng nhập Windows. Cửa sổ ẩn xuống khay hệ thống; bấm icon khay để hiện lại."
                  : "Chỉ khả dụng ở bản đã cài desktop."}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="autostart-enabled"
              checked={autostart.enabled}
              disabled={
                !autostart.available || !autostart.ready || autostart.pending
              }
              onCheckedChange={(checked) =>
                void autostart.setAutostartEnabled(checked)
              }
            />
          </Field>
        </FieldGroup>
      </SettingsCard>
      <SettingsCard
        icon={BellIcon}
        title="Thông báo Windows"
        description="Native OS khi tác vụ pipeline CIV7 hoặc engine Legend kết thúc — không chứa secret"
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Bao gồm dịch Legend, inspect, dịch lại dòng và các lệnh engine Legend
          khác, cùng các bước pipeline CIV7.
        </p>
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
        icon={DownloadIcon}
        title="Cập nhật trong app"
        description="Kiểm tra GitHub Releases, xác nhận rồi cài installer NSIS (kèm engine dịch)"
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="auto-check-updates">
                Tự kiểm tra khi mở app
              </FieldLabel>
              <FieldDescription>
                Hiện dialog khi có bản mới. Không bao giờ cài khi đang có tác vụ
                dịch.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="auto-check-updates"
              checked={updater?.autoCheckEnabled ?? true}
              disabled={!updater}
              onCheckedChange={(checked) =>
                updater?.setAutoCheckEnabled(checked)
              }
            />
          </Field>
        </FieldGroup>
        <div className="mt-4">
          {updater ? (
            <AppUpdateControls updater={updater} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Cập nhật trong app chỉ khả dụng ở bản cài desktop.
            </p>
          )}
        </div>
      </SettingsCard>
        </TabsContent>

        <TabsContent value="appearance" className="flex flex-col gap-4">
      <SettingsCard
        icon={MonitorCogIcon}
        title="Giao diện"
        description="10 bộ màu, mỗi bộ có bản sáng và tối. Gradient áp dụng cho nền trang, sidebar và bề mặt."
      >
        <FieldGroup>
          <Field>
            <FieldLabel>Chế độ</FieldLabel>
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
          <Field>
            <FieldLabel>Bộ màu</FieldLabel>
            <ThemePresetPicker
              value={themePreset}
              mode={previewMode}
              gradients={themeGradients}
              onChange={(preset: ThemePreset) =>
                setConfig((current) => ({
                  ...current,
                  themePreset: preset,
                }))
              }
            />
            <FieldDescription>
              Đổi bộ màu xem trước ngay. Bấm Lưu thay đổi để giữ lại.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="theme-gradients">Nền gradient</FieldLabel>
              <FieldDescription>
                Bật để dùng nền và bề mặt gradient theo bộ màu. Tắt thì toàn app
                dùng màu phẳng.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="theme-gradients"
              checked={themeGradients}
              onCheckedChange={(checked) =>
                setConfig((current) => ({
                  ...current,
                  themeGradients: checked,
                }))
              }
            />
          </Field>
        </FieldGroup>
      </SettingsCard>
        </TabsContent>
      </Tabs>
      )}

      <AlertDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa cache dịch CIV7?</AlertDialogTitle>
            <AlertDialogDescription>
              {cacheInfo?.exists && cacheInfo.entries > 0
                ? `Sẽ xóa ${cacheInfo.entries.toLocaleString("vi-VN")} mục trong cache pipeline Civilization VII. Lần dịch sau sẽ gọi API lại cho các câu đã cache. Cache Tam Quốc (Legend) không bị ảnh hưởng.`
                : "File cache CIV7 sẽ được reset về trống. Cache Tam Quốc (Legend) không bị ảnh hưởng."}
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

      {section === "game" && (
      <>
      <SettingsCard
        icon={DatabaseIcon}
        title="Dữ liệu"
        description="Report và glossary của Civilization VII"
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

      <SettingsCard
        icon={DatabaseIcon}
        title="Cache dịch"
        description="Kết quả Gemini đã dịch, lưu trong AppData/civ7/cache/"
      >
        <div className="relative">
          <AsyncLoadingOverlay
            visible={cacheLoading}
            title={cacheLoadingTitle}
            description={cacheLoadingDescription}
            phase={cacheLoadingPhase ?? undefined}
            phaseLabel={cacheLoadingPhaseLabel ?? undefined}
            progress={cacheLoadingProgress}
          />
          <FieldGroup>
            <Field>
              <div className="flex flex-wrap items-center gap-2">
                <FieldLabel htmlFor="data-cachePath">File cache</FieldLabel>
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
                {cacheInfo?.path ? (
                  <>
                    {" "}
                    ·{" "}
                    <span className="text-xs leading-tight break-all">
                      {cacheInfo.path}
                    </span>
                  </>
                ) : null}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={FolderCogIcon}
        title="Nâng cao"
        description="Giới hạn file và tùy chọn triển khai"
      >
        <FieldGroup>
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
      </>
      )}
      </div>

      <div className="sticky bottom-0 z-20 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div
          className={cn(
            pageShellClass,
            "flex items-center gap-2 py-2",
            changed ? "justify-between" : "justify-end",
          )}
        >
          {changed ? (
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs leading-tight sm:text-sm">
              <SlidersHorizontalIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-warning dark:text-warning"
              />
              <span className="min-w-0 truncate">
                <span className="font-medium text-warning-foreground dark:text-warning">
                  Có thay đổi chưa lưu
                </span>
                <span className="hidden text-muted-foreground sm:inline">
                  {" · "}
                  {section === "app"
                    ? "Model có thể ảnh hưởng bước Dịch."
                    : "Đường dẫn và cache có thể ảnh hưởng pipeline."}
                </span>
              </span>
            </p>
          ) : null}
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={!changed}
              onClick={() => setConfig(state.config)}
            >
              Hoàn tác
            </Button>
            <Button
              size="sm"
              variant={actionBtn.save}
              disabled={!changed}
              onClick={() => void save()}
            >
              <SaveIcon data-icon="inline-start" />
              Lưu
            </Button>
          </div>
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

