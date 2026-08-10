import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { DashboardPage } from "@/components/dashboard-page"
import { PipelinePage } from "@/components/pipeline-page"
import { SearchPage } from "@/components/search-page"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AppController } from "@/hooks/use-app-controller"
import { demoState } from "@/lib/demo-state"
import { formatAppStateDates } from "@/lib/format-date"
import type { AppState, JobEvent, SyncChange } from "@/lib/app-types"
import { ipc } from "@/lib/tauri-ipc"

function withProviders(node: ReactNode) {
  return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>
}

vi.mock("@/lib/tauri-ipc", () => ({
  isTauriRuntime: () => true,
  formatInvokeError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ipc: {
    listTags: vi.fn(async () => ({
      scannedFiles: 1200,
      totalMatches: 5000,
      truncated: true,
      matches: Array.from({ length: 5000 }, (_, i) => ({
        id: `tag-${i}`,
        tag: `LOC_TAG_${i}`,
        file: `File${i % 200}.xml`,
        english: `English ${i}`,
        vietnamese: `Vietnamese ${i}`,
        sourcePath: "export",
      })),
    })),
    searchTags: vi.fn(),
  },
}))

function makeController(state: AppState): AppController {
  return {
    state,
    setState: () => {},
    loading: false,
    connectionError: null,
    isDesktop: true,
    activeKey: null,
    actions: {
      selectStep: () => {},
      startJob: async () => null,
      cancelJob: async () => {},
      saveConfig: async () => {},
      addKey: async () => {},
      testKey: async () => {},
      toggleKey: async () => {},
      renameKey: async () => {},
      moveKey: async () => {},
      deleteKey: async () => {},
      restoreBackup: async () => {},
      deleteBackup: async () => {},
      clearReports: async () => {},
      clearJobEvents: async () => {},
    },
  } as unknown as AppController
}

function heavyState(): AppState {
  return {
    ...structuredClone(demoState),
    syncChanges: Array.from({ length: 10_000 }, (_, i) => ({
      id: `sync-${i}`,
      kind: "add" as const,
      file: `File${i % 200}.xml`,
      tag: `TAG_${i}`,
    })) satisfies SyncChange[],
    events: Array.from({ length: 500 }, (_, i) => ({
      id: `evt-${i}`,
      seq: i,
      timestamp: "2026-08-10T00:00:00.000Z",
      level: "info" as const,
      title: `Event ${i}`,
      description: "desc",
      step: "translate" as const,
    })) satisfies JobEvent[],
  }
}

describe("App boot perf evidence", () => {
  it("formatAppStateDates with 10k sync + 500 events", () => {
    const state = heavyState()
    const start = performance.now()
    for (let i = 0; i < 20; i++) formatAppStateDates(state)
    const ms = (performance.now() - start) / 20
    console.log(`[perf] formatAppStateDates heavy: ${ms.toFixed(2)} ms/call`)
    expect(ms).toBeGreaterThan(0)
  })

  it("Dashboard-only mount", () => {
    const start = performance.now()
    const view = render(
      <DashboardPage
        controller={makeController(structuredClone(demoState))}
        onNavigate={() => {}}
        onOpenSetup={() => {}}
      />,
    )
    const ms = performance.now() - start
    const nodes = view.container.querySelectorAll("*").length
    console.log(`[perf] Dashboard mount: ${ms.toFixed(1)} ms, DOM: ${nodes}`)
    view.unmount()
  })

  it("Dashboard + Search mount without auto IPC", async () => {
    const controller = makeController(structuredClone(demoState))
    const start = performance.now()
    const view = render(
      <div>
        <DashboardPage
          controller={controller}
          onNavigate={() => {}}
          onOpenSetup={() => {}}
        />
        <div className="hidden">
          <SearchPage controller={controller} />
        </div>
      </div>,
    )
    const mountMs = performance.now() - start
    const nodes = view.container.querySelectorAll("*").length
    console.log(
      `[perf] Dashboard+Search mount (no auto load): ${mountMs.toFixed(1)} ms, DOM: ${nodes}`,
    )
    expect(ipc.listTags).not.toHaveBeenCalled()
    expect(ipc.searchTags).not.toHaveBeenCalled()
    view.unmount()
  })

  it("Pipeline inactive warm-up to full phase (mirrors App.tsx boot gate)", async () => {
    const state = heavyState()
    const controller = makeController(state)
    let prepared = false
    const view = render(
      withProviders(
        <PipelinePage
          active={false}
          controller={controller}
          onNavigate={() => {}}
          onReadyChange={(ready) => {
            prepared = ready
          }}
        />,
      ),
    )
    const mountMs = performance.now()
    await waitFor(() => expect(prepared).toBe(true), { timeout: 5000 })
    const warmMs = performance.now() - mountMs
    const nodes = view.container.querySelectorAll("*").length
    console.log(
      `[perf] Pipeline inactive → full: ${warmMs.toFixed(1)} ms, DOM: ${nodes}`,
    )
    view.unmount()
  })

  it("Deploy click paints lightweight status before invoking backend", async () => {
    const state = structuredClone(demoState)
    state.selectedStep = "deploy"
    state.activeJob = null
    state.deployApplied = false
    state.deployChanges = Array.from({ length: 10_000 }, (_, index) => ({
      id: `deploy-${index}`,
      kind: "copy" as const,
      file: `Base/text/File${index}.xml`,
    }))
    state.steps = state.steps.map((step) =>
      step.id === "translate"
        ? { ...step, status: "success" }
        : step.id === "deploy"
          ? {
              ...step,
              status: "success",
              lockedReason: undefined,
              summary: { ...step.summary, changes: 10_000, files: 10_000 },
            }
          : step,
    )
    const controller = makeController(state)
    const startJob = vi.fn(async () => ({ jobId: "deploy-job" }))
    controller.actions.startJob = startJob

    const view = render(
      withProviders(
        <PipelinePage active controller={controller} onNavigate={() => {}} />,
      ),
    )

    const deployButton = await screen.findByRole("button", {
      name: /^Triển khai vào game$/i,
    })
    await screen.findByText("Kết quả triển khai")
    fireEvent.click(deployButton)

    expect(startJob).not.toHaveBeenCalled()
    expect(screen.getByText("Đang khởi động tác vụ")).toBeInTheDocument()
    expect(screen.queryByText("Kết quả triển khai")).not.toBeInTheDocument()
    await waitFor(() => expect(startJob).toHaveBeenCalledWith("deploy", "run"))

    view.unmount()
  })

  it("Boot spike: Pipeline full + Dashboard mount (current App.tsx timing)", async () => {
    const state = heavyState()
    const controller = makeController(state)
    let prepared = false

    const pipeline = render(
      withProviders(
        <PipelinePage
          active={false}
          controller={controller}
          onNavigate={() => {}}
          onReadyChange={(ready) => {
            prepared = ready
          }}
        />,
      ),
    )
    await waitFor(() => expect(prepared).toBe(true), { timeout: 5000 })

    const spikeStart = performance.now()
    await act(async () => {
      render(
        <div>
          <DashboardPage
            controller={controller}
            onNavigate={() => {}}
            onOpenSetup={() => {}}
          />
          <div className="hidden">
            <SearchPage controller={controller} />
          </div>
        </div>,
      )
    })
    const spikeMs = performance.now() - spikeStart
    const pipelineNodes = pipeline.container.querySelectorAll("*").length
    console.log(
      `[perf] Boot spike (Pipeline full ${pipelineNodes} nodes + Dashboard+Search): ${spikeMs.toFixed(1)} ms`,
    )
    pipeline.unmount()
  })
})
