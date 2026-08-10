import {
  BadgeCheckIcon,
  BookOpenIcon,
  CodeXmlIcon,
  ExternalLinkIcon,
  HeartIcon,
  LanguagesIcon,
  ShieldCheckIcon,
} from "lucide-react"
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
import type { AppView } from "@/lib/app-types"
import { APP_REPO_URL, APP_VERSION } from "@/lib/app-meta"
import { isTauriRuntime } from "@/lib/tauri-ipc"

export function AboutPage({
  onNavigate,
}: {
  onNavigate?: (view: AppView) => void
}) {
  const openRepo = () => {
    if (isTauriRuntime()) {
      void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
        openUrl(APP_REPO_URL),
      )
      return
    }
    window.open(APP_REPO_URL, "_blank", "noopener,noreferrer")
  }

  return (
    <div className={pageContainerClass}>
      <PageHeader
        eyebrow="Thông tin"
        title="CIV7 Localization Tool"
        description="Ứng dụng desktop hỗ trợ vận hành pipeline bản địa hóa Civilization VII an toàn, minh bạch và có thể tiếp tục."
      />
      <Card className="overflow-hidden">
        <CardHeader className="">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md">
            <LanguagesIcon aria-hidden="true" />
          </div>
          <CardTitle className="text-xl">CIV7 Localization Tool</CardTitle>
          <CardDescription>
            Phiên bản {APP_VERSION} · Tauri 2 · React 19 · Windows x64
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pt-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <ShieldCheckIcon className="mb-3 size-5 text-success" />
              <p className="font-medium">An toàn dữ liệu</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Backup, dry-run và ghi atomic.
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <BadgeCheckIcon className="mb-3 size-5 text-primary" />
              <p className="font-medium">Credential bảo mật</p>
              <p className="mt-1 text-sm text-muted-foreground">
                API key nằm trong Windows Credential Manager.
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <HeartIcon className="mb-3 size-5 text-destructive" />
              <p className="font-medium">Dành cho cộng đồng</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Tối ưu cho quy trình dịch tiếng Việt.
              </p>
            </div>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <Badge variant="outline">Protocol v1</Badge>
              <Badge variant="outline">Engine bundled</Badge>
              <Badge variant="outline">UTF-8</Badge>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate?.("help")}
              >
                <BookOpenIcon data-icon="inline-start" />
                Hướng dẫn
              </Button>
              <Button variant="outline" size="sm" onClick={openRepo}>
                <CodeXmlIcon data-icon="inline-start" />
                Mã nguồn
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
