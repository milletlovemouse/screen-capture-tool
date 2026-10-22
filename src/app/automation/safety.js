import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  automationActiveShortcuts,
  automationRuns,
  recordingKey,
  keysRecording,
  automationShortcutRecording,
  pointPickingStep,
} from "../../core/state.js";
import { updateAutomationRunUI } from "./model.js";
import { clearRegion } from "../region.js";
import {
  withCaptureOverlayLock,
  captureOverlaysBlocked,
  waitCaptureWindowCreated,
} from "../capture-overlays.js";

const EMERGENCY_SHORTCUT = "Escape";
const DOUBLE_ESCAPE_INTERVAL = 800;
let emergencyShortcutActive = false;
let automationSafetyQueue = Promise.resolve();
let emergencyKeyPressed = false;
let previousEscapeAt = 0;
let regionEscapeActive = false;
let regionEscapeAction = Promise.resolve();

// 连按两次 Esc 时请求取消原生操作，由各执行循环完成资源回收。
function handleEmergencyShortcut(event) {
  if (event.state === "Released") {
    emergencyKeyPressed = false;
    return;
  }
  if (event.state !== "Pressed" || emergencyKeyPressed) return;
  emergencyKeyPressed = true;
  if (!automationRuns.size) {
    if (regionEscapeActive && !recordingKey && !keysRecording && !automationShortcutRecording && !pointPickingStep) {
      regionEscapeAction = cancelRegionFromEscape().catch(console.error);
    }
    return;
  }
  const now = Date.now();
  if (now - previousEscapeAt <= DOUBLE_ESCAPE_INTERVAL) {
    previousEscapeAt = 0;
    for (const [id, run] of automationRuns) {
      // 新运行统一通知后端取消；没有该接口的旧 mock 保留标记取消行为。
      if (run.requestCancel) run.requestCancel?.();
      else run.cancelled = true;
      updateAutomationRunUI(id);
    }
    return;
  }
  previousEscapeAt = now;
}

// 框选中取消框选；显示选区时清空并隐藏选区。
async function cancelRegionFromEscape() {
  const overlay = await WebviewWindow.getByLabel("overlay");
  if (overlay) {
    await overlay.close();
  } else if (regionEscapeActive) {
    await clearRegion();
  }
  emergencyKeyPressed = false;
}

// 准备和释放共用串行队列；失败只返回给调用方，不阻断后续清理或重试。
function withAutomationSafetyQueue(action) {
  const pending = automationSafetyQueue.then(action);
  automationSafetyQueue = pending.catch(() => {});
  return pending;
}

// 仅在安全队列内调用，注册成功后才取得 Esc 所有权。
async function ensureEmergencyShortcut() {
  if (emergencyShortcutActive) return true;
  try {
    await register(EMERGENCY_SHORTCUT, handleEmergencyShortcut);
    emergencyShortcutActive = true;
    return true;
  } catch {
    return false;
  }
}

// 选区和自动化共用 Esc 所有权，不重复注册或注销对方仍在使用的键。
export function registerRegionEscape() {
  return withAutomationSafetyQueue(async () => {
    regionEscapeActive = true;
    emergencyKeyPressed = false;
    return ensureEmergencyShortcut();
  });
}

export async function releaseRegionEscape() {
  await withAutomationSafetyQueue(async () => {
    regionEscapeActive = false;
    emergencyKeyPressed = false;
    if (automationRuns.size || !emergencyShortcutActive) return;
    try {
      if (await isRegistered(EMERGENCY_SHORTCUT)) {
        await unregister(EMERGENCY_SHORTCUT);
      }
      emergencyShortcutActive = false;
    } catch {
      /* 释放失败时保留所有权，后续注册或自动化清理会继续复用。 */
    }
  });
}

// 区域重新显示前等待上一次 Esc 清理完整结束，避免旧隐藏操作覆盖新区域。
export async function waitRegionEscapeAction() {
  await regionEscapeAction;
}

