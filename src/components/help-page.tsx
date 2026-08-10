import { useState } from "react"
import { ChevronDownIcon, CircleHelpIcon } from "lucide-react"
import { PageHeader, pageContainerClass } from "@/components/product-ui"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { helpFaq, helpSections } from "@/content/help-sections"
import { cn } from "@/lib/utils"

export function HelpPage() {
  const [openFaq, setOpenFaq] = useState<string | null>(helpFaq[0]?.id ?? null)

  return (
    <div className={pageContainerClass}>
      <PageHeader
        eyebrow="Hỗ trợ"
        title="Hướng dẫn sử dụng"
        description="Workflow pipeline, dry-run/apply, an toàn dữ liệu và câu hỏi thường gặp."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {helpSections.map((section) => (
          <Card key={section.id}>
            <CardHeader>
              <CardTitle className="text-base">{section.title}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleHelpIcon className="size-5" />
            FAQ
          </CardTitle>
          <CardDescription>Câu hỏi thường gặp khi vận hành bản địa hóa</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {helpFaq.map((item) => {
            const open = openFaq === item.id
            return (
              <Collapsible
                key={item.id}
                open={open}
                onOpenChange={(next) => setOpenFaq(next ? item.id : null)}
              >
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm font-medium hover:bg-muted/40">
                  {item.question}
                  <ChevronDownIcon
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      open && "rotate-180",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pt-2 pb-3 text-sm text-muted-foreground">
                  {item.answer}
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Luồng pipeline (tóm tắt)</CardTitle>
        </CardHeader>
        <CardContent className="text-xs leading-relaxed text-muted-foreground">
          Export → Inspect → Sync (dry-run → apply) → Translate → Deploy (dry-run → apply)
        </CardContent>
      </Card>
    </div>
  )
}
