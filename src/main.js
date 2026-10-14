import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { IS_MAC } from "./shared/platform";
import { $, setStatus } from "./core/dom.js";
import { loadSettings, saveSettings } from "./core/settings.js";
import { doCapture } from "./app/capture.js";
import { toggleRecording, updateRecUI } from "./app/recording.js";
import {
  broadcastRegion,
  clearRegion,
  ensureIndicator,
  openRegionPicker,
  toggleIndicator,
} from "./app/region.js";
import {
  SHORTCUTS,
  onRecordKeydown,
  registerShortcut,
  startRecording,
  stopRecording,
  updateHomeShortcuts,
} from "./app/shortcuts.js";
import { refreshPermissions, setupPermissions } from "./app/permissions.js";
import { setupAbout } from "./app/updater.js";
import { setupNav, setupSidebar } from "./app/navigation.js";
import { handleDesktopMenuAction, setupTray } from "./app/tray.js";
import { setupAutomation } from "./app/automation/editor.js";
import { renderAutomationSteps } from "./app/automation/steps.js";
import { registerAutomationScriptShortcuts } from "./app/automation/shortcuts.js";
import {
  automationScripts,
  automationShortcutRecording,
  keysRecording,
  pinned,
  pointPickingStep,
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
  ["capture", "record"].forEach((key) => {
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
    if (e.key === "Escape" && !recordingKey && !keysRecording && !automationShortcutRecording) {
      clearRegion();
    }
  });

  $("use-fullscreen").addEventListener("click", async () => {
    try {
      const [w, h] = await invoke("primary_size");
      $("x").value = 0;
      $("y").value = 0;
      $("w").value = w;
      $("h").value = h;
      saveSettings();
      broadcastRegion();
      setStatus(`已设置为全屏区域 ${w}x${h}`, "ok");
    } catch (e) {
      setStatus(`获取屏幕尺寸失败：${e}`, "err");
    }
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

  // 关闭主窗口时不退出，仅隐藏到菜单栏后台运行
  getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    await getCurrentWindow().hide();
  });
}

async function init() {
  loadSettings();
  if (!IS_MAC) {
    const screenInfo = document.querySelector('.permission-row[data-perm="screen"] .permission-desc');
    const inputInfo = document.querySelector('.permission-row[data-perm="accessibility"] .permission-desc');
    if (screenInfo) screenInfo.textContent = "截图与录屏使用 Windows 系统捕获；受保护的画面可能无法捕获";
    if (inputInfo) inputInfo.textContent = "模拟输入可操作同等权限的窗口，管理员窗口需要相同权限";
  }
  updateHomeShortcuts();
  bindEvents();
  setupNav();
  setupAbout();
  setupSidebar();
  setupAutomation();
  setupPermissions();

  // 恢复置顶状态
  if (pinned) {
    $("pin-toggle").classList.add("active");
    const w = getCurrentWindow();
    try {
      await w.setAlwaysOnTop(true);
      try {
        await w.setVisibleOnAllWorkspaces(true);
      } catch {
        /* 非 macOS 可忽略 */
      }
    } catch {
      /* 忽略 */
    }
  }

  // 保留 Dock 图标，并接收原生右键菜单的操作。
  if (IS_MAC) {
    await getCurrentWindow().listen("desktop-menu-action", (event) => {
      void handleDesktopMenuAction(event.payload);
    });
  }
  await setupTray();

  // 默认显示常驻选区框
  await ensureIndicator();

  // 同步录屏状态（防止上次未正常结束）
  try {
    setRecordingActive(await invoke("is_recording"));
    updateRecUI();
  } catch {
    /* 忽略 */
  }

  // 启动时自动注册已保存的快捷键
  if ($("shortcut").value.trim()) registerShortcut("capture");
  if ($("shortcut-record").value.trim()) registerShortcut("record");
  automationScripts.forEach((script) => registerAutomationScriptShortcuts(script));

  // 启动时检查权限，缺失则提醒去设置页授权
  await refreshPermissions();
}

init();