// 只有本脚本成功注册的启停快捷键才能作为备用停止方式。
async function hasRegisteredToggleShortcut(script) {
  return Boolean(
    script.shortcut &&
    automationActiveShortcuts.get(script.id) === script.shortcut &&
    await isRegistered(script.shortcut)
  );
}

// 仅在捕获锁内显示；穿透失败时保持隐藏，不能让提示窗截获用户点击。
async function showAutomationStatusWindow(status) {
  if (!automationRuns.size) return;
  try {
    // 捕获中创建的隐藏窗也先完成穿透，供统一模块之后安全恢复。
    await status.setIgnoreCursorEvents(true);
    // 异步原生调用期间捕获状态可能已改变，显示前再次确认。
    if (!automationRuns.size || captureOverlaysBlocked()) return;
    await status.show();
  } catch (error) {
    // 移除未就绪窗口，避免统一捕获模块稍后将它当作可恢复窗口显示。
    try {
      await status.close();
    } catch {
      await status.hide().catch(() => {});
    }
    throw error;
  }
}

// 创建也持有捕获锁，避免捕获端查窗时遗漏仍在创建中的窗口。
async function showAutomationStatus(emergencyAvailable) {
  return withCaptureOverlayLock(async () => {
    if (!automationRuns.size) return;
    let status = await WebviewWindow.getByLabel("automation-status");
    if (!status) {
      let screenWidth = 1440;
      try {
        [screenWidth] = await invoke("primary_size");
      } catch {
        /* 使用默认宽度定位提示窗 */
      }
      const width = 420;
      const mode = emergencyAvailable ? "escape" : "shortcut";
      status = new WebviewWindow("automation-status", {
        x: Math.max(0, Math.round((screenWidth - width) / 2)),
        y: 16,
        width,
        height: 64,
        url: `automation-status.html?mode=${mode}`,
        visible: false,
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focus: false,
        shadow: false,
        contentProtected: true,
        title: "自动化运行状态",
      });
      await waitCaptureWindowCreated(status);
    }
    // 捕获期间允许创建隐藏窗，恢复由统一捕获模块决定，不自行 acquire/release。
    await showAutomationStatusWindow(status);
  });
}

// 启动前建立至少一种可靠停止方式，并显示不会参与捕获的状态窗。
export async function prepareAutomationSafety(script) {
  return withAutomationSafetyQueue(async () => {
    const emergencyAvailable = await ensureEmergencyShortcut();
    if (!emergencyAvailable && !(await hasRegisteredToggleShortcut(script))) {
      await message(
        "紧急停止快捷键 Esc 注册失败。请先为该自动化设置并成功注册启停快捷键，再开始执行。",
        { title: "无法启动自动化", kind: "warning" }
      );
      return false;
    }
    await showAutomationStatus(emergencyAvailable);
    return true;
  });
}

// 最后一个自动化结束后释放紧急快捷键和提示窗口。
export async function releaseAutomationSafety() {
  return withAutomationSafetyQueue(async () => {
    // 必须在出队后检查，排队期间可能已有新运行加入。
    if (automationRuns.size) return;
    previousEscapeAt = 0;
    emergencyKeyPressed = false;
    if (emergencyShortcutActive && !regionEscapeActive) {
      try {
        if (await isRegistered(EMERGENCY_SHORTCUT)) {
          // 查询期间新增运行时仍保留 Esc；已开始释放的新运行会排队重新注册。
          if (automationRuns.size || regionEscapeActive) return;
          await unregister(EMERGENCY_SHORTCUT);
        }
        emergencyShortcutActive = false;
      } catch {
        /* 查询/释放失败保留所有权，下次清理重试，不能误当成注册失败或外部占用。 */
      }
    }
    try {
      await withCaptureOverlayLock(async () => {
        if (automationRuns.size) return;
        const status = await WebviewWindow.getByLabel("automation-status");
        if (status && !automationRuns.size) await status.close();
      });
    } catch {
      /* 关闭失败不阻塞执行完成；后续清理仍按 label 查找并重试。 */
    }
  });
}
