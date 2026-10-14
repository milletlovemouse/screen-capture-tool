import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, setStatus } from "../core/dom.js";
import { saveSettings } from "../core/settings.js";
import { refreshPermissions } from "./permissions.js";
import { pinned, setPinned } from "../core/state.js";

// 左侧菜单切换首页/设置/自动化/关于视图
export function setupNav() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  const views = document.querySelectorAll(".view");
  items.forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      items.forEach((b) => b.classList.toggle("active", b === btn));
      views.forEach((section) => {
        section.classList.toggle("hidden", section.id !== `view-${view}`);
      });
      // 进入设置时刷新一次权限状态
      if (view === "settings") refreshPermissions();
    });
  });
}

// 收起/展开侧边栏 + 窗口置顶
export function setupSidebar() {
  const layout = document.querySelector(".layout");
  $("toggle-sidebar").addEventListener("click", () => {
    layout.classList.toggle("collapsed");
    saveSettings();
  });
  $("pin-toggle").addEventListener("click", togglePin);
}

// 置顶：alwaysOnTop + 跨桌面可见（切换桌面仍在最上层）
async function togglePin() {
  const next = !pinned;
  const w = getCurrentWindow();
  try {
    await w.setAlwaysOnTop(next);
    try {
      await w.setVisibleOnAllWorkspaces(next);
    } catch {
      /* 非 macOS 可忽略 */
    }
    setPinned(next);
    $("pin-toggle").classList.toggle("active", pinned);
    setStatus(pinned ? "已置顶" : "已取消置顶", "ok");
    saveSettings();
  } catch (e) {
    setStatus(`置顶失败：${e}`, "err");
  }
}
