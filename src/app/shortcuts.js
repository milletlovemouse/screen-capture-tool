import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { IS_MAC, shortcutText } from "../shared/platform";
import { $, setStatus } from "../core/dom.js";
import { saveSettings } from "../core/settings.js";
import { doCapture } from "./capture.js";
import { toggleRecording } from "./recording.js";
import { openRegionPicker, useFullscreenRegion, toggleIndicator } from "./region.js";
import { handleKeysRecordingKeydown } from "./automation/steps.js";
import { handleAutomationShortcutKeydown } from "./automation/shortcuts.js";
import {
  automationShortcutRecording,
  keysRecording,
  prevShortcut,
  recordingKey,
  setPrevShortcut,
  setRecordingKey,
} from "../core/state.js";

// 两个全局快捷键：截图、录屏开始/结束。active 记录已注册值，便于更新时先注销
export const SHORTCUTS = {
  capture: {
    input: "shortcut",
    btn: "record-shortcut",
    active: null,
    action: () => doCapture(),
  },
  record: {
    input: "shortcut-record",
    btn: "record-shortcut-rec",
    active: null,
    action: () => toggleRecording(),
  },
  region: {
    input: "shortcut-region", btn: "record-shortcut-region", active: null,
    button: "pick-region", action: () => openRegionPicker(),
  },
  fullscreen: {
    input: "shortcut-fullscreen", btn: "record-shortcut-fullscreen", active: null,
    button: "use-fullscreen", action: () => useFullscreenRegion(),
  },
  indicator: {
    input: "shortcut-indicator", btn: "record-shortcut-indicator", active: null,
    button: "toggle-indicator", action: () => toggleIndicator(),
  },
};

// 选区快捷键复用设置页的录制、冲突保护和注册流程。
export async function registerRegionShortcuts() {
  for (const key of ["region", "fullscreen", "indicator"]) await registerShortcut(key);
}

// 将配置的组合键转为 macOS 常用符号，保留原始值供悬停查看。
export function showHomeShortcut(element, shortcut, label = "快捷键") {
  if (!element) return;
  const value = (shortcut || "").trim();
  const display = shortcutText(value);
  element.textContent = display;
  element.hidden = !value;
  element.title = value ? `${label}：${value}` : "";
}

// 首页展示已配置值，录制中的临时提示不作为快捷键显示。
export function updateHomeShortcuts() {
  for (const [key, cfg] of Object.entries(SHORTCUTS)) {
    const value = recordingKey === key ? prevShortcut : $(cfg.input).value;
    if (cfg.button) {
      const button = $(cfg.button);
      if (button) button.title = `快捷键：${shortcutText(cfg.active || value)}`;
      showHomeShortcut($(`home-${key}-shortcut`), cfg.active || value);
      continue;
    }
    showHomeShortcut($(`home-${key}-shortcut`), value, key === "record" ? "开始 / 停止" : "快捷键");
  }
}

// 注册某个全局快捷键（key: capture / record）
export async function registerShortcut(key) {
  const cfg = SHORTCUTS[key];
  const accel = $(cfg.input).value.trim();
  if (!accel) {
    setStatus("请输入快捷键", "err");
    return;
  }
  const previous = cfg.active;
  try {
    if (previous === accel && (await isRegistered(accel))) {
      setStatus(`快捷键已注册：${accel}`, "ok");
      return;
    }
    let pressed = false;
    await register(accel, (event) => {
      if (event.state === "Released") { pressed = false; return; }
      if (event.state !== "Pressed" || pressed) return;
      pressed = true;
      if (!recordingKey && !automationShortcutRecording && !keysRecording) {
        void Promise.resolve().then(cfg.action).catch((error) => setStatus(`操作失败：${error}`, "err"));
      }
    });
    try {
      if (previous && previous !== accel && (await isRegistered(previous))) {
        await unregister(previous);
      }
    } catch (error) {
      await unregister(accel);
      throw error;
    }
    cfg.active = accel;
    updateHomeShortcuts();
    saveSettings();
    setStatus(`快捷键已注册：${accel}`, "ok");
  } catch (e) {
    if (cfg.button && previous) {
      $(cfg.input).value = previous;
      updateHomeShortcuts();
      saveSettings();
    }
    setStatus(`快捷键注册失败：${e}`, "err");
  }
}

// ---- 快捷键录制：直接按组合键捕获，而非手动输入 ----

// 把键盘事件转换为 Tauri 加速键字符串（如 CommandOrControl+Shift+S）
export function normalizeKey(e) {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const code = e.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  const map = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    " ": "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: null,
  };
  if (e.key in map) return map[e.key];
  if (e.key.length === 1) return e.key.toUpperCase();
  return null;
}

export function buildAccelerator(e) {
  const mods = [];
  if (e.metaKey) mods.push(IS_MAC ? "CommandOrControl" : "Super");
  if (e.ctrlKey) mods.push(IS_MAC ? "Control" : "CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = normalizeKey(e);
  return { mods, key, accel: key ? [...mods, key].join("+") : null };
}

export function startRecording(key) {
  if (recordingKey || keysRecording || automationShortcutRecording) return;
  setRecordingKey(key);
  const cfg = SHORTCUTS[key];
  setPrevShortcut($(cfg.input).value);
  $(cfg.input).value = "按下组合键…";
  $(cfg.btn).classList.add("recording");
  setStatus("请按下想要的组合键，Esc 取消", "");
  // 保留旧注册，通过回调门禁防止误触发；取消或新键冲突时旧键仍可用。
}

export function stopRecording(restore) {
  if (!recordingKey) return;
  const cfg = SHORTCUTS[recordingKey];
  $(cfg.btn).classList.remove("recording");
  if (restore) $(cfg.input).value = prevShortcut;
  setRecordingKey(null);
  updateHomeShortcuts();
}

export function onRecordKeydown(e) {
  if (keysRecording && handleKeysRecordingKeydown(e)) return;
  if (automationShortcutRecording && handleAutomationShortcutKeydown(e)) return;
  if (!recordingKey) return;
  e.preventDefault();
  const cfg = SHORTCUTS[recordingKey];
  if (e.key === "Escape") {
    e.stopImmediatePropagation();
    stopRecording(true);
    setStatus("已取消录制", "");
    return;
  }
  const { mods, accel } = buildAccelerator(e);
  if (!accel) {
    // 仅按下修饰键，先展示预览等待主键
    $(cfg.input).value = mods.length ? mods.join("+") + "+…" : "按下组合键…";
    return;
  }
  $(cfg.input).value = accel;
  const key = recordingKey;
  stopRecording(false);
  if (!cfg.button) saveSettings();
  // 录制完成后自动注册
  registerShortcut(key);
}
