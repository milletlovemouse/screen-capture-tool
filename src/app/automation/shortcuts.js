import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { $, setStatus } from "../../core/dom.js";
import { buildAccelerator } from "../shortcuts.js";
import { getEditingAutomation } from "./model.js";
import { toggleAutomation } from "./runner.js";
import {
  automationActiveShortcuts,
  automationShortcutRecording,
  keysRecording,
  recordingKey,
  setAutomationShortcutRecording,
} from "../../core/state.js";

export async function unregisterAutomationShortcuts(id) {
  const active = automationActiveShortcuts.get(id);
  if (!active) return;
  if (await isRegistered(active)) await unregister(active);
  automationActiveShortcuts.delete(id);
}

export async function registerAutomationScriptShortcuts(script) {
  const accel = script.shortcut || "";
  const previous = automationActiveShortcuts.get(script.id);
  if (previous === accel) return true;
  try {
    if (!accel) {
      await unregisterAutomationShortcuts(script.id);
      return true;
    }
    // 新组合键成功后再注销旧键，冲突时仍可用原来的键停止脚本。
    let pressed = false;
    await register(accel, (event) => {
      if (event.state === "Released") { pressed = false; return; }
      if (event.state !== "Pressed" || pressed) return;
      pressed = true;
      if (!recordingKey && !automationShortcutRecording && !keysRecording) void toggleAutomation(script.id);
    });
    try {
      await unregisterAutomationShortcuts(script.id);
    } catch (error) {
      await unregister(accel);
      throw error;
    }
    automationActiveShortcuts.set(script.id, accel);
    return true;
  } catch (e) {
    setStatus(`脚本已保存，但快捷键注册失败：${e}`, "err");
    return false;
  }
}

export function stopAutomationShortcutRecording(restore = true) {
  if (!automationShortcutRecording) return;
  const target = automationShortcutRecording;
  target.button.classList.remove("recording");
  if (restore) target.input.value = target.previous;
  setAutomationShortcutRecording(null);
}

export function startAutomationShortcutRecording(field, button) {
  if (recordingKey || automationShortcutRecording || keysRecording) return;
  const input = $(field);
  setAutomationShortcutRecording({
    field,
    input,
    button: $(button),
    previous: input.value,
  });
  input.value = "按下组合键…";
  $(button).classList.add("recording");
  setStatus("请按下脚本快捷键，Esc 取消", "");
}

export function handleAutomationShortcutKeydown(e) {
  if (!automationShortcutRecording) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  const target = automationShortcutRecording;
  if (e.key === "Escape") {
    stopAutomationShortcutRecording(true);
    setStatus("已取消录制", "");
    return true;
  }
  const { mods, accel } = buildAccelerator(e);
  if (!accel) {
    target.input.value = mods.length ? mods.join("+") + "+…" : "按下组合键…";
    return true;
  }
  target.input.value = accel;
  const script = getEditingAutomation();
  if (script) script.shortcut = accel;
  stopAutomationShortcutRecording(false);
  return true;
}
