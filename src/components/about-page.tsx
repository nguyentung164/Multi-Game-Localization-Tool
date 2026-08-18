import {
  BadgeCheckIcon,
  BookOpenIcon,
  HeartIcon,
  LanguagesIcon,
  LayersIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { AppUpdateControls } from "@/components/app-update-controls"
import { PageHeader, pageContainerClass } from "@/components/product-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import type { AppUpdater } from "@/hooks/use-app-updater"
import type { AppView } from "@/lib/app-types"
import { APP_NAME, APP_VERSION } from "@/lib/app-meta"

export function AboutPage({
  onNavigate,
  updater,
}: {
  onNavigate?: (view: AppView) => void
  updater?: AppUpdater
}) {
  return (
    <div className={pageContainerClass}>
      <PageHeader
        eyebrow="Thông tin"
        title={APP_NAME}
        description="Công cụ desktop Việt hóa đa game: mỗi tựa có workflow và màn hình riêng, dùng chung engine dịch Gemini, backup và xem trước trước khi ghi file."
      />
      <Card className="overflow-hidden">
        <CardHeader>
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary-soft-gradient text-primary shadow-md">
            <LanguagesIcon aria-hidden="true" />
          </div>
          <CardTitle className="text-xl">{APP_NAME}</CardTitle>
          <CardDescription>
            Phiên bản {updater?.currentVersion ?? APP_VERSION} · Tauri 2 · React
            19 · Windows x64
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pt-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-surface-gradient p-4 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]">
              <LayersIcon className="mb-3 size-5 text-primary" />
              <p className="font-medium">Đa profile game</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sidebar gom theo từng tựa; parser, glossary và cache tách riêng
                theo profile.
              </p>
            </div>
            <div className="rounded-lg bg-surface-gradient p-4 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]">
              <ShieldCheckIcon className="mb-3 size-5 text-success" />
              <p className="font-medium">An toàn dữ liệu</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Dry-run, backup tự động và ghi atomic trước mọi thay đổi quan
                trọng.
              </p>
            </div>
            <div className="rounded-lg bg-surface-gradient p-4 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]">
              <BadgeCheckIcon className="mb-3 size-5 text-primary" />
              <p className="font-medium">Credential bảo mật</p>
              <p className="mt-1 text-sm text-muted-foreground">
                API key nằm trong Windows Credential Manager, không lưu trong
                config.
              </p>
            </div>
            <div className="rounded-lg bg-surface-gradient p-4 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_6%,transparent)]">
              <HeartIcon className="mb-3 size-5 text-destructive" />
              <p className="font-medium">Dành cho cộng đồng</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Tối ưu cho quy trình dịch và duy trì bản Việt lâu dài.
              </p>
            </div>
          </div>
          {updater ? (
            <>
              <Separator />
              <AppUpdateControls updater={updater} />
            </>
          ) : null}
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <Badge variant="outline">Protocol v1</Badge>
              <Badge variant="outline">Engine bundled</Badge>
              <Badge variant="outline">UTF-8</Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate?.("help")}
            >
              <BookOpenIcon data-icon="inline-start" />
              Hướng dẫn
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
