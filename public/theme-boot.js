/* Keep in sync with src/lib/theme.ts (storage keys + resolveDark + presets). */
(function applyStoredTheme() {
  var BOOT_PRESETS = {
    zinc: {
      light: {
        bg: "#f7f7f8",
        fg: "#18181b",
        primary: "#18181b",
        gradient:
          "linear-gradient(180deg, #fafafa 0%, #f4f4f5 55%, #ececee 100%)",
      },
      dark: {
        bg: "#18181b",
        fg: "#fafafa",
        primary: "#fafafa",
        gradient:
          "linear-gradient(180deg, #18181b 0%, #27272a 55%, #3f3f46 100%)",
      },
    },
    indigo: {
      light: {
        bg: "#f4f3fb",
        fg: "#1d1b3a",
        primary: "#4f46b8",
        gradient:
          "linear-gradient(160deg, #f8f7fd 0%, #eeedf8 55%, #faf9ff 100%)",
      },
      dark: {
        bg: "#161428",
        fg: "#f0eefc",
        primary: "#b4b0f5",
        gradient:
          "linear-gradient(160deg, #161428 0%, #1e1c38 55%, #12101f 100%)",
      },
    },
    emerald: {
      light: {
        bg: "#f3faf6",
        fg: "#143024",
        primary: "#0f766e",
        gradient:
          "linear-gradient(155deg, #f3faf6 0%, #ecfdf5 50%, #f0fdfa 100%)",
      },
      dark: {
        bg: "#10201b",
        fg: "#e8f6f0",
        primary: "#5eead4",
        gradient:
          "linear-gradient(155deg, #10201b 0%, #134e4a 48%, #0f1c1c 100%)",
      },
    },
    rose: {
      light: {
        bg: "#fdf6f7",
        fg: "#3b1520",
        primary: "#be123c",
        gradient:
          "linear-gradient(145deg, #fdf6f7 0%, #fff1f2 55%, #fdf2f8 100%)",
      },
      dark: {
        bg: "#1d1014",
        fg: "#fce8ec",
        primary: "#fb7185",
        gradient:
          "linear-gradient(145deg, #1d1014 0%, #431407 45%, #4a044e 100%)",
      },
    },
    sky: {
      light: {
        bg: "#f0f9ff",
        fg: "#0c4a6e",
        primary: "#0369a1",
        gradient:
          "linear-gradient(160deg, #f0f9ff 0%, #e0f2fe 55%, #f8fafc 100%)",
      },
      dark: {
        bg: "#0b1724",
        fg: "#e0f2fe",
        primary: "#7dd3fc",
        gradient:
          "linear-gradient(160deg, #0b1724 0%, #123047 55%, #0f172a 100%)",
      },
    },
    aurora: {
      light: {
        bg: "#f3fbf7",
        fg: "#134e4a",
        primary: "#0f766e",
        gradient:
          "linear-gradient(155deg, #ecfdf5 0%, #eef2ff 50%, #f0fdfa 100%)",
      },
      dark: {
        bg: "#0f1c1c",
        fg: "#ccfbf1",
        primary: "#5eead4",
        gradient:
          "linear-gradient(155deg, #0f1c1c 0%, #1e1b4b 48%, #134e4a 100%)",
      },
    },
    sunset: {
      light: {
        bg: "#fff7ed",
        fg: "#7c2d12",
        primary: "#c2410c",
        gradient:
          "linear-gradient(145deg, #fff7ed 0%, #fdf2f8 55%, #fff1f2 100%)",
      },
      dark: {
        bg: "#1c1010",
        fg: "#ffedd5",
        primary: "#fb7185",
        gradient:
          "linear-gradient(145deg, #1c1010 0%, #431407 45%, #4a044e 100%)",
      },
    },
    ocean: {
      light: {
        bg: "#f0f9ff",
        fg: "#1e3a5f",
        primary: "#1d4ed8",
        gradient:
          "linear-gradient(165deg, #eff6ff 0%, #e0f2fe 50%, #ecfeff 100%)",
      },
      dark: {
        bg: "#0b1220",
        fg: "#dbeafe",
        primary: "#38bdf8",
        gradient:
          "linear-gradient(165deg, #0b1220 0%, #0c4a6e 55%, #082f49 100%)",
      },
    },
    violet: {
      light: {
        bg: "#faf5ff",
        fg: "#3b0764",
        primary: "#7c3aed",
        gradient:
          "linear-gradient(150deg, #faf5ff 0%, #fdf2f8 55%, #f5f3ff 100%)",
      },
      dark: {
        bg: "#1a1025",
        fg: "#f3e8ff",
        primary: "#d8b4fe",
        gradient:
          "linear-gradient(150deg, #1a1025 0%, #4a044e 50%, #2e1065 100%)",
      },
    },
    nord: {
      light: {
        bg: "#eceff4",
        fg: "#2e3440",
        primary: "#5e81ac",
        gradient:
          "linear-gradient(180deg, #eceff4 0%, #e5e9f0 55%, #d8dee9 100%)",
      },
      dark: {
        bg: "#2e3440",
        fg: "#eceff4",
        primary: "#88c0d0",
        gradient:
          "linear-gradient(180deg, #2e3440 0%, #3b4252 55%, #434c5e 100%)",
      },
    },
  };

  function applyBootTheme(preset, dark, gradients) {
    var fallback = BOOT_PRESETS.indigo[dark ? "dark" : "light"];
    var swatch =
      BOOT_PRESETS[preset] && BOOT_PRESETS[preset][dark ? "dark" : "light"]
        ? BOOT_PRESETS[preset][dark ? "dark" : "light"]
        : fallback;
    var root = document.documentElement;
    root.style.setProperty("--boot-bg", swatch.bg);
    root.style.setProperty("--boot-fg", swatch.fg);
    root.style.setProperty("--boot-primary", swatch.primary);
    root.style.setProperty("--boot-gradient", gradients ? swatch.gradient : "none");
    root.style.setProperty(
      "--boot-glow",
      gradients
        ? "radial-gradient(ellipse 80% 50% at 50% -20%, color-mix(in srgb, " +
            swatch.primary +
            " 18%, transparent), transparent)"
        : "none",
    );
  }

  try {
    var stored = localStorage.getItem("app-ui-theme");
    var theme =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
    var preset = localStorage.getItem("app-ui-theme-preset");
    if (preset === "amber") preset = "sunset";
    var presets = [
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
    ];
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = theme === "dark" || (theme === "system" && prefersDark);
    var gradients = localStorage.getItem("app-ui-theme-gradients") !== "off";
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("light", !dark);
    root.style.colorScheme = dark ? "dark" : "light";
    var resolvedPreset = presets.indexOf(preset) >= 0 ? preset : "indigo";
    root.setAttribute("data-theme", resolvedPreset);
    root.setAttribute("data-gradients", gradients ? "on" : "off");
    applyBootTheme(resolvedPreset, dark, gradients);
  } catch (_error) {
    /* Ignore private-mode / storage failures and keep the light splash. */
    document.documentElement.setAttribute("data-gradients", "on");
    applyBootTheme("indigo", false, true);
  }
})();
