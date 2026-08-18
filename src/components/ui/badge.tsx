import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "bg-primary-gradient text-primary-foreground [a]:hover:brightness-110",
        secondary:
          "bg-secondary-gradient text-secondary-foreground [a]:hover:brightness-110",
        destructive:
          "bg-surface-gradient text-destructive focus-visible:ring-destructive/20 [a]:hover:brightness-105",
        success:
          "bg-surface-gradient text-success focus-visible:ring-success/20 [a]:hover:brightness-105",
        warning:
          "bg-surface-gradient text-warning focus-visible:ring-warning/20 dark:text-warning [a]:hover:brightness-105",
        info:
          "bg-surface-gradient text-info focus-visible:ring-info/20 [a]:hover:brightness-105",
        outline:
          "bg-surface-gradient text-foreground [a]:hover:brightness-105",
        ghost:
          "text-foreground hover:bg-muted-gradient hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
