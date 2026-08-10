import { describe, expect, it } from "vitest"
import { getPathConflict } from "@/components/setup-dialog"
import { demoState } from "@/lib/demo-state"

describe("getPathConflict", () => {
  it("chấp nhận ba thư mục độc lập", () => {
    const config = {
      ...demoState.config,
      gamePath: "B:\\Games\\Civilization VII",
      exportPath: "C:\\CIV7\\exported",
      modPath: "C:\\CIV7\\vietnam",
    }

    expect(getPathConflict(config)).toBeNull()
  })

  it("phát hiện thư mục trùng nhau không phân biệt hoa thường", () => {
    const config = {
      ...demoState.config,
      gamePath: "C:\\Games\\CIV7\\",
      exportPath: "c:\\games\\civ7",
      modPath: "C:\\CIV7\\vietnam",
    }

    expect(getPathConflict(config)).toContain("không được trùng")
  })

  it("phát hiện đường dẫn lồng nhau với cả dấu gạch chéo xuôi", () => {
    const config = {
      ...demoState.config,
      gamePath: "C:/Games/CIV7",
      exportPath: "C:/Games/CIV7/exported",
      modPath: "C:/CIV7/vietnam",
    }

    expect(getPathConflict(config)).toContain("không được trùng hoặc lồng nhau")
  })
})
