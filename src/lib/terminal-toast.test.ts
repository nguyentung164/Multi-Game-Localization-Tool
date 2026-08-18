import { describe, expect, it, vi } from "vitest"
import { toastTerminalJobOutcome } from "@/lib/terminal-toast"

vi.mock("@/lib/safe-toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

import { toast } from "@/lib/safe-toast"

describe("toastTerminalJobOutcome", () => {
  it("gọi toast.success cho completed CIV7", () => {
    toastTerminalJobOutcome("civ7", "completed", "Hoàn tất Dịch")
    expect(toast.success).toHaveBeenCalledWith("CIV7: Hoàn tất Dịch")
  })

  it("gọi toast.error cho failed Legend", () => {
    toastTerminalJobOutcome("legend", "failed", "Engine lỗi")
    expect(toast.error).toHaveBeenCalledWith("Legend: Engine lỗi")
  })

  it("gọi toast.warning cho paused", () => {
    toastTerminalJobOutcome("legend", "paused", "Đã hủy")
    expect(toast.warning).toHaveBeenCalledWith("Legend: Đã hủy")
  })
})
