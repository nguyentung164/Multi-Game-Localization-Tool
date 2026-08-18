import {
  AlertCircleIcon,
  BookAIcon,
  BookOpenIcon,
  CircleHelpIcon,
  FileBarChartIcon,
  FileCheck2Icon,
  KeyRoundIcon,
  LanguagesIcon,
  PlayIcon,
  RefreshCwIcon,
  RocketIcon,
  UploadCloudIcon,
  WorkflowIcon,
} from "lucide-react"
import {
  Metric,
  PageHeader,
  StatusBadge,
  pageContainerClass,
} from "@/components/product-ui"
import { PresenceAlert } from "@/components/presence-fade"
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { actionBtn, dashboardStepActionVariant } from "@/lib/action-button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { AppController } from "@/hooks/use-app-controller"
import { JobProgressBar } from "@/components/job-progress-bar"
import type { AppView, PipelineStep, StepId } from "@/lib/app-types"
import { useJobProgress } from "@/lib/job-progress-store"
import { STEP_LABELS } from "@/lib/app-types"
import { inspectSummaryMetrics } from "@/lib/inspect-diff"
import { findNextRunnableStep } from "@/lib/pipeline-gates"
import { cn } from "@/lib/utils"

const stepIcons = {
  export: UploadCloudIcon,
  inspect: FileCheck2Icon,
  sync: RefreshCwIcon,
  translate: LanguagesIcon,
  deploy: RocketIcon,
} as const

function formatStepMetric(step: PipelineStep): string {
  const { summary } = step
  if (summary.translated !== undefined) {
    return `${summary.translated.toLocaleString("vi-VN")} đã dịch`
  }
  if (summary.changes !== undefined) {
    return `${summary.changes.toLocaleString("vi-VN")} thay đổi`
  }
  if (summary.files !== undefined) {
    return `${summary.files.toLocaleString("vi-VN")} file`
  }
  if (summary.rows !== undefined) {
    return `${summary.rows.toLocaleString("vi-VN")} mục`
  }
  return "—"
}

