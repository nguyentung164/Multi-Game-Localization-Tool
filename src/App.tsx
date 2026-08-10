import {
  useCallback,
  useEffect,
  useState,
  startTransition,
  Suspense,
} from "react"
import {
  BookAIcon,
  BookOpenIcon,
  CircleHelpIcon,
  FileBarChartIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  SearchIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  WorkflowIcon,
} from "lucide-react"
import { AboutPage } from "@/components/about-page"
import { AppTitlebar } from "@/components/app-titlebar"
import { DashboardPage } from "@/components/dashboard-page"
import { GlossaryPage } from "@/components/glossary-page"
import { HelpPage } from "@/components/help-page"
import { PipelineLoadingShell } from "@/components/pipeline-loading-shell"
import { ReportsPage } from "@/components/reports-page"
import { SearchPage } from "@/components/search-page"
import { SettingsPage } from "@/components/settings-page"
import { SetupDialog } from "@/components/setup-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster } from "@/components/ui/sonner"
import { useAppController } from "@/hooks/use-app-controller"
import { useJobProgress } from "@/lib/job-progress-store"
import type { AppView, StepId } from "@/lib/app-types"
import { LazyPipelinePage, prefetchPipelineChunk } from "@/lib/pipeline-chunk"
const navigation = [
  { id: "dashboard" as const, label: "Tổng quan", icon: LayoutDashboardIcon },
  { id: "pipeline" as const, label: "Pipeline", icon: WorkflowIcon },
  { id: "reports" as const, label: "Báo cáo", icon: FileBarChartIcon },
  { id: "search" as const, label: "Tra cứu", icon: SearchIcon },
  { id: "glossary" as const, label: "Glossary", icon: BookAIcon },
  { id: "settings" as const, label: "Cài đặt", icon: Settings2Icon },
]
const viewLabels: Record<AppView, string> = {
  dashboard: "Tổng quan",
  pipeline: "Pipeline",
  reports: "Báo cáo",
  search: "Tra cứu",
  glossary: "Glossary",
  settings: "Cài đặt",
  help: "Hướng dẫn",
  about: "Giới thiệu",
}

function AppLoadingShell() {
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-6 p-8"
      role="status"
      aria-live="polite"
      aria-label="Đang tải dữ liệu"
    >
      <Loader2Icon
        aria-hidden="true"
        className="size-8 animate-spin text-muted-foreground"
      />
      <div className="space-y-1 text-center">
        <p className="text-lg font-medium">Đang tải dữ liệu</p>
        <p className="text-sm text-muted-foreground">
          Đang đồng bộ trạng thái từ orchestrator…
        </p>
      </div>
      <div className="grid w-full max-w-lg gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      </div>
    </div>
  )
}

