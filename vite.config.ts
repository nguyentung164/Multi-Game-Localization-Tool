import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          if (id.includes("@tauri-apps")) return "tauri"
          if (id.includes("react")) return "react"
          if (id.includes("radix-ui")) return "radix"
          if (id.includes("lucide-react")) return "icons"
          return "vendor"
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore build output and localization data folders inside the repo.
      ignored: [
        "**/src-tauri/**",
        "**/translate/**",
        "**/.english.staging-*/**",
        "**/engine/dist/**",
        "**/engine/build/**",
        "**/*.xml",
        "**/*.vtt",
      ],
    },
  },
}));
