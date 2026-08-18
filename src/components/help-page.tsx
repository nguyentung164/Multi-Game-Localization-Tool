import { useState } from "react"
import { ChevronDownIcon, CircleHelpIcon } from "lucide-react"
import { PageHeader, pageContainerClass } from "@/components/product-ui"
import { Button } from "@/components/ui/button"
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
import {
  helpGameGuides,
  helpSharedFaq,
  type HelpGameId,
} from "@/content/help-sections"
import { cn } from "@/lib/utils"

export function HelpPage() {
  const [activeGame, setActiveGame] = useState<HelpGameId>("civ7")
  const guide =
    helpGameGuides.find((item) => item.id === activeGame) ?? helpGameGuides[0]
  const [openFaq, setOpenFaq] = useState<string | null>(
    guide.faq[0]?.id ?? helpSharedFaq[0]?.id ?? null,
  )

  return (
    <div className={pageContainerClass}>
      <PageHeader
        eyebrow="Hỗ trợ"
        title="Hướng dẫn sử dụng"
        description="Chọn profile game để xem workflow, thao tác và câu hỏi thường gặp tương ứng."
      />

      <div className="flex flex-wrap gap-2">
        {helpGameGuides.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            className={cn(
              "h-auto px-3 py-2 text-left text-sm",
              activeGame === item.id && "interactive-surface-active",
            )}
            onClick={() => {
              setActiveGame(item.id)
              setOpenFaq(item.faq[0]?.id ?? null)
            }}
          >
            {item.title}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{guide.title}</CardTitle>
          <CardDescription>{guide.summary}</CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {guide.sections.map((section) => (
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
            FAQ — {guide.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {guide.faq.map((item) => {
            const open = openFaq === item.id
            return (
              <Collapsible
                key={item.id}
                open={open}
                onOpenChange={(next) => setOpenFaq(next ? item.id : null)}
              >
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium">
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
          <CardTitle className="flex items-center gap-2">
            <CircleHelpIcon className="size-5" />
            FAQ — Chung
          </CardTitle>
          <CardDescription>
            Áp dụng cho mọi profile game trong ứng dụng
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {helpSharedFaq.map((item) => {
            const open = openFaq === item.id
            return (
              <Collapsible
                key={item.id}
                open={open}
                onOpenChange={(next) => setOpenFaq(next ? item.id : null)}
              >
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium">
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
    </div>
  )
}
