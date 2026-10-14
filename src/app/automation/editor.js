import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { $, setStatus } from "../../core/dom.js";
import { saveSettings } from "../../core/settings.js";
import {
  cloneAutomation,
  getEditingAutomation,
  newAutomationId,
  newAutomationScript,
  resetStepToType,
  uniqueCopyName,
} from "./model.js";
import { renderAutomationList, renderHomeAutomations } from "./list.js";
import {
  closeStepTypeMenu,
  renderAutomationSteps,
  stopKeysRecording,
} from "./steps.js";
import {
  registerAutomationScriptShortcuts,
  startAutomationShortcutRecording,
  stopAutomationShortcutRecording,
} from "./shortcuts.js";
import {
  automationScripts,
  automationShortcutRecording,
  editingAutomationDraft,
  editingAutomationId,
  setEditingAutomationDraft,
  setEditingAutomationId,
} from "../../core/state.js";

export function openAutomationEditor(id) {
  const script = automationScripts.find((item) => item.id === id);
  if (!script) return;
  stopAutomationShortcutRecording();
  setEditingAutomationId(id);
  setEditingAutomationDraft(cloneAutomation(script));
  $("automation-editor").classList.remove("hidden");
  $("automation-name").value = editingAutomationDraft.name || "";
  $("automation-shortcut").value = editingAutomationDraft.shortcut || "";
  $("automation-editor-status").textContent = "编辑中";
  const name = $("automation-editor-name");
  if (name) name.textContent = editingAutomationDraft.name || "";
  renderAutomationList();
  renderAutomationSteps();
}

// 列表项点击：展开即编辑，再次点击收起（取消编辑）
export async function toggleAutomationEditor(id) {
  if (editingAutomationId === id) {
    await requestCloseEditor();
    return;
  }
  // 切换到其他脚本时，若当前有未保存改动也先确认
  if (editingAutomationId && isEditorDirty() && !(await confirmDiscard())) return;
  openAutomationEditor(id);
}

// 判断编辑器相对已保存脚本是否有改动（名称/快捷键/步骤）
export function isEditorDirty() {
  const saved = automationScripts.find((item) => item.id === editingAutomationId);
  if (!saved || !editingAutomationDraft) return false;
  const current = {
    name: $("automation-name").value.trim(),
    shortcut: $("automation-shortcut").value.trim(),
    steps: editingAutomationDraft.steps,
  };
  const base = {
    name: saved.name || "",
    shortcut: saved.shortcut || "",
    steps: saved.steps || [],
  };
  return JSON.stringify(current) !== JSON.stringify(base);
}

export function confirmDiscard() {
  return confirmDialog("本次修改尚未保存，确定取消编辑并放弃修改吗？", {
    title: "放弃修改",
    kind: "warning",
    okLabel: "放弃",
    cancelLabel: "继续编辑",
  });
}

// 取消编辑：若有未保存改动先确认，确认后关闭
export async function requestCloseEditor() {
  if (isEditorDirty() && !(await confirmDiscard())) return false;
  closeAutomationEditor();
  return true;
}

export function closeAutomationEditor() {
  stopAutomationShortcutRecording();
  stopKeysRecording();
  closeStepTypeMenu();
  setEditingAutomationId(null);
  setEditingAutomationDraft(null);
  $("automation-editor").classList.add("hidden");
  $("automation-editor-status").textContent = "";
  renderAutomationList();
}

export async function addAutomationScript() {
  if (editingAutomationId && isEditorDirty() && !(await confirmDiscard())) return;
  const script = newAutomationScript();
  automationScripts.push(script);
  saveSettings();
  renderAutomationList();
  renderHomeAutomations();
  openAutomationEditor(script.id);
  setStatus("已新建自动化脚本，请配置步骤", "ok");
}

// 复制脚本：深拷贝步骤，生成新 ID 与唯一名称，清空快捷键以免冲突。
export async function duplicateAutomationScript(id) {
  if (editingAutomationId && isEditorDirty() && !(await confirmDiscard())) return;
  const index = automationScripts.findIndex((item) => item.id === id);
  if (index < 0) return;
  const copy = cloneAutomation(automationScripts[index]);
  copy.id = newAutomationId();
  copy.name = uniqueCopyName(automationScripts[index].name, automationScripts.map((s) => s.name));
  copy.shortcut = "";
  automationScripts.splice(index + 1, 0, copy);
  saveSettings();
  renderAutomationList();
  renderHomeAutomations();
  openAutomationEditor(copy.id);
  setStatus(`已复制脚本：${copy.name}`, "ok");
}

function addAutomationStep(type) {
  const script = getEditingAutomation();
  if (!script) {
    setStatus("请先新建或编辑一个脚本", "err");
    return;
  }
  const step = {};
  resetStepToType(step, type);
  script.steps.push(step);
  renderAutomationSteps();
}

export async function saveAutomationEditor() {
  const script = getEditingAutomation();
  if (!script) return;
  stopAutomationShortcutRecording();
  const name = $("automation-name").value.trim();
  if (!name) {
    setStatus("请填写脚本名称", "err");
    return;
  }
  script.name = name;
  script.shortcut = $("automation-shortcut").value.trim();
  const index = automationScripts.findIndex((item) => item.id === script.id);
  if (index >= 0) {
    script.runMode = automationScripts[index].runMode;
    script.runCount = automationScripts[index].runCount;
    automationScripts[index] = script;
  }
  setEditingAutomationDraft(cloneAutomation(script));
  saveSettings();
  const registered = await registerAutomationScriptShortcuts(script);
  const nameLabel = $("automation-editor-name");
  if (nameLabel) nameLabel.textContent = script.name;
  renderAutomationList();
  renderHomeAutomations();
  if (registered) setStatus(`脚本“${script.name}”已保存`, "ok");
}

export function setupAutomation() {
  $("add-automation").addEventListener("click", () => void addAutomationScript());
  $("save-automation").addEventListener("click", saveAutomationEditor);
  $("cancel-automation").addEventListener("click", () => requestCloseEditor());
  $("add-click-step").addEventListener("click", () => addAutomationStep("click"));
  $("add-keys-step").addEventListener("click", () => addAutomationStep("keys"));
  $("add-wait-step").addEventListener("click", () => addAutomationStep("wait"));
  $("add-capture-step").addEventListener("click", () => addAutomationStep("capture"));
  $("add-record-step").addEventListener("click", () => addAutomationStep("record"));
  $("record-automation-shortcut").addEventListener("click", () => {
    if (automationShortcutRecording) stopAutomationShortcutRecording();
    else startAutomationShortcutRecording("automation-shortcut", "record-automation-shortcut");
  });
  renderAutomationList();
  renderHomeAutomations();
}
