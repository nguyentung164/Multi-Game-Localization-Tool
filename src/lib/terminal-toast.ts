import { toast } from "@/lib/safe-toast"

export type TerminalJobSource = "civ7" | "legend"

export type TerminalJobOutcome = "completed" | "failed" | "paused"

export function toastTerminalJobOutcome(
  source: TerminalJobSource,
  type: TerminalJobOutcome,
  message: string,
): void {
  const prefix = source === "civ7" ? "CIV7" : "Legend"
  const body = message.trim() || defaultTerminalMessage(type)

  if (type === "completed") {
    toast.success(`${prefix}: ${body}`)
    return
  }
  if (type === "failed") {
    toast.error(`${prefix}: ${body}`)
    return
  }
  toast.warning(`${prefix}: ${body}`)
}

function defaultTerminalMessage(type: TerminalJobOutcome): string {
  switch (type) {
    case "completed":
      return "Tác vụ hoàn tất."
    case "failed":
      return "Tác vụ thất bại."
    case "paused":
      return "Tác vụ đã tạm dừng hoặc bị hủy."
  }
}