export function DashboardPage({
  controller,
  onNavigate,
  onOpenSetup,
}: {
  controller: AppController
  onNavigate: (view: AppView, options?: { step?: StepId }) => void
  onOpenSetup: () => void
}) {
  const { state } = controller
  const nextStep = findNextRunnableStep(state.steps)
  const job = useJobProgress()
  const inspectMetrics = inspectSummaryMetrics(state.inspectSnapshot)
  const qaErrors = state.qaIssues.filter((issue) => issue.severity === "error").length
  const qaWarnings = state.qaIssues.filter((issue) => issue.severity === "warning").length
  const apiRequests = state.apiKeys.reduce((sum, key) => sum + key.localRequests, 0)
  const apiBlocked = state.apiKeys.filter(
    (key) => key.status === "rate-limited" || key.status === "quota-exhausted",
  ).length

  const goPipeline = (step?: StepId) => {
    if (step) controller.actions.selectStep(step)
    onNavigate("pipeline", step ? { step } : undefined)
  }

  return (
    <div className={pageContainerClass}>
      <PageHeader
        eyebrow="Trung tâm điều hành"
        title="Tổng quan"
        description="Theo dõi trạng thái pipeline, tác vụ đang chạy và các cảnh báo quan trọng."
        action={
          <div className="flex flex-wrap gap-2">
            {nextStep && (
              <Button
                variant={dashboardStepActionVariant(nextStep)}
                onClick={() => goPipeline(nextStep)}
              >
                <PlayIcon data-icon="inline-start" />
                Chạy {STEP_LABELS[nextStep]}
              </Button>
            )}
            <Button variant="outline" onClick={() => goPipeline()}>
              <WorkflowIcon data-icon="inline-start" />
              Mở Pipeline
            </Button>
          </div>
        }
      />

      <PresenceAlert show={!state.setupComplete}>
        <AlertCircleIcon />
        <AlertTitle>Cần thiết lập ban đầu</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>Cấu hình đường dẫn game, export và mod trước khi chạy pipeline.</span>
          <Button size="sm" variant="outline" onClick={onOpenSetup}>
            Mở thiết lập
          </Button>
        </AlertDescription>
      </PresenceAlert>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {state.steps.map((step) => {
          const Icon = stepIcons[step.id]
          return (
            <Card
              key={step.id}
              className="cursor-pointer transition-[filter] hover:brightness-[1.02]"
              onClick={() => goPipeline(step.id)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft-gradient text-primary">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <StatusBadge status={step.status} />
                </div>
                <CardTitle className="text-base">{step.shortTitle}</CardTitle>
                <CardDescription>{formatStepMetric(step)}</CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {step.lastRun ?? "Chưa chạy"}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card
          className={cn(
            job && "border-info/25 bg-linear-to-br from-info/10 via-card to-primary/8",
          )}
        >
          <CardHeader>
            <CardTitle>{job ? "Tác vụ đang chạy" : "Không có tác vụ active"}</CardTitle>
            <CardDescription>
              {job
                ? `${STEP_LABELS[job.step]} · ${job.id}`
                : nextStep
                  ? `Sẵn sàng chạy: ${STEP_LABELS[nextStep]}`
                  : "Pipeline ổn định — xem báo cáo hoặc chạy lại bước cần thiết."}
            </CardDescription>
          </CardHeader>
          {job && (
            <CardContent className="flex flex-col gap-3">
              <JobProgressBar />
              <Button size="sm" className="self-start" onClick={() => goPipeline(job.step)}>
                Xem chi tiết
              </Button>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API & quota</CardTitle>
            <CardDescription>{state.apiKeys.length} key đã cấu hình</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Metric icon={KeyRoundIcon} label="Request hôm nay" value={String(apiRequests)} />
            <Metric
              icon={AlertCircleIcon}
              label="Key bị chặn"
              value={String(apiBlocked)}
            />
            <Button
              size="sm"
              variant={actionBtn.manageApi}
              className="self-start"
              onClick={() => onNavigate("app-settings")}
            >
              Quản lý API
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>QA sau dịch</CardTitle>
            <CardDescription>Kết quả kiểm tra gần nhất</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Badge variant="destructive">{qaErrors} lỗi</Badge>
              <Badge variant="secondary">{qaWarnings} cảnh báo</Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => goPipeline("translate")}
            >
              Xem trong Pipeline
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Inspect gần nhất</CardTitle>
            <CardDescription>Chênh lệch EN ↔ VN</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Metric
              icon={FileCheck2Icon}
              label="File lệch"
              value={String(inspectMetrics.differentFiles)}
            />
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>Chỉ EN: {inspectMetrics.englishOnly}</span>
              <span>Chỉ VN: {inspectMetrics.vietnameseOnly}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => goPipeline("inspect")}
            >
              Xem diff
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lối tắt</CardTitle>
            <CardDescription>Công cụ thường dùng</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("glossary")}>
              <BookAIcon data-icon="inline-start" />
              Sửa Glossary
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("reports")}>
              <FileBarChartIcon data-icon="inline-start" />
              Báo cáo & Backup
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("help")}>
              <CircleHelpIcon data-icon="inline-start" />
              Hướng dẫn
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("about")}>
              <BookOpenIcon data-icon="inline-start" />
              Giới thiệu
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lịch sử chạy gần đây</CardTitle>
          <CardDescription>Tóm tắt nhanh — chi tiết tại mục Báo cáo</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {state.reports.slice(0, 5).map((report) => (
            <div
              key={report.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-gradient px-3 py-2 text-sm shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
            >
              <div>
                <p className="font-medium">{report.title}</p>
                <p className="text-xs text-muted-foreground">
                  {report.createdAt} · {report.duration}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{report.summary}</span>
                <StatusBadge status={report.status} />
              </div>
            </div>
          ))}
          {state.reports.length === 0 && (
            <p className="text-sm text-muted-foreground">Chưa có báo cáo nào.</p>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => onNavigate("reports")}
          >
            Xem tất cả báo cáo
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
