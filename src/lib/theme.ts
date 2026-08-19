import type { AppConfig } from "@/lib/app-types"

export const THEME_STORAGE_KEY = "app-ui-theme"
export const THEME_PRESET_STORAGE_KEY = "app-ui-theme-preset"
export const THEME_GRADIENTS_STORAGE_KEY = "app-ui-theme-gradients"

export const THEME_PRESET_IDS = [
  "zinc",
  "indigo",
  "emerald",
  "rose",
  "sky",
  "aurora",
  "sunset",
  "ocean",
  "violet",
  "nord",
] as const

export type ThemePreference = AppConfig["theme"]
export type ThemePreset = (typeof THEME_PRESET_IDS)[number]

export const DEFAULT_THEME_PRESET: ThemePreset = "indigo"
export const DEFAULT_THEME_GRADIENTS = true

const LEGACY_THEME_PRESETS: Record<string, ThemePreset> = {
  amber: "sunset",
}

export type ThemeSwatch = {
  bg: string
  fg: string
  primary: string
  gradient?: string
}

export type ThemePresetMeta = {
  id: ThemePreset
  label: string
  description: string
  light: ThemeSwatch
  dark: ThemeSwatch
}

export const THEME_PRESETS: readonly ThemePresetMeta[] = [
  {
    id: "zinc",
    label: "Zinc",
    description: "Trung tính, kiểu shadcn",
    light: { bg: "#f7f7f8", fg: "#18181b", primary: "#18181b" },
    dark: { bg: "#18181b", fg: "#fafafa", primary: "#fafafa" },
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "Chàm, dễ đọc lâu",
    light: { bg: "#f4f3fb", fg: "#1d1b3a", primary: "#4f46b8" },
    dark: { bg: "#161428", fg: "#f0eefc", primary: "#b4b0f5" },
  },
  {
    id: "emerald",
    label: "Emerald",
    description: "Lục bảo, tươi",
    light: { bg: "#f3faf6", fg: "#143024", primary: "#0f766e" },
    dark: { bg: "#10201b", fg: "#e8f6f0", primary: "#5eead4" },
  },
  {
    id: "rose",
    label: "Rose",
    description: "Hồng đào",
    light: { bg: "#fdf6f7", fg: "#3b1520", primary: "#be123c" },
    dark: { bg: "#1d1014", fg: "#fce8ec", primary: "#fb7185" },
  },
  {
    id: "sky",
    label: "Sky",
    description: "Xanh trời",
    light: {
      bg: "#f0f9ff",
      fg: "#0c4a6e",
      primary: "#0369a1",
      gradient: "linear-gradient(160deg, #f0f9ff 0%, #e0f2fe 55%, #f8fafc 100%)",
    },
    dark: {
      bg: "#0b1724",
      fg: "#e0f2fe",
      primary: "#7dd3fc",
      gradient: "linear-gradient(160deg, #0b1724 0%, #123047 55%, #0f172a 100%)",
    },
  },
  {
    id: "aurora",
    label: "Aurora",
    description: "Cực quang",
    light: {
      bg: "#f3fbf7",
      fg: "#134e4a",
      primary: "#0f766e",
      gradient: "linear-gradient(155deg, #ecfdf5 0%, #eef2ff 50%, #f0fdfa 100%)",
    },
    dark: {
      bg: "#0f1c1c",
      fg: "#ccfbf1",
      primary: "#5eead4",
      gradient: "linear-gradient(155deg, #0f1c1c 0%, #1e1b4b 48%, #134e4a 100%)",
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Hoàng hôn",
    light: {
      bg: "#fff7ed",
      fg: "#7c2d12",
      primary: "#c2410c",
      gradient: "linear-gradient(145deg, #fff7ed 0%, #fdf2f8 55%, #fff1f2 100%)",
    },
    dark: {
      bg: "#1c1010",
      fg: "#ffedd5",
      primary: "#fb7185",
      gradient: "linear-gradient(145deg, #1c1010 0%, #431407 45%, #4a044e 100%)",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Đại dương",
    light: {
      bg: "#f0f9ff",
      fg: "#1e3a5f",
      primary: "#1d4ed8",
      gradient: "linear-gradient(165deg, #eff6ff 0%, #e0f2fe 50%, #ecfeff 100%)",
    },
    dark: {
      bg: "#0b1220",
      fg: "#dbeafe",
      primary: "#38bdf8",
      gradient: "linear-gradient(165deg, #0b1220 0%, #0c4a6e 55%, #082f49 100%)",
    },
  },
  {
    id: "violet",
    label: "Violet",
    description: "Tím orchid",
    light: {
      bg: "#faf5ff",
      fg: "#3b0764",
      primary: "#7c3aed",
      gradient: "linear-gradient(150deg, #faf5ff 0%, #fdf2f8 55%, #f5f3ff 100%)",
    },
    dark: {
      bg: "#1a1025",
      fg: "#f3e8ff",
      primary: "#d8b4fe",
      gradient: "linear-gradient(150deg, #1a1025 0%, #4a044e 50%, #2e1065 100%)",
    },
  },
  {
    id: "nord",
    label: "Nord",
    description: "Bắc cực",
    light: {
      bg: "#eceff4",
      fg: "#2e3440",
      primary: "#5e81ac",
      gradient: "linear-gradient(180deg, #eceff4 0%, #e5e9f0 55%, #d8dee9 100%)",
    },
    dark: {
      bg: "#2e3440",
      fg: "#eceff4",
      primary: "#88c0d0",
      gradient: "linear-gradient(180deg, #2e3440 0%, #3b4252 55%, #434c5e 100%)",
    },
  },
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system"
}

export function isThemePreset(value: unknown): value is ThemePreset {
  return (
    typeof value === "string" &&
    (THEME_PRESET_IDS as readonly string[]).includes(value)
  )
}

export function resolveThemePreset(value: unknown): ThemePreset {
  if (isThemePreset(value)) return value
  if (typeof value === "string" && value in LEGACY_THEME_PRESETS) {
    return LEGACY_THEME_PRESETS[value]
  }
  return DEFAULT_THEME_PRESET
}

export function prefersDarkScheme(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function resolveDark(
  theme: ThemePreference,
  prefersDark = prefersDarkScheme(),
): boolean {
  return theme === "dark" || (theme === "system" && prefersDark)
}

export function resolveThemeGradients(value: unknown): boolean {
  if (value === false || value === "off" || value === "false") return false
  if (value === true || value === "on" || value === "true") return true
  return DEFAULT_THEME_GRADIENTS
}

function currentThemeGradients(): boolean {
  if (typeof document === "undefined") return DEFAULT_THEME_GRADIENTS
  return document.documentElement.dataset.gradients !== "off"
}

function applyThemeToDocument(
  dark: boolean,
  preset: ThemePreset,
  gradients = currentThemeGradients(),
) {
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.classList.toggle("light", !dark)
  root.style.colorScheme = dark ? "dark" : "light"
  root.dataset.theme = preset
  root.dataset.gradients = gradients ? "on" : "off"
}

export function applyDocumentTheme(dark: boolean) {
  if (typeof document === "undefined") return
  const preset = resolveThemePreset(document.documentElement.dataset.theme)
  applyThemeToDocument(dark, preset)
}

export function applyThemePreset(preset: ThemePreset) {
  if (typeof document === "undefined") return
  const dark = document.documentElement.classList.contains("dark")
  applyThemeToDocument(dark, preset)
}

export function applyThemePreference(theme: ThemePreference): boolean {
  const dark = resolveDark(theme)
  applyDocumentTheme(dark)
  return dark
}

export function applyAppearance(
  theme: ThemePreference,
  preset: ThemePreset,
  gradients?: boolean,
): boolean {
  const dark = resolveDark(theme)
  if (typeof document === "undefined") return dark
  applyThemeToDocument(dark, preset, gradients ?? currentThemeGradients())
  return dark
}

export function loadStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system"
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : "system"
  } catch {
    return "system"
  }
}

export function loadStoredThemePreset(): ThemePreset {
  if (typeof window === "undefined") return DEFAULT_THEME_PRESET
  try {
    const raw = window.localStorage.getItem(THEME_PRESET_STORAGE_KEY)
    return resolveThemePreset(raw)
  } catch {
    return DEFAULT_THEME_PRESET
  }
}

export function saveStoredTheme(theme: ThemePreference) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
}

export function saveStoredThemePreset(preset: ThemePreset) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, preset)
}

export function loadStoredThemeGradients(): boolean {
  if (typeof window === "undefined") return DEFAULT_THEME_GRADIENTS
  try {
    return resolveThemeGradients(
      window.localStorage.getItem(THEME_GRADIENTS_STORAGE_KEY),
    )
  } catch {
    return DEFAULT_THEME_GRADIENTS
  }
}

export function saveStoredThemeGradients(enabled: boolean) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(
    THEME_GRADIENTS_STORAGE_KEY,
    enabled ? "on" : "off",
  )
}
