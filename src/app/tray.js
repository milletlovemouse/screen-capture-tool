import { exit, defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setStatus } from "../core/dom.js";
import { doCapture } from "./capture.js";
import { toggleRecording } from "./recording.js";
import { openRegionPicker, toggleIndicator } from "./region.js";

// 托盘和 Dock 共用操作入口，保持快捷操作的行为一致。
export async function handleDesktopMenuAction(action) {
  try {
    switch (action) {
      case "capture": await doCapture(); break;
      case "pick": await openRegionPicker(); break;
      case "record": await toggleRecording(); break;
      case "toggle": await toggleIndicator(); break;
      case "settings": {
        const w = getCurrentWindow();
        await w.show();
        await w.unminimize();
        await w.setFocus();
        break;
      }
      case "quit": await exit(0); break;
    }
  } catch (error) {
    setStatus(`菜单操作失败：${error}`, "err");
  }
}

// 创建菜单栏托盘图标与右键菜单。
export async function setupTray() {
  const sep = await PredefinedMenuItem.new({ item: "Separator" });
  const menu = await Menu.new({
    items: [
      { id: "capture", text: "立即截图", action: () => handleDesktopMenuAction("capture") },
      { id: "pick", text: "框选区域", action: () => handleDesktopMenuAction("pick") },
      { id: "record", text: "开始/停止录屏", action: () => handleDesktopMenuAction("record") },
      { id: "toggle", text: "显示/隐藏选区框", action: () => handleDesktopMenuAction("toggle") },
      {
        id: "settings",
        text: "打开设置窗口",
        action: () => handleDesktopMenuAction("settings"),
      },
      sep,
      { id: "quit", text: "退出", action: () => handleDesktopMenuAction("quit") },
    ],
  });
  await TrayIcon.new({
    icon: await defaultWindowIcon(),
    tooltip: "截图工具",
    menu,
    showMenuOnLeftClick: false, // 右键显示菜单
  });
}
