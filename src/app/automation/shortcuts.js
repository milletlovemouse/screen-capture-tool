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

const automationShortcutOperations = new Map();

// 同一脚本的原生注册与配置提交串行执行；失败不阻塞后续操作。
function queueAutomationShortcutOperation(id, operation) {
  const previous = automationShortcutOperations.get(id) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => {}, () => {});
  automationShortcutOperations.set(id, settled);
  void settled.then(() => {
    if (automationShortcutOperations.get(id) === settled) automationShortcutOperations.delete(id);
  });
  return result;
}

// 仅在队列内部释放当前快捷键，避免嵌套排队造成死锁。
async function releaseAutomationShortcut(id) {
  const active = automationActiveShortcuts.get(id);
  if (!active) return;
  if (await isRegistered(active)) await unregister(active);
  automationActiveShortcuts.delete(id);
}

// 删除配置也在同一队列内提交，后续保存不能复活已删除脚本。
export function unregisterAutomationShortcuts(id, commit = () => {}) {
  return queueAutomationShortcutOperation(id, async () => {
    await releaseAutomationShortcut(id);
    commit();
  });
}

// 注册成功后才提交配置；排队期间失效的脚本不再注册。
export function registerAutomationScriptShortcuts(script, { isCurrent = () => true, commit = () => {} } = {}) {
  const candidate = { id: script.id, shortcut: script.shortcut || "" };
  return queueAutomationShortcutOperation(candidate.id, async () => {
    if (!isCurrent()) return false;
    if (!(await replaceAutomationShortcut(candidate))) return false;
    commit();
    return true;
  });
}

// 先取得新键再释放旧键，冲突或释放失败时保留原注册。
async function replaceAutomationShortcut(script) {
  const accel = script.shortcut || "";
  const previous = automationActiveShortcuts.get(script.id);
  if (previous === accel) return true;
  try {
    if (!accel) {
      await releaseAutomationShortcut(script.id);
      return true;
    }
    // 新组合键成功后再注销旧键，冲突时仍可用原来的键停止脚本。
    let pressed = false;
    await register(accel, (event) => {
      if (event.state === "Released") { pressed = false; return; }
      if (event.state !== "Pressed" || pressed) return;
      pressed = true;
      if (!recordingKey && !automationShortcutRecording && !keysRecording) {
        void toggleAutomation(script.id).catch((error) => {
          setStatus(`脚本执行失败：${error}`, "err");
        });
      }
    });
    try {
      await releaseAutomationShortcut(script.id);
    } catch (error) {
      await unregister(accel);
      throw error;
    }
    automationActiveShortcuts.set(script.id, accel);
    return true;
  } catch (e) {
    setStatus(`快捷键注册失败：${e}`, "err");
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
