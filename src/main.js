import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { IS_MAC } from "./shared/platform";
import { $, setStatus } from "./core/dom.js";
import { loadSettings, saveSettings } from "./core/settings.js";
import { doCapture } from "./app/capture.js";
import {
  hideIndicatorForRecording,
  startRecordingMonitor,
  toggleRecording,
  updateRecUI,
} from "./app/recording.js";
import {
  broadcastRegion,
  ensureIndicator,
  openRegionPicker,
  restoreEnabledIndicator,
  toggleIndicator,
  useFullscreenRegion,
} from "./app/region.js";
import {
  SHORTCUTS,
  onRecordKeydown,
  registerShortcut,
  registerRegionShortcuts,
  startRecording,
  stopRecording,
  updateHomeShortcuts,
} from "./app/shortcuts.js";
import { refreshPermissions, setupPermissions } from "./app/permissions.js";
import { checkForUpdatesFromMenu, setupAbout } from "./app/updater.js";
import { setupNav, setupSidebar } from "./app/navigation.js";
import { setupAutoHideScrollbars } from "./app/scrollbars.js";
import { setupWindowClose } from "./app/window-close.js";
import { setupWindowControls } from "./app/window-controls.js";
import { handleDesktopMenuAction, setAutomationMenuAction, setupTray } from "./app/tray.js";
import { toggleAutomation } from "./app/automation/runner.js";
import { setupAutomation } from "./app/automation/editor.js";
import { renderAutomationSteps } from "./app/automation/steps.js";
import { registerAutomationScriptShortcuts } from "./app/automation/shortcuts.js";
import {
  automationScripts,
  indicatorEnabled,
  pinned,
  pointPickingStep,
  recordingActive,
  recordingKey,
  setPointPickingStep,
  setIndicatorEnabled,
  setRecordingActive,
} from "./core/state.js";

function bindEvents() {
  $("pick-region").addEventListener("click", openRegionPicker);
  $("capture-now").addEventListener("click", doCapture);
  $("toggle-indicator").addEventListener("click", toggleIndicator);
  $("record-toggle").addEventListener("click", toggleRecording);

  // 快捷键录制：两个录制按钮分别录制截图/录屏快捷键
  ["capture", "record", "region", "fullscreen", "indicator"].forEach((key) => {
    $(SHORTCUTS[key].btn).addEventListener("click", () => {
      if (recordingKey === key) {
        stopRecording(true);
        setStatus("已取消录制", "");
      } else {
        if (recordingKey) stopRecording(true);
        startRecording(key);
      }
    });
  });
  window.addEventListener("keydown", onRecordKeydown, true);

  $("use-fullscreen").addEventListener("click", () => {
    void useFullscreenRegion({ restoreFocus: true });
  });

  $("pick-dir").addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      $("dir").value = selected;
      saveSettings();
    }
  });

  $("prefix").addEventListener("input", () => {
    saveSettings();
  });
  ["x", "y", "w", "h"].forEach((id) =>
    $(id).addEventListener("input", () => {
      saveSettings();
      broadcastRegion();
    })
  );

  bindWindowEvents();
}

// 监听其他窗口回传的事件，并接管主窗口关闭行为。
function bindWindowEvents() {
  // 接收覆盖窗回传的框选结果
  listen("region-selected", (event) => {
    const { x, y, width, height } = event.payload;
    $("x").value = x;
    $("y").value = y;
    $("w").value = width;
    $("h").value = height;
    saveSettings();
    broadcastRegion();
    if (indicatorEnabled) void restoreEnabledIndicator();
    setStatus(`已选择区域 ${width}x${height} @ (${x}, ${y})`, "ok");
  });

  // 指示窗就绪后下发当前区域
  listen("indicator-ready", () => broadcastRegion());

  // 二次调整沿用预设区域保存流程，不主动显示或聚焦任何窗口。
  listen("region-adjusted", ({ payload }) => {
    const { x, y, width, height } = payload;
    if (![x, y, width, height].every(Number.isInteger) ||
        x < 0 || y < 0 || width < 2 || height < 2) return;
    $("x").value = x;
    $("y").value = y;
    $("w").value = width;
    $("h").value = height;
    saveSettings();
    broadcastRegion();
    setStatus(`选区已调整：${width} × ${height} @ (${x}, ${y})`, "ok");
  });

  // 自动化点击节点通过全屏取点窗记录屏幕坐标
  listen("mouse-position-selected", (event) => {
    if (!pointPickingStep) return;
    const { x, y } = event.payload;
    pointPickingStep.x = x;
    pointPickingStep.y = y;
    setPointPickingStep(null);
    renderAutomationSteps();
    setStatus(`已记录鼠标位置 (${x}, ${y})`, "ok");
  });

}

