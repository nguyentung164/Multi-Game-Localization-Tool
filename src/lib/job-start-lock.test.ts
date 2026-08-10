import { describe, expect, it } from "vitest"
import { isDuplicateJobStartError } from "@/lib/job-start-lock"

describe("isDuplicateJobStartError", () => {
  it("bắt object camelCase của CommandError", () => {
    expect(
      isDuplicateJobStartError({
        code: "job_already_running",
        message: "Chỉ được chạy một job tại một thời điểm",
      }),
    ).toBe(true)
  })

  it("bắt chuỗi Display của Rust", () => {
    expect(
      isDuplicateJobStartError(
        "job_already_running: Chỉ được chạy một job tại một thời điểm",
      ),
    ).toBe(true)
  })

  it("bắt Error.message là JSON", () => {
    expect(
      isDuplicateJobStartError(
        new Error(
          JSON.stringify({
            code: "job_already_running",
            message: "Chỉ được chạy một job tại một thời điểm",
          }),
        ),
      ),
    ).toBe(true)
  })

  it("bắt thông báo dùng từ tác vụ", () => {
    expect(
      isDuplicateJobStartError({
        code: "job_already_running",
        message: "Chỉ được chạy một tác vụ tại một thời điểm",
      }),
    ).toBe(true)
  })

  it("không nuốt lỗi khác", () => {
    expect(isDuplicateJobStartError({ message: "API key không hợp lệ" })).toBe(
      false,
    )
  })
})
