import { exit, defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Image as TauriImage } from "@tauri-apps/api/image";
import trayIconUrl from "../../tray-icon.svg?url";
import { setStatus } from "../core/dom.js";
import { automationScripts, automationRuns } from "../core/state.js";
import { IS_MAC } from "../shared/platform.js";
import { doCapture } from "./capture.js";
import { toggleRecording } from "./recording.js";
import { openRegionPicker, toggleIndicator } from "./region.js";

let desktopTray = null;
let desktopTrayMenu = null;
let automationMenuAction = null;
let desktopMenuQueue = Promise.resolve();
let desktopMenuSnapshot = null;

// 注入已有脚本启停入口，避免菜单与执行器互相依赖。
export function setAutomationMenuAction(handler) {
  automationMenuAction = handler;
}

// 同一份脚本状态同时用于托盘和 Dock，运行数据不另行保存。
function desktopAutomationItems() {
  return automationScripts.map((script) => {
    const run = automationRuns.get(script.id);
    return {
      id: script.id,
      name: script.name || "未命名脚本",
      running: Boolean(run),
      stopping: Boolean(run?.cancelled),
    };
  });
}

// 构造托盘菜单，脚本操作始终按稳定 ID 分发。
async function createDesktopTrayMenu(items) {
  return Menu.new({
    items: [
      ...[
        ["capture", "立即截图"],
        ["pick", "框选区域"],
        ["record", "开始/停止录屏"],
        ["toggle", "显示/隐藏选区框"],
      ].map(([id, text]) => ({ id, text, action: () => handleDesktopMenuAction(id) })),
      ...(items.length ? [
        { item: "Separator" },
        ...items.map(({ id, name, running, stopping }) => ({
          id: `automation:${id}`,
          text: `${stopping ? "正在停止" : running ? "停止" : "启动"}：${name}`,
          enabled: !stopping,
          action: () => handleDesktopMenuAction(`automation:${id}`),
        })),
        { item: "Separator" },
      ] : []),
      { id: "settings", text: "打开设置窗口", action: () => handleDesktopMenuAction("settings") },
      { item: "Separator" },
      { id: "quit", text: "退出", action: () => handleDesktopMenuAction("quit") },
    ],
  });
}

// 串行刷新原生菜单，防止较早的异步更新覆盖最新状态。
export function refreshAutomationDesktopMenus() {
  if (!desktopTray) return Promise.resolve();
  desktopMenuQueue = desktopMenuQueue.then(async () => {
    const items = desktopAutomationItems();
    const snapshot = JSON.stringify(items);
    if (snapshot === desktopMenuSnapshot) return;
    const menu = await createDesktopTrayMenu(items);
    try {
      await desktopTray.setMenu(menu);
    } catch (error) {
      await menu.close();
      throw error;
    }
    const previous = desktopTrayMenu;
    desktopTrayMenu = menu;
    if (previous) await previous.close();
    if (IS_MAC) await invoke("update_dock_automation_menu", { items });
    desktopMenuSnapshot = snapshot;
  }).catch((error) => {
    setStatus(`菜单更新失败：${error}`, "err");
  });
  return desktopMenuQueue;
}

// 托盘和 Dock 共用操作入口，保持快捷操作的行为一致。
export async function handleDesktopMenuAction(action) {
  try {
    if (typeof action === "string" && action.startsWith("automation:")) {
      const id = action.slice("automation:".length);
      if (automationRuns.get(id)?.cancelled) return;
      await automationMenuAction?.(id);
      return;
    }
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

// 将透明矢量图渲染为 Retina 位图，交由 macOS 按模板图标着色。
async function createMacTrayIcon() {
  const image = new window.Image();
  image.src = trayIconUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 36;
  canvas.height = 36;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建状态栏图标画布");
  context.drawImage(image, 0, 0, 36, 36);
  const rgba = context.getImageData(0, 0, 36, 36).data;
  return TauriImage.new(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), 36, 36);
}

// 创建菜单栏托盘图标与右键菜单。
export async function setupTray() {
  const icon = IS_MAC ? await createMacTrayIcon() : await defaultWindowIcon();
  try {
    desktopTray = await TrayIcon.new({
      icon,
      iconAsTemplate: IS_MAC,
      tooltip: "截图工具",
      showMenuOnLeftClick: false, // 右键显示菜单
    });
  } finally {
    if (IS_MAC) await icon.close();
  }
  await refreshAutomationDesktopMenus();
}