// 按截图、录屏、脚本的顺序恢复快捷键，单项失败不产生未处理拒绝。
async function registerStartupShortcuts() {
  for (const [key, input] of [["capture", "shortcut"], ["record", "shortcut-record"]]) {
    try {
      if ($(input).value.trim()) await registerShortcut(key);
    } catch (error) {
      setStatus(`快捷键注册失败：${error}`, "err");
    }
  }
  for (const script of [...automationScripts]) {
    try {
      await registerAutomationScriptShortcuts(script, {
        isCurrent: () => automationScripts.includes(script),
      });
    } catch (error) {
      setStatus(`快捷键注册失败：${error}`, "err");
    }
  }
  await registerRegionShortcuts();
}

// 初始化主窗口，恢复录屏状态后才决定是否显示常驻选区。
async function initializeMainWindow() {
  document.documentElement.classList.toggle("platform-macos", IS_MAC);
  document.documentElement.classList.toggle("platform-windows", !IS_MAC);
  loadSettings();
  setAutomationMenuAction(toggleAutomation);
  if (!IS_MAC) {
    const screenInfo = document.querySelector('.permission-row[data-perm="screen"] .permission-desc');
    const inputInfo = document.querySelector('.permission-row[data-perm="accessibility"] .permission-desc');
    if (screenInfo) screenInfo.textContent = "截图与录屏使用 Windows 系统捕获；受保护的画面可能无法捕获";
    if (inputInfo) inputInfo.textContent = "模拟输入可操作同等权限的窗口，管理员窗口需要相同权限";
  }
  updateHomeShortcuts();
  bindEvents();
  setupNav();
  setupAutoHideScrollbars();
  await setupAbout();
  setupSidebar();
  setupWindowClose();
  setupWindowControls();
  setupAutomation();
  setupPermissions();

  // 恢复置顶状态
  if (pinned) {
    $("pin-toggle").classList.add("active");
    const w = getCurrentWindow();
    try {
      await w.setAlwaysOnTop(true);
    } catch {
      /* 忽略 */
    }
  }

  // 托盘菜单由原生菜单事件统一转发，避免平台回调实现差异。
  await getCurrentWindow().listen("desktop-menu-action", (event) => {
    void handleDesktopMenuAction(event.payload);
  });
  if (IS_MAC) {
    await getCurrentWindow().listen("app-menu-action", (event) => {
      void handleAppMenuAction(event.payload);
    });
  }
  await setupTray();

  // 重载时先恢复录屏状态并隐藏覆盖窗，避免常驻选区被拍入录屏。
  try {
    setRecordingActive(await invoke("is_recording"));
    updateRecUI();
    if (recordingActive) {
      await hideIndicatorForRecording();
      startRecordingMonitor();
    }
  } catch {
    /* 忽略 */
  }

  // 首次启动沿用默认显示选区；Esc 只清空区域，不关闭这项显示意图。
  if (!recordingActive) {
    setIndicatorEnabled(true);
    await ensureIndicator();
  }

  // 启动时自动注册已保存的快捷键
  await registerStartupShortcuts();

  // 启动时检查权限，缺失则提醒去设置页授权
  await refreshPermissions();
}

// macOS 左上角应用菜单复用现有页面与业务入口。
async function handleAppMenuAction(action) {
  const mapping = {
    "app.settings": "settings",
  };
  if (mapping[action]) {
    await handleDesktopMenuAction(mapping[action]);
    return;
  }
  if (action === "app.about") {
    const window = getCurrentWindow();
    await window.show();
    document.querySelector('.nav-item[data-view="about"]')?.click?.();
    await window.setFocus();
    return;
  }
  if (action === "app.check-updates") {
    const window = getCurrentWindow();
    await window.show();
    document.querySelector('.nav-item[data-view="about"]')?.click?.();
    await window.setFocus();
    await checkForUpdatesFromMenu();
  }
}

// 保留现有入口名称与调用形式，并统一接住启动失败。
async function init() {
  try {
    await initializeMainWindow();
  } catch (error) {
    setStatus(`初始化失败：${error}`, "err");
  }
}

init();
