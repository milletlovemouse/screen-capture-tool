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
  clearRegion,
  ensureIndicator,
  openRegionPicker,
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
import { setupAbout } from "./app/updater.js";
import { setupNav, setupSidebar } from "./app/navigation.js";
import { setupAutoHideScrollbars } from "./app/scrollbars.js";
import { setupWindowClose } from "./app/window-close.js";
import { handleDesktopMenuAction, setAutomationMenuAction, setupTray } from "./app/tray.js";
import { toggleAutomation } from "./app/automation/runner.js";
import { setupAutomation } from "./app/automation/editor.js";
import { renderAutomationSteps } from "./app/automation/steps.js";
import { registerAutomationScriptShortcuts } from "./app/automation/shortcuts.js";
import {
  automationScripts,
  automationRuns,
  automationShortcutRecording,
  keysRecording,
  pinned,
  pointPickingStep,
  recordingActive,
  recordingKey,
  setPointPickingStep,
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

  // 已选区域后按 Esc 清空选区（录制快捷键/按键录制时的 Esc 不走这里）
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !automationRuns.size && !recordingKey && !keysRecording && !automationShortcutRecording) {
      void clearRegion().catch(console.error);
    }
  });

  $("use-fullscreen").addEventListener("click", useFullscreenRegion);

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
    ensureIndicator();
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

  // 接收 macOS 原生状态栏菜单操作。
  if (IS_MAC) {
    await getCurrentWindow().listen("desktop-menu-action", (event) => {
      void handleDesktopMenuAction(event.payload);
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

  // 仅未录屏时恢复常驻选区。
  if (!recordingActive) await ensureIndicator();

  // 启动时自动注册已保存的快捷键
  await registerStartupShortcuts();

  // 启动时检查权限，缺失则提醒去设置页授权
  await refreshPermissions();
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
