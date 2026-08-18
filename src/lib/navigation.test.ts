import { describe, expect, it } from "vitest";
import {
  GAME_NAVIGATION,
  getGameNavigationGroup,
  getProductLabel,
  isCiv7View,
  shouldAutoOpenSetup,
  VIEW_LABELS,
} from "@/lib/navigation";

describe("game navigation", () => {
  it("keeps the six existing CIV7 views under CIV7", () => {
    const civ7 = GAME_NAVIGATION.find((group) => group.id === "civ7");

    expect(civ7?.items.map((item) => item.id)).toEqual([
      "dashboard",
      "pipeline",
      "reports",
      "search",
      "glossary",
      "settings",
    ]);
  });

  it("exposes the Three Kingdoms view under Legend", () => {
    const legend = GAME_NAVIGATION.find((group) => group.id === "legend");

    expect(legend?.items.map((item) => item.id)).toEqual([
      "legend-three-kingdoms",
      "legend-search",
      "legend-glossary",
      "legend-history",
      "legend-settings",
    ]);
    expect(getGameNavigationGroup("legend-three-kingdoms")?.id).toBe("legend");
  });

  it("derives game-aware titlebar labels", () => {
    expect(getProductLabel("dashboard")).toBe("Sid Meier's Civilization VII");
    expect(getProductLabel("legend-three-kingdoms")).toBe(
      "Legend of Heroes Three Kingdoms",
    );
    expect(getProductLabel("help")).toBe("Multi-Game Localization Tool");
    expect(VIEW_LABELS["legend-three-kingdoms"]).toBe("Dịch");
    expect(VIEW_LABELS["legend-search"]).toBe("Tra cứu");
    expect(VIEW_LABELS["legend-settings"]).toBe("Cài đặt");
    expect(VIEW_LABELS["app-settings"]).toBe("Cài đặt ứng dụng");
    expect(getProductLabel("app-settings")).toBe("Multi-Game Localization Tool");
    expect(isCiv7View("settings")).toBe(true);
    expect(isCiv7View("app-settings")).toBe(false);
    expect(isCiv7View("legend-three-kingdoms")).toBe(false);
  });

  it("only auto-opens setup for incomplete CIV7 views", () => {
    expect(shouldAutoOpenSetup("dashboard", false)).toBe(true);
    expect(shouldAutoOpenSetup("dashboard", true)).toBe(false);
    expect(shouldAutoOpenSetup("legend-three-kingdoms", false)).toBe(false);
    expect(shouldAutoOpenSetup("help", false)).toBe(false);
    expect(shouldAutoOpenSetup("app-settings", false)).toBe(false);
  });
});
