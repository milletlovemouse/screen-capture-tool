import { $ } from "../../core/dom.js";
import { saveSettings } from "../../core/settings.js";
import { showHomeShortcut } from "../shortcuts.js";
import { saveAutomationRunSettings, updateAutomationRunUI } from "./model.js";
import { stopAutomation, toggleAutomation } from "./runner.js";
import { unregisterAutomationShortcuts } from "./shortcuts.js";
import {
  closeAutomationEditor,
  confirmDiscard,
  isEditorDirty,
  toggleAutomationEditor,
  duplicateAutomationScript,
} from "./editor.js";
import {
  automationHomeControls,
  automationRuns,
  automationScripts,
  automationStatusLabels,
  editingAutomationId,
  setAutomationScripts,
} from "../../core/state.js";

// 首页每个脚本独立选择执行方式，并直接开始或停止。
export function renderHomeAutomations() {
  const list = $("home-automation-list");
  if (!list) return;
  list.replaceChildren();
  automationHomeControls.clear();
  if (!automationScripts.length) {
    const empty = document.createElement("div");
    empty.className = "automation-empty";
    empty.textContent = "暂无脚本，请到“自动化”菜单新建";
    list.append(empty);
    return;
  }
  automationScripts.forEach((script) => {
    const item = document.createElement("div");
    item.className = "automation-home-item";

    const header = document.createElement("div");
    header.className = "automation-home-header";
    const name = document.createElement("span");
    name.className = "automation-item-name";
    name.textContent = script.name || "未命名脚本";
    name.title = name.textContent;
    const meta = document.createElement("span");
    meta.className = "automation-item-meta";
    meta.setAttribute("aria-live", "polite");
    meta.textContent = `${script.steps.length} 个步骤`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rec-btn automation-run-toggle";
    const dot = document.createElement("span");
    dot.className = "rec-dot";
    dot.setAttribute("aria-hidden", "true");
    const caption = document.createElement("span");
    button.append(dot, caption);
    button.addEventListener("click", () => {
      void toggleAutomation(script.id);
    });
    const identity = document.createElement("div");
    identity.className = "automation-identity";
    const icon = document.createElement("span");
    icon.className = "automation-script-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v6a3 3 0 0 0 3 3h6M9 6h6a3 3 0 0 1 3 3v6"/></svg>';
    const details = document.createElement("div");
    details.className = "automation-script-details";
    const shortcut = document.createElement("kbd");
    shortcut.className = "home-shortcut";
    showHomeShortcut(shortcut, script.shortcut, "开始 / 停止");
    details.append(name, meta);
    identity.append(icon, details);
    const actions = document.createElement("div");
    actions.className = "automation-home-actions";
    actions.append(shortcut, button);
    header.append(identity, actions);

    const config = document.createElement("fieldset");
    config.className = "automation-run-options";
    const legend = document.createElement("legend");
    legend.textContent = "执行方式";
    config.append(legend);
    const modes = document.createElement("div");
    modes.className = "automation-mode-segments";
    const countLabel = document.createElement("label");
    countLabel.className = "automation-count";
    countLabel.textContent = "执行";
    countLabel.hidden = script.runMode !== "count";
    const countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "1";
    countInput.step = "1";
    countInput.max = String(Number.MAX_SAFE_INTEGER);
    countInput.required = true;
    countInput.setAttribute("aria-label", "执行次数");
    countInput.value = script.runCount;
    countInput.addEventListener("change", () => {
      if (!countInput.reportValidity()) return;
      saveAutomationRunSettings(script.id, script.runMode, Number(countInput.value));
    });
    countLabel.append(countInput, document.createTextNode("次"));
    for (const [mode, text] of [["once", "单次执行"], ["loop", "循环执行"], ["count", "指定次数"]]) {
      const label = document.createElement("label");
      label.className = "automation-mode-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `run-mode-${script.id}`;
      radio.value = mode;
      radio.checked = script.runMode === mode;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        saveAutomationRunSettings(script.id, mode, script.runCount);
        countLabel.hidden = mode !== "count";
        countInput.value = script.runCount;
      });
      const optionText = document.createElement("span");
      optionText.textContent = text;
      label.append(radio, optionText);
      modes.append(label);
    }
    config.append(modes, countLabel);
    item.append(header, config);
    automationHomeControls.set(script.id, {
      button, caption, config, meta, countInput, stepCount: script.steps.length,
    });
    updateAutomationRunUI(script.id);
    list.append(item);
  });
}

// 自动化页列表：展开编辑、复制与删除
export function renderAutomationList() {
  const list = $("automation-list");
  if (!list) return;
  const editor = $("automation-editor");
  list.replaceChildren();
  automationStatusLabels.clear();
  if (!automationScripts.length) {
    const empty = document.createElement("div");
    empty.className = "automation-empty";
    empty.textContent = "还没有自动化脚本，点击右上角“新建脚本”开始配置";
    list.append(empty);
    if (editor) list.after(editor); // 无脚本时编辑器回到列表下方
    return;
  }
  automationScripts.forEach((script) => {
    const item = document.createElement("div");
    item.className = "automation-list-item";
    item.dataset.scriptId = script.id;
    item.classList.toggle("is-editing", editingAutomationId === script.id);
    // 点击展开编辑，再次点击收起（取消编辑）
    item.addEventListener("click", () => toggleAutomationEditor(script.id));

    const status = document.createElement("span");
    status.className = "automation-script-state";
    automationStatusLabels.set(script.id, status);
    updateAutomationRunUI(script.id);
    const name = document.createElement("span");
    name.className = "automation-item-name";
    name.textContent = script.name || "未命名脚本";
    name.title = name.textContent;
    const meta = document.createElement("span");
    meta.className = "automation-item-meta";
    meta.textContent = `${script.steps.length} 个步骤`;

    const actions = document.createElement("div");
    actions.className = "automation-item-actions";
    const duplicate = document.createElement("button");
    duplicate.type = "button";
    duplicate.className = "ghost";
    duplicate.textContent = "复制";
    duplicate.addEventListener("click", (event) => {
      event.stopPropagation();
      void duplicateAutomationScript(script.id);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost danger";
    remove.textContent = "删除";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (editingAutomationId && isEditorDirty() && !(await confirmDiscard())) return;
      if (automationRuns.has(script.id)) await stopAutomation(script.id);
      await unregisterAutomationShortcuts(script.id);
      setAutomationScripts(automationScripts.filter((item) => item.id !== script.id));
      if (editingAutomationId === script.id) closeAutomationEditor();
      saveSettings();
      renderAutomationList();
      renderHomeAutomations();
    });
    actions.append(duplicate, remove);
    const info = document.createElement("div");
    info.className = "automation-list-info";
    const summary = document.createElement("div");
    summary.className = "automation-list-summary";
    summary.append(status, meta);
    info.append(name, summary);
    item.append(info, actions);
    list.append(item);
  });

  // 把编辑器插入到正在编辑的脚本下方，便于定位；否则放回列表末尾。
  if (editor) {
    const activeItem = editingAutomationId
      ? list.querySelector(`.automation-list-item[data-script-id="${editingAutomationId}"]`)
      : null;
    if (activeItem) activeItem.after(editor);
    else list.after(editor);
  }
}
