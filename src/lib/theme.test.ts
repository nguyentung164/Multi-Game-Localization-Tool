import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  THEME_PRESET_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_PRESET_IDS,
  applyAppearance,
  applyThemePreference,
  loadStoredTheme,
  loadStoredThemePreset,
  resolveDark,
  resolveThemePreset,
  saveStoredTheme,
  saveStoredThemePreset,
} from "@/lib/theme";

function mockPrefersDark(dark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: dark && query.includes("prefers-color-scheme: dark"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

describe("theme preference", () => {
  afterEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.localStorage.removeItem(THEME_PRESET_STORAGE_KEY);
    document.documentElement.classList.remove("dark", "light");
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    vi.unstubAllGlobals();
  });

  it("resolves explicit light/dark without using the OS preference", () => {
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
  });

  it("follows the OS when theme is system", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });

  it("defaults to system when storage is missing or invalid", () => {
    expect(loadStoredTheme()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(loadStoredTheme()).toBe("system");
  });

  it("persists the preference and applies it to the document", () => {
    mockPrefersDark(false);
    saveStoredTheme("dark");
    expect(loadStoredTheme()).toBe("dark");
    expect(applyThemePreference(loadStoredTheme())).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("boot script uses the same storage key as the TS helper", () => {
    const boot = readFileSync(
      path.resolve(process.cwd(), "public/theme-boot.js"),
      "utf8",
    );
    expect(boot).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(boot).toContain(`"${THEME_PRESET_STORAGE_KEY}"`);
  });

  it("defaults the color preset to indigo when storage is missing or invalid", () => {
    expect(THEME_PRESET_IDS).toHaveLength(10);
    expect(loadStoredThemePreset()).toBe("indigo");
    window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, "neon");
    expect(loadStoredThemePreset()).toBe("indigo");
  });

  it("maps the retired amber preset to sunset", () => {
    expect(resolveThemePreset("amber")).toBe("sunset");
    window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, "amber");
    expect(loadStoredThemePreset()).toBe("sunset");
  });

  it("persists the color preset and applies it to the document", () => {
    saveStoredThemePreset("rose");
    expect(loadStoredThemePreset()).toBe("rose");
    applyAppearance("light", loadStoredThemePreset());
    expect(document.documentElement.dataset.theme).toBe("rose");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});
