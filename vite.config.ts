import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

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
      // 3. HMR 僅需監看前端檔案；後端環境含數萬個檔案，會使 Windows watcher 失去回應。
      ignored: [
        "**/src-tauri/**",
        "**/server/**",
        "**/openspec/**",
        "**/.claude/**",
        "**/.github/**",
        "**/.local/**",
        "**/.opencode/**",
      ],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        overlay: "overlay.html",
      },
    },
  },
}));
