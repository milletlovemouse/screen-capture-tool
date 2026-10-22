import { getCurrentWindow } from "@tauri-apps/api/window";
import { $ } from "../core/dom.js";
import { IS_MAC } from "../shared/platform.js";

// 绑定 Windows 自定义标题栏按钮，关闭操作仍进入现有关闭确认流程。
export function setupWindowControls() {
  if (IS_MAC) return;

  const appWindow = getCurrentWindow();
  $("window-minimize").addEventListener("click", () => {
    void appWindow.minimize();
  });
  $("window-maximize").addEventListener("click", () => {
    void appWindow.toggleMaximize();
  });
  $("window-close").addEventListener("click", () => {
    void appWindow.close();
  });
}
