import {
  useCallback,
  useEffect,
  useState,
  Suspense,
} from "react";
import {
  BookOpenIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  Settings2Icon,
  WorkflowIcon,
} from "lucide-react";
import { AboutPage } from "@/components/about-page";
import { AppLoadingShell } from "@/components/app-loading-shell";
import { AppUpdateDialog } from "@/components/app-update-dialog";
import { AsyncLoadingOverlay } from "@/components/async-loading-overlay";
import { AppTitlebar } from "@/components/app-titlebar";
import { GameSidebarIcon } from "@/components/game-sidebar-icon";
import { DashboardPage } from "@/components/dashboard-page";
import { GlossaryPage } from "@/components/glossary-page";
import { HelpPage } from "@/components/help-page";
import { LegendThreeKingdomsPage } from "@/components/legend-three-kingdoms-page";
import { LegendSearchPage } from "@/components/legend-search-page";
import { LegendGlossaryPage } from "@/components/legend-glossary-page";
import { LegendHistoryPage } from "@/components/legend-history-page";
import { LegendSettingsPage } from "@/components/legend-settings-page";
import { PipelineLoadingShell } from "@/components/pipeline-loading-shell";
import { PresenceAlert, PageSlot } from "@/components/presence-fade";
import { ReportsPage } from "@/components/reports-page";
import { SearchPage } from "@/components/search-page";
import { SettingsPage } from "@/components/settings-page";
import { SetupDialog } from "@/components/setup-dialog";
import { AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { useAppController } from "@/hooks/use-app-controller";
import { useAppNotifications } from "@/hooks/use-app-notifications";
import { useAppUpdater } from "@/hooks/use-app-updater";
import { useGameIcons } from "@/hooks/use-game-icons";
import { useLegendTranslation } from "@/hooks/use-legend-translation";
import { usePresenceTransition } from "@/hooks/use-presence-transition";
import { useJobProgress } from "@/lib/job-progress-store";
import type { AppView, StepId } from "@/lib/app-types";
import {
  GAME_NAVIGATION,
  getGameNavigationGroup,
  getProductLabel,
  isCiv7View,
  shouldAutoOpenSetup,
  VIEW_LABELS,
  type GameNavigationId,
} from "@/lib/navigation";
import { LazyPipelinePage, prefetchPipelineChunk } from "@/lib/pipeline-chunk";
import { loadSidebarState, saveSidebarState } from "@/lib/sidebar-state";
import { dismissBootSplash } from "@/lib/boot-splash";
import {
  applyAppearance,
  loadStoredTheme,
  loadStoredThemePreset,
  resolveThemePreset,
  saveStoredTheme,
  saveStoredThemePreset,
} from "@/lib/theme";
import {
  formatInvokeError,
  ipc,
  isTauriRuntime,
} from "@/lib/tauri-ipc";
import { toast } from "sonner";

function GameNavigation({
  view,
  civRunning,
  legendRunning,
  onNavigate,
}: {
  view: AppView;
  civRunning: boolean;
  legendRunning: boolean;
  onNavigate: (view: AppView) => void;
}) {
  const { state: sidebarState, setOpen: setSidebarOpen } = useSidebar();
  const { icons: gameIcons, pickGameIcon } = useGameIcons();
  const activeGroupId = getGameNavigationGroup(view)?.id;
  const [openGroups, setOpenGroups] = useState<
    Record<GameNavigationId, boolean>
  >(() => loadSidebarState().openGroups);

  const persistOpenGroups = useCallback(
    (next: Record<GameNavigationId, boolean>) => {
      setOpenGroups(next);
      saveSidebarState({ openGroups: next });
    },
    [],
  );

  useEffect(() => {
    if (!activeGroupId) return;
    setOpenGroups((current) => {
      if (current[activeGroupId]) return current;
      const next = { ...current, [activeGroupId]: true };
      saveSidebarState({ openGroups: next });
      return next;
    });
  }, [activeGroupId]);

  return (
    <SidebarMenu>
      {GAME_NAVIGATION.map((group) => {
        const groupIsActive = activeGroupId === group.id;

        return (
          <Collapsible
            key={group.id}
            asChild
            open={openGroups[group.id]}
            onOpenChange={(open) => {
              if (sidebarState === "collapsed") {
                setSidebarOpen(true);
                persistOpenGroups({
                  ...openGroups,
                  [group.id]: true,
                });
                return;
              }
              persistOpenGroups({ ...openGroups, [group.id]: open });
            }}
            className="group/collapsible"
          >
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  isActive={groupIsActive}
                  tooltip={group.label}
                >
                  <GameSidebarIcon
                    gameId={group.id}
                    label={group.label}
                    src={gameIcons[group.id]}
                    onPick={pickGameIcon}
                  />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="ml-auto shrink-0 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
                  />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {group.items.map((item) => {
                    const ItemIcon = item.icon;
                    const isPipeline = item.id === "pipeline";
                    const itemRunning =
                      (isPipeline && civRunning) ||
                      (item.id === "legend-three-kingdoms" && legendRunning);

                    return (
                      <SidebarMenuSubItem key={item.id}>
                        <SidebarMenuSubButton
                          asChild
                          isActive={view === item.id}
                        >
                          <button
                            type="button"
                            className="w-full min-w-0 justify-start text-left"
                            aria-current={view === item.id ? "page" : undefined}
                            onClick={() => onNavigate(item.id)}
                            onMouseEnter={
                              isPipeline
                                ? () => prefetchPipelineChunk()
                                : undefined
                            }
                            onFocus={
                              isPipeline
                                ? () => prefetchPipelineChunk()
                                : undefined
                            }
                          >
                            <ItemIcon aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">
                              {item.label}
                            </span>
                            {itemRunning && (
                              <span
                                className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums"
                                aria-label="Có một tác vụ đang chạy"
                              >
                                1
                              </span>
                            )}
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    );
                  })}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        );
      })}
    </SidebarMenu>
  );
}

function App() {
  const controller = useAppController();
  const legend = useLegendTranslation(
    controller.state.activeJob?.status === "running",
  );
  const [view, setView] = useState<AppView>(() => loadSidebarState().view);
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSidebarState().open);
  const [setupOpenOverride, setSetupOpenOverride] = useState<boolean | null>(
    null,
  );
  const [searchKeepAlive, setSearchKeepAlive] = useState(
    () => loadSidebarState().view === "search",
  );
  const [legendSearchKeepAlive, setLegendSearchKeepAlive] = useState(
    () => loadSidebarState().view === "legend-search",
  );
  const [legendGlossaryDirty, setLegendGlossaryDirty] = useState(false);
  const { state, loading, busyAction, connectionError } = controller;
  const loadingPresence = usePresenceTransition(loading, 220);
  const setupOpen =
    setupOpenOverride ?? shouldAutoOpenSetup(view, state.setupComplete);
  const updateSetupForView = useCallback(
    (next: AppView) => {
      setSetupOpenOverride((current) => {
        if (!isCiv7View(next)) return false;
        if (!state.setupComplete) return null;
        return current;
      });
    },
    [state.setupComplete],
  );
  const applyView = useCallback(
    (next: AppView) => {
      if (next === "search") setSearchKeepAlive(true);
      if (next === "legend-search") setLegendSearchKeepAlive(true);
      updateSetupForView(next);
      saveSidebarState({ view: next });
      setView(next);
    },
    [updateSetupForView],
  );
  const onNavigate = useCallback(
    (next: AppView, options?: { step?: StepId }) => {
      if (
        view === "legend-glossary" &&
        next !== view &&
        legendGlossaryDirty &&
        !window.confirm(
          "Glossary có thay đổi chưa lưu. Rời trang và bỏ thay đổi?",
        )
      ) {
        return;
      }
      if (view === "legend-glossary" && next !== view) {
        setLegendGlossaryDirty(false);
      }
      if (options?.step) {
        controller.actions.selectStep(options.step);
      }
      applyView(next);
    },
    [applyView, controller.actions, legendGlossaryDirty, view],
  );
  const navigateView = useCallback(
    (next: AppView) => {
      if (
        view === "legend-glossary" &&
        next !== view &&
        legendGlossaryDirty &&
        !window.confirm(
          "Glossary có thay đổi chưa lưu. Rời trang và bỏ thay đổi?",
        )
      ) {
        return;
      }
      if (view === "legend-glossary" && next !== view) {
        setLegendGlossaryDirty(false);
      }
      applyView(next);
    },
    [applyView, legendGlossaryDirty, view],
  );
  useEffect(() => {
    const preference = loading ? loadStoredTheme() : state.config.theme;
    const preset = loading
      ? loadStoredThemePreset()
      : resolveThemePreset(state.config.themePreset);
    applyAppearance(preference, preset);
    if (!loading) {
      saveStoredTheme(preference);
      saveStoredThemePreset(preset);
    }

    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyAppearance("system", preset);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [loading, state.config.theme, state.config.themePreset]);
  useEffect(() => {
    void prefetchPipelineChunk();
  }, []);
  useEffect(() => {
    dismissBootSplash();
  }, []);
  useEffect(() => {
    if (!isTauriRuntime() || loading) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const openLegendFile = async (path: string) => {
      navigateView("legend-three-kingdoms");
      try {
        await legend.inspect(path);
      } catch (error) {
        toast.error(formatInvokeError(error));
      }
    };

    void (async () => {
      unlisten = await ipc.listenToOpenLegendFile((path) => {
        void openLegendFile(path);
      });
      if (cancelled) {
        unlisten?.();
        return;
      }
      const pending = await ipc.takePendingLaunchFile();
      if (cancelled || !pending) return;
      await openLegendFile(pending);
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [legend.inspect, loading, navigateView]);
  const civRunning = state.activeJob?.status === "running";
  const legendRunning = legend.isJobActive;
  const running = civRunning || legendRunning;
  const liveJob = useJobProgress();
  const notifications = useAppNotifications({
    civ7Events: state.events,
    legendEvents: legend.events,
    civ7Running: civRunning,
    legendRunning,
    progress: legendRunning ? legend.progress.progress : liveJob?.progress,
    notificationsEnabled: state.config.notifications.enabled,
  });
  const updater = useAppUpdater({
    busy: running,
    ready: !loading,
  });
  return (
    <SidebarProvider
      className="h-svh flex-col overflow-hidden"
      open={sidebarOpen}
      onOpenChange={(open) => {
        setSidebarOpen(open);
        saveSidebarState({ open });
      }}
    >
      <AppTitlebar
        productLabel={getProductLabel(view)}
        viewLabel={VIEW_LABELS[view]}
        running={running}
        progress={legendRunning ? legend.progress.progress : liveJob?.progress}
        notifications={notifications}
        onNavigate={onNavigate}
        onToggleTheme={() => {
          const nextTheme = document.documentElement.classList.contains("dark")
            ? "light"
            : "dark";
          const preset = resolveThemePreset(state.config.themePreset);
          applyAppearance(nextTheme, preset);
          saveStoredTheme(nextTheme);
          void controller.actions.saveConfig(
            { ...state.config, theme: nextTheme },
            { silent: true },
          );
        }}
      />
      <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        <Sidebar
          variant="inset"
          collapsible="icon"
          className="top-11! inset-y-auto! h-[calc(100svh-2.75rem)]!"
        >
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Trò chơi</SidebarGroupLabel>
              <SidebarGroupContent>
                <GameNavigation
                  view={view}
                  civRunning={civRunning}
                  legendRunning={legendRunning}
                  onNavigate={navigateView}
                />
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
                  <span className="min-w-0 flex-1 truncate">Hướng dẫn</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "about"}
                  tooltip="Giới thiệu"
                  onClick={() => navigateView("about")}
                >
                  <BookOpenIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">Giới thiệu</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "app-settings"}
                  tooltip="Cài đặt ứng dụng"
                  className="text-primary data-active:bg-sidebar-accent data-active:font-medium data-active:text-primary hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:text-primary"
                  onClick={() => navigateView("app-settings")}
                >
                  <Settings2Icon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    Cài đặt ứng dụng
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div className="group-data-[collapsible=icon]:hidden">
              <div className="rounded-lg bg-surface-gradient p-2 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]">
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
          <PresenceAlert
            show={Boolean(connectionError)}
            variant="destructive"
            className="m-4 mb-0"
          >
            <WorkflowIcon />
            <AlertTitle>Không kết nối được orchestrator</AlertTitle>
            <AlertDescription>
              {connectionError}. Giao diện không tự chuyển sang demo khi đang
              chạy trong Tauri.
            </AlertDescription>
          </PresenceAlert>
          <main
            className={
              (view === "pipeline" ||
                view === "glossary" ||
                view === "search" ||
                view === "legend-search" ||
                view === "reports") &&
              !loading
                ? "relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
                : "relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
            }
          >
            {!loading ? (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1">
              <AsyncLoadingOverlay
                visible={Boolean(busyAction)}
                title={busyAction?.title ?? "Đang xử lý…"}
                description={busyAction?.description}
                phase={busyAction?.phase}
              />
              <PageSlot show={view === "dashboard"} className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto">
                <DashboardPage
                  controller={controller}
                  onNavigate={onNavigate}
                  onOpenSetup={() => setSetupOpenOverride(true)}
                />
              </PageSlot>
              <PageSlot
                show={view === "pipeline"}
                className="absolute inset-0 h-full min-h-0 w-full overflow-hidden"
              >
                <Suspense fallback={<PipelineLoadingShell />}>
                  <LazyPipelinePage
                    active
                    controller={controller}
                    onNavigate={onNavigate}
                  />
                </Suspense>
              </PageSlot>
              <PageSlot show={view === "reports"} className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto">
                <ReportsPage controller={controller} />
              </PageSlot>
              {searchKeepAlive ? (
                <PageSlot
                  show={view === "search"}
                  keepMounted
                  className="absolute inset-0 h-full min-h-0 w-full overflow-hidden"
                >
                  <SearchPage controller={controller} />
                </PageSlot>
              ) : null}
              <PageSlot show={view === "glossary"} className="absolute inset-0 h-full min-h-0 w-full overflow-hidden">
                <GlossaryPage
                  controller={controller}
                  onNavigate={onNavigate}
                />
              </PageSlot>
              <PageSlot show={view === "settings"} className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto">
                <SettingsPage
                  key={`game-${JSON.stringify(state.config)}`}
                  section="game"
                  controller={controller}
                  onOpenSetup={() => setSetupOpenOverride(true)}
                  onNavigate={onNavigate}
                />
              </PageSlot>
              <PageSlot
                show={view === "app-settings"}
                className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto"
              >
                <SettingsPage
                  key={`app-${JSON.stringify(state.config)}`}
                  section="app"
                  controller={controller}
                  onNavigate={onNavigate}
                  updater={updater}
                />
              </PageSlot>
              <PageSlot
                show={view === "legend-three-kingdoms"}
                className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto"
              >
                <LegendThreeKingdomsPage
                  controller={controller}
                  legend={legend}
                  onNavigate={onNavigate}
                />
              </PageSlot>
              {legendSearchKeepAlive ? (
                <PageSlot
                  show={view === "legend-search"}
                  keepMounted
                  className="absolute inset-0 h-full min-h-0 w-full overflow-hidden"
                >
                  <LegendSearchPage
                    legend={legend}
                    locked={running}
                    onNavigate={onNavigate}
                  />
                </PageSlot>
              ) : null}
              <PageSlot
                show={view === "legend-glossary"}
                className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto"
              >
                <LegendGlossaryPage
                  locked={running}
                  onDirtyChange={setLegendGlossaryDirty}
                />
              </PageSlot>
              <PageSlot
                show={view === "legend-history"}
                className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto"
              >
                <LegendHistoryPage
                  locked={running}
                  onRestored={(sourcePath) => {
                    legend.setSourcePath(sourcePath);
                    void legend.inspect(sourcePath);
                  }}
                />
              </PageSlot>
              <PageSlot
                show={view === "legend-settings"}
                className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto"
              >
                <LegendSettingsPage legend={legend} locked={running} />
              </PageSlot>
              <PageSlot show={view === "help"} className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto">
                <HelpPage />
              </PageSlot>
              <PageSlot show={view === "about"} className="absolute inset-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-auto">
                <AboutPage onNavigate={navigateView} updater={updater} />
              </PageSlot>
              </div>
            </div>
            ) : null}
            {loadingPresence.mounted ? (
              <div className="absolute inset-0 z-10 bg-background">
                <AppLoadingShell presenceState={loadingPresence.state} />
              </div>
            ) : null}
          </main>
        </SidebarInset>
      </div>
      <SetupDialog
        key={JSON.stringify(state.config)}
        open={setupOpen}
        onOpenChange={setSetupOpenOverride}
        controller={controller}
      />
      <AppUpdateDialog updater={updater} busy={running} />
      <Toaster position="top-right" />
    </SidebarProvider>
  );
}
export default App;
