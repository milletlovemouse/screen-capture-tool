import { defineConfig } from "vite";

// Vite 配置：多页面（主窗口 + 框选覆盖窗），固定端口供 Tauri 加载
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: "index.html",
        overlay: "overlay.html",
        indicator: "indicator.html",
        "point-picker": "point-picker.html",
        "automation-status": "automation-status.html",
      },
    },
  },
});
