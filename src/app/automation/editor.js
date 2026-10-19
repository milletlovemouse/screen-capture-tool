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

const automationEditorSaves = new Set();

// 切换编辑对象前结束输入录制，避免继续写入旧草稿。
export function openAutomationEditor(id) {
  const script = automationScripts.find((item) => item.id === id);
  if (!script) return;
  stopAutomationShortcutRecording();
  stopKeysRecording();
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

// 保存快照只在快捷键注册成功后提交，重复点击及已删除对象不再提交。
export async function saveAutomationEditor() {
  const draft = getEditingAutomation();
  if (!draft || automationEditorSaves.has(draft.id)) return;
  stopAutomationShortcutRecording();
  stopKeysRecording();
  const name = $("automation-name").value.trim();
  if (!name) {
    setStatus("请填写脚本名称", "err");
    return;
  }
  const saved = automationScripts.find((item) => item.id === draft.id);
  if (!saved) return;
  const script = cloneAutomation(draft);
  script.name = name;
  script.shortcut = $("automation-shortcut").value.trim();
  const stepsSnapshot = JSON.stringify(draft.steps);
  automationEditorSaves.add(script.id);
  try {
    await registerAutomationScriptShortcuts(script, {
      isCurrent: () => automationScripts.includes(saved),
      commit: () => {
        const index = automationScripts.indexOf(saved);
        script.runMode = saved.runMode;
        script.runCount = saved.runCount;
        automationScripts[index] = script;
        // 异步保存结束时，不覆盖切换后的编辑器或等待期间的新输入。
        if (editingAutomationDraft === draft &&
            $("automation-name").value.trim() === name &&
            $("automation-shortcut").value.trim() === script.shortcut &&
            JSON.stringify(draft.steps) === stepsSnapshot) {
          // 保留步骤对象，现有输入事件和录制目标仍绑定在当前草稿上。
          draft.name = script.name;
          draft.shortcut = script.shortcut;
          draft.runMode = script.runMode;
          draft.runCount = script.runCount;
          const nameLabel = $("automation-editor-name");
          if (nameLabel) nameLabel.textContent = script.name;
        }
        saveSettings();
        renderAutomationList();
        renderHomeAutomations();
        setStatus(`脚本“${script.name}”已保存`, "ok");
      },
    });
  } catch (error) {
    setStatus(`脚本保存失败：${error}`, "err");
  } finally {
    automationEditorSaves.delete(script.id);
  }
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
