import { useEffect, useState } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

const TOASTER_STYLE = {
  "--normal-bg": "var(--toast-normal-bg)",
  "--normal-text": "var(--toast-normal-text)",
  "--normal-border": "var(--toast-normal-border)",
  "--success-bg": "var(--toast-success-bg)",
  "--success-border": "var(--toast-success-border)",
  "--success-text": "var(--toast-success-text)",
  "--error-bg": "var(--toast-error-bg)",
  "--error-border": "var(--toast-error-border)",
  "--error-text": "var(--toast-error-text)",
  "--warning-bg": "var(--toast-warning-bg)",
  "--warning-border": "var(--toast-warning-border)",
  "--warning-text": "var(--toast-warning-text)",
  "--info-bg": "var(--toast-info-bg)",
  "--info-border": "var(--toast-info-border)",
  "--info-text": "var(--toast-info-text)",
  "--border-radius": "var(--radius)",
  "--toast-close-button-start": "unset",
  "--toast-close-button-end": "0.625rem",
  "--toast-close-button-transform": "translateY(-50%)",
} as React.CSSProperties

function useDocumentTheme(): NonNullable<ToasterProps["theme"]> {
  const [theme, setTheme] = useState<"light" | "dark">("light")

  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      setTheme(root.classList.contains("dark") ? "dark" : "light")
    }

    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return theme
}

const Toaster = ({
  richColors = true,
  closeButton = true,
  ...props
}: ToasterProps) => {
  const theme = useDocumentTheme()

  return (
    <Sonner
      theme={theme}
      richColors={richColors}
      closeButton={closeButton}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={TOASTER_STYLE}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          description: "text-current/72",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
