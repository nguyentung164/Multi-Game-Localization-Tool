import { describe, expect, it } from "vitest"
import { displayWindowsPath, pathBasename } from "@/lib/path-utils"

describe("displayWindowsPath", () => {
  it("strips the Windows verbatim prefix", () => {
    expect(
      displayWindowsPath(
        "\\\\?\\B:\\SteamLibrary\\steamapps\\common\\LegendOfHeros\\file.txt",
      ),
    ).toBe("B:\\SteamLibrary\\steamapps\\common\\LegendOfHeros\\file.txt")
  })

  it("converts verbatim UNC paths", () => {
    expect(displayWindowsPath("\\\\?\\UNC\\server\\share\\file.txt")).toBe(
      "\\\\server\\share\\file.txt",
    )
  })

  it("keeps normal paths unchanged", () => {
    expect(displayWindowsPath("B:\\SteamLibrary\\game\\file.txt")).toBe(
      "B:\\SteamLibrary\\game\\file.txt",
    )
  })
})

describe("pathBasename", () => {
  it("returns the last path segment", () => {
    expect(pathBasename("Localization/en_US/UI_Text.xml")).toBe("UI_Text.xml")
    expect(pathBasename("B:\\Games\\CIV7\\UI_Text.xml")).toBe("UI_Text.xml")
  })
})
