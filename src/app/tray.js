import { exit, defaultWindowIcon } from "@tauri-apps/api/app";
import { IconMenuItem, Menu, MenuItem, NativeIcon } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Image as TauriImage } from "@tauri-apps/api/image";
import trayIconUrl from "../../tray-icon.svg?url";
import { setStatus } from "../core/dom.js";
import {
  automationScripts,
  automationRuns,
  indicatorEnabled,
  recordingActive,
  recordingBusy,
} from "../core/state.js";
import { IS_MAC } from "../shared/platform.js";
import { doCapture } from "./capture.js";
import { setDesktopMenuRefresh } from "./desktop-menu-state.js";
import { toggleRecording } from "./recording.js";
import { getIndicator, openRegionPicker, toggleIndicator } from "./region.js";

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

async function desktopMenuState() {
  let indicatorVisible = false;
  try {
    const indicator = await getIndicator();
    indicatorVisible = Boolean(indicator && await indicator.isVisible());
  } catch {
    /* 窗口正在销毁时按隐藏状态刷新。 */
  }
  return {
    items: desktopAutomationItems(),
    recordingActive,
    recordingBusy,
    indicatorVisible: indicatorEnabled,
  };
}

function desktopMenuItem(id, text, icon, options = {}) {
  const { action, ...itemOptions } = options;
  return {
    id,
    text,
    ...(IS_MAC ? { icon } : {}),
    ...itemOptions,
    ...(!IS_MAC && action ? { action } : {}),
  };
}

// 构造托盘菜单，脚本操作始终按稳定 ID 分发。
async function createDesktopTrayMenu({
  items,
  recordingActive: isRecording,
  recordingBusy: isRecordingBusy,
  indicatorVisible,
}) {
  const menuItems = [];
  const menuItem = async (...args) => {
    const options = desktopMenuItem(...args);
    const item = await (IS_MAC ? IconMenuItem : MenuItem).new(options);
    menuItems.push(item);
    return item;
  };
  const recordingText = isRecordingBusy
    ? isRecording ? "正在停止录屏" : "正在开始录屏"
    : isRecording ? "停止录屏" : "开始录屏";
  const recordingIcon = isRecordingBusy
    ? NativeIcon.StatusPartiallyAvailable
    : isRecording ? NativeIcon.StopProgress : NativeIcon.StatusAvailable;
  try {
    const menu = await Menu.new({
      items: [
        ...await Promise.all([
        ["capture", "立即截图", NativeIcon.QuickLook],
        ["pick", "框选区域", NativeIcon.EnterFullScreen],
        [
          "record",
          recordingText,
          recordingIcon,
        ],
        [
          "toggle",
          indicatorVisible ? "隐藏选区" : "显示选区",
          indicatorVisible ? NativeIcon.Remove : NativeIcon.RevealFreestanding,
        ],
        ].map(([id, text, icon]) => menuItem(
        id,
        text,
        icon,
        {
          enabled: id !== "record" || !isRecordingBusy,
          action: () => handleDesktopMenuAction(id),
        }
        ))),
        ...(items.length ? [
          { item: "Separator" },
          ...await Promise.all(items.map(({ id, name, running, stopping }) => menuItem(
          `automation:${id}`,
          name,
          stopping
            ? NativeIcon.StatusPartiallyAvailable
            : running ? NativeIcon.StopProgress : NativeIcon.StatusAvailable,
          {
            enabled: !stopping,
            action: () => handleDesktopMenuAction(`automation:${id}`),
          }
          ))),
          { item: "Separator" },
        ] : []),
        await menuItem(
          "settings",
          "设置",
          NativeIcon.PreferencesGeneral,
          { action: () => handleDesktopMenuAction("settings") }
        ),
        { item: "Separator" },
        await menuItem(
          "quit",
          "退出",
          NativeIcon.StopProgress,
          { action: () => handleDesktopMenuAction("quit") }
        ),
      ],
    });
    return { menu, menuItems };
  } catch (error) {
    await Promise.allSettled(menuItems.map((item) => item.close()));
    throw error;
  }
}

async function closeDesktopTrayMenu(bundle) {
  if (!bundle) return;
  await bundle.menu.close();
  await Promise.allSettled(bundle.menuItems.map((item) => item.close()));
}

// 串行刷新原生菜单，防止较早的异步更新覆盖最新状态。
export function refreshAutomationDesktopMenus() {
  if (!desktopTray) return Promise.resolve();
  desktopMenuQueue = desktopMenuQueue.then(async () => {
    const state = await desktopMenuState();
    const snapshot = JSON.stringify(state);
    if (snapshot === desktopMenuSnapshot) return;
    const bundle = await createDesktopTrayMenu(state);
    try {
      await desktopTray.setMenu(bundle.menu);
    } catch (error) {
      await closeDesktopTrayMenu(bundle);
      throw error;
    }
    const previous = desktopTrayMenu;
    desktopTrayMenu = bundle;
    if (previous) await closeDesktopTrayMenu(previous);
    if (IS_MAC) {
      await invoke("update_tray_menu", {
        items: state.items,
        recordingActive: state.recordingActive,
        recordingBusy: state.recordingBusy,
        indicatorVisible: state.indicatorVisible,
      });
    }
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
        document.querySelector('.nav-item[data-view="settings"]')?.click?.();
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
      id: "main",
      icon,
      iconAsTemplate: IS_MAC,
      tooltip: "截图工具",
      showMenuOnLeftClick: false, // 右键显示菜单
    });
  } finally {
    if (IS_MAC) await icon.close();
  }
  setDesktopMenuRefresh(refreshAutomationDesktopMenus);
  await refreshAutomationDesktopMenus();
}
