import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, setStatus } from "../core/dom.js";
import { saveSettings } from "../core/settings.js";
import {
  automationRecordingRun,
  recordingActive,
  recordingBusy,
  recordingKey,
} from "../core/state.js";

// 当前预设区域（逻辑坐标）
export function regionPayload() {
  return {
    x: Math.max(0, parseInt($("x").value, 10) || 0),
    y: Math.max(0, parseInt($("y").value, 10) || 0),
    width: Math.max(0, parseInt($("w").value, 10) || 0),
    height: Math.max(0, parseInt($("h").value, 10) || 0),
  };
}

// 把当前区域广播给常驻指示窗，使其边框实时跟随
export function broadcastRegion() {
  emit("region-geometry", regionPayload());
}

export function getIndicator() {
  return WebviewWindow.getByLabel("indicator");
}

// 打开全屏透明覆盖窗进行拖拽框选
export async function openRegionPicker() {
  const existing = await WebviewWindow.getByLabel("overlay");
  if (existing) {
    await existing.close();
  }
  const mainWin = getCurrentWindow();
  // 记录主窗口当前是否可见：从主窗口发起则框选后恢复，从托盘发起（后台）则保持隐藏
  const wasVisible = await mainWin.isVisible();
  if (wasVisible) {
    await mainWin.hide();
  }

  // 取主屏逻辑尺寸，用普通窗口覆盖全屏（不走原生全屏，避免独占一个桌面空间）
  let sw = 1440;
  let sh = 900;
  try {
    [sw, sh] = await invoke("primary_size");
  } catch {
    /* 取不到时用兜底尺寸 */
  }

  const overlay = new WebviewWindow("overlay", {
    x: 0,
    y: 0,
    url: "overlay.html",
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    width: sw,
    height: sh,
    title: "框选区域",
  });
  overlay.once("tauri://error", async (e) => {
    if (wasVisible) await mainWin.show();
    setStatus(`无法打开框选窗口：${e.payload}`, "err");
  });
  // 覆盖窗关闭后（无论完成选择还是取消）按需恢复主窗口
  overlay.once("tauri://destroyed", async () => {
    if (wasVisible) {
      await mainWin.show();
      await mainWin.setFocus();
    }
  });
}

// 创建常驻选区框窗口，边框附近可调整，内部点击穿透。
export function createIndicator() {
  const { width, height } = regionPayload();
  const win = new WebviewWindow("indicator", {
    x: 0,
    y: 0,
    url: "indicator.html",
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
    acceptFirstMouse: true,
    width: width || 800,
    height: height || 600,
    title: "选区",
  });
  win.once("tauri://error", (e) => {
    setStatus(`无法打开选区框：${e.payload}`, "err");
  });
  return win;
}

// 确保选区框已显示（默认启动时调用）
export async function ensureIndicator() {
  if (recordingActive || recordingBusy || automationRecordingRun) return;
  const win = await getIndicator();
  if (win) {
    await win.show();
    broadcastRegion();
  } else {
    createIndicator();
  }
}

// 清空当前预设选区：重置坐标并隐藏选区框
export async function clearRegion() {
  if (recordingKey) return;
  ["x", "y", "w", "h"].forEach((id) => ($(id).value = 0));
  saveSettings();
  const ind = await getIndicator();
  if (ind) await ind.hide();
  setStatus("已清空选区", "ok");
}

// 显示/隐藏常驻选区框
export async function toggleIndicator() {
  if (recordingActive || recordingBusy || automationRecordingRun) {
    setStatus("录屏期间选区框保持隐藏，结束后恢复", "");
    return;
  }
  const win = await getIndicator();
  if (win) {
    if (await win.isVisible()) {
      await win.hide();
      setStatus("已隐藏选区框", "ok");
    } else {
      await win.show();
      broadcastRegion();
      setStatus("已显示选区框", "ok");
    }
    return;
  }
  createIndicator();
}