function App() {
  const controller = useAppController()
  const [view, setView] = useState<AppView>("dashboard")
  const [setupOpenOverride, setSetupOpenOverride] = useState<boolean | null>(
    null,
  )
  const [searchKeepAlive, setSearchKeepAlive] = useState(false)
  const { state, loading, connectionError } = controller
  const setupOpen = setupOpenOverride ?? !state.setupComplete
  const onNavigate = useCallback(
    (next: AppView, options?: { step?: StepId }) => {
      if (options?.step) {
        controller.actions.selectStep(options.step)
      }
      if (next === "search") setSearchKeepAlive(true)
      startTransition(() => setView(next))
    },
    [controller.actions],
  )
  const navigateView = useCallback((next: AppView) => {
    if (next === "search") setSearchKeepAlive(true)
    startTransition(() => setView(next))
  }, [])
  useEffect(() => {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches
    const dark =
      state.config.theme === "dark" ||
      (state.config.theme === "system" && prefersDark)
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
  }, [state.config.theme])
  useEffect(() => {
    void prefetchPipelineChunk()
  }, [])
  const running = state.activeJob?.status === "running"
  const liveJob = useJobProgress()
  return (
    <SidebarProvider className="h-svh flex-col overflow-hidden">
      <AppTitlebar
        viewLabel={viewLabels[view]}
        running={running}
        progress={liveJob?.progress}
        events={state.events}
        notificationsEnabled={state.config.notifications.enabled}
        onToggleTheme={() =>
          void controller.actions.saveConfig({
            ...state.config,
            theme: document.documentElement.classList.contains("dark")
              ? "light"
              : "dark",
          })
        }
      />
      <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        <Sidebar
          variant="inset"
          collapsible="icon"
          className="top-11! inset-y-auto! h-[calc(100svh-2.75rem)]!"
        >
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Vận hành</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigation.map((item) => {
                    const Icon = item.icon
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={view === item.id}
                          tooltip={item.label}
                          onClick={() => navigateView(item.id)}
                          onMouseEnter={
                            item.id === "pipeline"
                              ? () => prefetchPipelineChunk()
                              : undefined
                          }
                          onFocus={
                            item.id === "pipeline"
                              ? () => prefetchPipelineChunk()
                              : undefined
                          }
                        >
                          <Icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        {item.id === "pipeline" && running && (
                          <SidebarMenuBadge aria-label="Có một tác vụ đang chạy">
                            1
                          </SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "help"}
                  tooltip="Hướng dẫn"
                  onClick={() => navigateView("help")}
                >
                  <CircleHelpIcon aria-hidden="true" />
                  <span>Hướng dẫn</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "about"}
                  tooltip="Giới thiệu"
                  onClick={() => navigateView("about")}
                >
                  <BookOpenIcon aria-hidden="true" />
                  <span>Giới thiệu</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Thiết lập nhanh"
                  onClick={() => setSetupOpenOverride(true)}
                >
                  <SlidersHorizontalIcon aria-hidden="true" />
                  <span>Thiết lập nhanh</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div className="group-data-[collapsible=icon]:hidden">
              <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${
                      running ? "bg-info" : "bg-success"
                    }`}
                  />
                  <p className="text-xs font-medium">
                    {running ? "Engine đang hoạt động" : "Hệ thống sẵn sàng"}
                  </p>
                </div>
                <p className="mt-1 text-xs text-sidebar-foreground/60">
                  Protocol v1 · Engine bundled
                </p>
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {connectionError && (
            <Alert variant="destructive" className="m-4 mb-0">
              <WorkflowIcon />
              <AlertTitle>Không kết nối được orchestrator</AlertTitle>
              <AlertDescription>
                {connectionError}. Giao diện không tự chuyển sang demo khi đang
                chạy trong Tauri.
              </AlertDescription>
            </Alert>
          )}
          <main
            className={
              (view === "pipeline" ||
                view === "glossary" ||
                view === "search" ||
                view === "reports") &&
              !loading
                ? "relative min-h-0 w-full min-w-0 flex-1 overflow-hidden"
                : "min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
            }
          >
            {loading ? (
              <AppLoadingShell />
            ) : (
              <>
                {view === "dashboard" && (
                  <DashboardPage
                    controller={controller}
                    onNavigate={onNavigate}
                    onOpenSetup={() => setSetupOpenOverride(true)}
                  />
                )}
                {view === "pipeline" && (
                  <Suspense fallback={<PipelineLoadingShell />}>
                    <LazyPipelinePage
                      active
                      controller={controller}
                      onNavigate={onNavigate}
                    />
                  </Suspense>
                )}
                {view === "reports" && <ReportsPage controller={controller} />}
                {searchKeepAlive && (
                  <div
                    className={view === "search" ? "h-full min-h-0" : "hidden"}
                    aria-hidden={view !== "search"}
                  >
                    <SearchPage controller={controller} />
                  </div>
                )}
                {view === "glossary" && (
                  <GlossaryPage
                    controller={controller}
                    onNavigate={onNavigate}
                  />
                )}
                {view === "settings" && (
                  <SettingsPage
                    key={JSON.stringify(state.config)}
                    controller={controller}
                    onOpenSetup={() => setSetupOpenOverride(true)}
                    onNavigate={onNavigate}
                  />
                )}
                {view === "help" && <HelpPage />}
                {view === "about" && <AboutPage onNavigate={navigateView} />}
              </>
            )}
          </main>
        </SidebarInset>
      </div>
      <SetupDialog
        key={JSON.stringify(state.config)}
        open={setupOpen}
        onOpenChange={setSetupOpenOverride}
        controller={controller}
      />
      <Toaster position="top-right" richColors closeButton />
    </SidebarProvider>
  )
}
export default App
