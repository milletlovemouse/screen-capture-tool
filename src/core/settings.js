import { $ } from "./dom.js";
import {
  automationScripts,
  pinned,
  setAutomationScripts,
  setPinned,
} from "./state.js";
import { normalizeAutomationScripts } from "../app/automation/model.js";

const STORE_KEY = "sct-settings";

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
    if (s.collapsed) document.querySelector(".layout").classList.add("collapsed");
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
    collapsed: document.querySelector(".layout").classList.contains("collapsed"),
    pinned,
    automations: automationScripts,
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
