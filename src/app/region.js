import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, setStatus } from "../core/dom.js";
import { saveSettings } from "../core/settings.js";
import {
  registerRegionEscape,
  releaseRegionEscape,
  waitRegionEscapeAction,
} from "./automation/safety.js";
import { withCaptureOverlayLock, captureOverlaysBlocked, forgetCaptureOverlay, waitCaptureWindowCreated } from "./capture-overlays.js";
import { requestDesktopMenuRefresh } from "./desktop-menu-state.js";
import { indicatorEnabled, recordingKey, setIndicatorEnabled } from "../core/state.js";

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

// 按钮和全局快捷键共用全屏选区操作。
export async function useFullscreenRegion({ restoreFocus = false } = {}) {
  try {
    await waitRegionEscapeAction();
    const [width, height] = await invoke("primary_size");
    $("x").value = 0;
    $("y").value = 0;
    $("w").value = width;
    $("h").value = height;
    saveSettings();
    broadcastRegion();
    await restoreEnabledIndicator();
    if (restoreFocus) await getCurrentWindow().setFocus();
    setStatus(`已设置为全屏区域 ${width}x${height}`, "ok");
  } catch (error) {
    setStatus(`获取屏幕尺寸失败：${error}`, "err");
  }
}

// 打开全屏透明覆盖窗进行拖拽框选
export async function openRegionPicker() {
  return withCaptureOverlayLock(openRegionPickerLocked)
    .catch((error) => setStatus(`无法打开框选窗口：${error}`, "err"));
}

// 捕获锁内创建窗口，重复请求不替换正在使用的选区窗口。
async function openRegionPickerLocked() {
  if (captureOverlaysBlocked()) return;
  if (await WebviewWindow.getByLabel("point-picker")) return;
  const existing = await WebviewWindow.getByLabel("overlay");
  if (existing) return;
  const mainWin = getCurrentWindow();
  const indicator = await getIndicator();
  const indicatorWasVisible = indicator ? await indicator.isVisible() : false;
  if (indicatorWasVisible) {
    await indicator.hide();
  }
  // 记录主窗口当前是否可见：从主窗口发起则框选后恢复，从托盘发起（后台）则保持隐藏
  const wasVisible = await mainWin.isVisible();
  if (wasVisible) {
    await mainWin.hide();
  }

  // 取主屏逻辑尺寸作为创建兜底；Windows 创建后进入原生全屏，macOS 保持普通覆盖窗。
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
    visible: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    shadow: false,
    dragDropEnabled: false,
    width: sw,
    height: sh,
    title: "框选区域",
  });
  overlay.once("tauri://error", async (e) => {
    if (indicatorWasVisible) {
      await indicator.show();
      await invoke("raise_capture_auxiliary_window", { label: "indicator" });
    }
    if (wasVisible) await mainWin.show();
    setStatus(`无法打开框选窗口：${e.payload}`, "err");
  });
  // 覆盖窗关闭后（无论完成选择还是取消）按需恢复主窗口
  overlay.once("tauri://destroyed", async () => {
    if (wasVisible) {
      await mainWin.show();
      await mainWin.setFocus();
    }
    // Esc 取消时没有 region-selected 事件，由这里恢复原本可见的常驻选区。
    if (indicatorWasVisible) {
      await indicator.show();
      await invoke("raise_capture_auxiliary_window", { label: "indicator" });
      await registerRegionEscape();
    } else {
      await releaseRegionEscape();
    }
  });
  try {
    await waitCaptureWindowCreated(overlay);
    await registerRegionEscape();
    await invoke("raise_capture_auxiliary_window", { label: "overlay" });
  } catch (error) {
    if (indicatorWasVisible) {
      await indicator.show();
      await invoke("raise_capture_auxiliary_window", { label: "indicator" });
      await registerRegionEscape();
    } else {
      await releaseRegionEscape();
    }
    if (wasVisible) await mainWin.show();
    throw error;
  }
}

// 创建常驻选区窗口，边框附近可调整，内部点击穿透。
export async function createIndicator() {
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
    shadow: false,
    width: width || 800,
    height: height || 600,
    title: "选区",
  });
  win.once("tauri://error", (e) => {
    setStatus(`无法打开选区：${e.payload}`, "err");
  });
  await waitCaptureWindowCreated(win);
  await invoke("raise_capture_auxiliary_window", { label: "indicator" });
  return win;
}

// 确保选区已显示（默认启动时调用）
export async function ensureIndicator() {
  const region = regionPayload();
  if (region.width > 0 && region.height > 0) await registerRegionEscape();
  const result = await withCaptureOverlayLock(async () => {
    if (captureOverlaysBlocked()) return;
    const win = await getIndicator();
    if (win) {
      await win.show();
      await invoke("raise_capture_auxiliary_window", { label: "indicator" });
      broadcastRegion();
    } else {
      await createIndicator();
    }
  });
  void requestDesktopMenuRefresh();
  return result;
}

// 区域变化后仅按用户既有显示意图恢复，不会自行开启显示选区。
export function restoreEnabledIndicator() {
  return withCaptureOverlayLock(restoreEnabledIndicatorLocked);
}

// 在捕获锁内恢复显示，避免和截图、录屏或框选窗口并发。
async function restoreEnabledIndicatorLocked() {
  if (!indicatorEnabled) return;
  if (captureOverlaysBlocked()) return;
  const win = await getIndicator();
  if (win) {
    await win.show();
    await invoke("raise_capture_auxiliary_window", { label: "indicator" });
    broadcastRegion();
    await registerRegionEscape();
    return;
  }
  await createIndicator();
  await registerRegionEscape();
  void requestDesktopMenuRefresh();
}

// 清空当前预设选区：重置坐标并隐藏选区
export async function clearRegion() {
  if (recordingKey) return;
  ["x", "y", "w", "h"].forEach((id) => ($(id).value = 0));
  saveSettings();
  await withCaptureOverlayLock(async () => {
    forgetCaptureOverlay("indicator");
    const ind = await getIndicator();
    if (ind) await ind.hide();
  });
  await releaseRegionEscape();
  void requestDesktopMenuRefresh();
  setStatus("已清空选区", "ok");
}

// 显示/隐藏常驻选区
export async function toggleIndicator() {
  const result = await withCaptureOverlayLock(toggleIndicatorLocked);
  void requestDesktopMenuRefresh();
  return result;
}

// 与捕获的隐藏/恢复串行化，不在录制期间重新显示边框。
async function toggleIndicatorLocked() {
  if (captureOverlaysBlocked()) {
    setStatus("录屏期间选区保持隐藏，结束后恢复", "");
    return;
  }
  const win = await getIndicator();
  const mainWindow = getCurrentWindow();
  const restoreMainFocus = await mainWindow.isVisible();
  if (indicatorEnabled) {
    setIndicatorEnabled(false);
    if (win && await win.isVisible()) {
      await win.hide();
    }
    await releaseRegionEscape();
    setStatus("已隐藏选区", "ok");
    return;
  }

  setIndicatorEnabled(true);
  if (win) {
    if (!(await win.isVisible())) {
      await win.show();
    }
    await invoke("raise_capture_auxiliary_window", { label: "indicator" });
    broadcastRegion();
  } else {
    await createIndicator();
  }
  await registerRegionEscape();
  if (restoreMainFocus) await mainWindow.setFocus();
  setStatus("已显示选区", "ok");
}
