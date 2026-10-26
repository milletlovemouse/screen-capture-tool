import { $ } from "./dom.js";
import {
  automationScripts,
  pinned,
  setAutomationScripts,
  setPinned,
} from "./state.js";
import { normalizeAutomationScripts } from "../app/automation/model.js";

const STORE_KEY = "sct-settings";
let closeAction = "";
let skippedUpdateVersion = "";
let theme = "system";
let audioSourceId = "system";
let audioEnabled = false;

// 返回下一次录屏是否采集音频，默认关闭。
export function getAudioEnabled() {
  return audioEnabled;
}

// 持久化音频开关，不影响正在录制的任务或已选设备。
export function setAudioEnabled(value) {
  audioEnabled = value === true;
  saveSettings();
}

// 未设置音频来源时默认录制系统输出声音。
export function getAudioSourceId() {
  return audioSourceId;
}

// 保存下一次录屏使用的设备，不切换正在录制的音轨。
export function setAudioSourceId(value) {
  audioSourceId = typeof value === "string" && value.trim() ? value : "system";
  saveSettings();
}

export function getStoredTheme() {
  return theme;
}

// 主题取值由主题模块负责应用，这里仅在加载/持久化时同步。
export function setStoredTheme(value) {
  theme = value === "light" || value === "dark" ? value : "system";
}

export function getCloseAction() {
  return closeAction;
}

export function setCloseAction(value) {
  closeAction = value === "tray" || value === "quit" ? value : "";
  saveSettings();
}

export function getSkippedUpdateVersion() {
  return skippedUpdateVersion;
}

// 记录用户明确跳过的单个版本，后续更高版本仍会正常提示。
export function setSkippedUpdateVersion(value) {
  skippedUpdateVersion = typeof value === "string" ? value : "";
  saveSettings();
}

// 读取本地持久化设置并回填界面
export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (s.x != null) $("x").value = s.x;
    if (s.y != null) $("y").value = s.y;
    if (s.w != null) $("w").value = s.w;
    if (s.h != null) $("h").value = s.h;
    if (s.dir) $("dir").value = s.dir;
    if (s.prefix) $("prefix").value = s.prefix;
    if (s.shortcut) $("shortcut").value = s.shortcut;
    if (s.recordShortcut) $("shortcut-record").value = s.recordShortcut;
    if (s.regionShortcut) $("shortcut-region").value = s.regionShortcut;
    if (s.fullscreenShortcut) $("shortcut-fullscreen").value = s.fullscreenShortcut;
    if (s.indicatorShortcut) $("shortcut-indicator").value = s.indicatorShortcut;
    if (s.collapsed) document.querySelector(".layout").classList.add("collapsed");
    closeAction = s.closeAction === "tray" || s.closeAction === "quit" ? s.closeAction : "";
    skippedUpdateVersion = typeof s.skippedUpdateVersion === "string" ? s.skippedUpdateVersion : "";
    theme = s.theme === "light" || s.theme === "dark" ? s.theme : "system";
    audioSourceId = typeof s.audioSourceId === "string" && s.audioSourceId.trim() ? s.audioSourceId : "system";
    audioEnabled = s.audioEnabled === true;
    setPinned(!!s.pinned);
    setAutomationScripts(normalizeAutomationScripts(s.automations));
  } catch {
    /* 忽略损坏的本地数据 */
  }
}

// 把当前界面状态写回本地存储
export function saveSettings() {
  const s = {
    x: $("x").value,
    y: $("y").value,
    w: $("w").value,
    h: $("h").value,
    dir: $("dir").value,
    prefix: $("prefix").value,
    shortcut: $("shortcut").value,
    recordShortcut: $("shortcut-record").value,
    regionShortcut: $("shortcut-region").value,
    fullscreenShortcut: $("shortcut-fullscreen").value,
    indicatorShortcut: $("shortcut-indicator").value,
    collapsed: document.querySelector(".layout").classList.contains("collapsed"),
    closeAction,
    skippedUpdateVersion,
    theme,
    audioSourceId,
    audioEnabled,
    pinned,
    automations: automationScripts,
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
