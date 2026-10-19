import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { buildKeyStroke } from "../../shared/mac-keycodes";
import { IS_MAC } from "../../shared/platform";
import { $, setStatus } from "../../core/dom.js";
import {
  STEP_TYPES,
  getEditingAutomation,
  moveStep,
  resetStepToType,
  stepIconSvg,
  stepLabel,
} from "./model.js";
import {
  automationShortcutRecording,
  draggingStepIndex,
  keysRecording,
  pointPickingStep,
  recordingKey,
  setDraggingStepIndex,
  setKeysRecording,
  setPointPickingStep,
  setStepTypeMenu,
  stepTypeMenu,
} from "../../core/state.js";

// 渲染编辑器里的步骤列表
export function renderAutomationSteps() {
  const list = $("automation-steps");
  const script = getEditingAutomation();
  if (!list || !script) return;
  closeStepTypeMenu();
  $("automation-step-count").textContent = `${script.steps.length} 个步骤`;
  list.replaceChildren();
  if (!script.steps.length) {
    const empty = document.createElement("div");
    empty.className = "automation-steps-empty";
    const title = document.createElement("strong");
    title.textContent = "添加第一个步骤";
    const hint = document.createElement("span");
    hint.textContent = "点击上方动作，组合你的自动化流程";
    empty.append(title, hint);
    list.append(empty);
    return;
  }

  script.steps.forEach((step, index) => {
    const row = document.createElement("div");
    row.className = "automation-step";
    row.dataset.type = step.type;
    row.dataset.index = String(index);

    const drag = createDragHandle(row, script, index);
    const number = document.createElement("span");
    number.className = "step-index";
    number.textContent = String(index + 1);
    const type = createTypeButton(step, index);
    const fields = document.createElement("div");
    fields.className = "step-fields";
    appendStepFields(fields, step);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "step-remove";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除第 ${index + 1} 步`);
    remove.addEventListener("click", () => {
      script.steps.splice(index, 1);
      renderAutomationSteps();
    });
    row.append(drag, number, type, fields, remove);
    list.append(row);
  });
}

// 拖动手柄：按住拖动调整顺序，或聚焦后用上下方向键移动
function createDragHandle(row, script, index) {
  const drag = document.createElement("button");
  drag.type = "button";
  drag.className = "step-drag";
  drag.setAttribute("aria-label", `拖动调整第 ${index + 1} 步顺序`);
  drag.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
  // 用指针事件自己实现拖拽，避免 Tauri webview 的原生拖放拦截导致 HTML5 DnD 失效
  drag.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const listEl = $("automation-steps");
    const rows = [...listEl.querySelectorAll(".automation-step")];
    // 记录拖动前各行位置，避免行被位移后影响命中判断
    const rects = rows.map((r) => r.getBoundingClientRect());
    const spacing =
      rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height + 12;
    const startY = event.clientY;
    setDraggingStepIndex(index);
    row.classList.add("dragging");
    try {
      drag.setPointerCapture(event.pointerId);
    } catch {
      /* 某些环境不支持指针捕获时忽略 */
    }

    const computeTo = (clientY) => {
      for (let i = 0; i < rects.length; i++) {
        if (clientY < rects[i].top + rects[i].height / 2) return i;
      }
      return rects.length;
    };

    // 被拖动行跟随指针，其余行让出空位，形成插入动画
    const onMove = (moveEvent) => {
      row.style.transform = `translateY(${moveEvent.clientY - startY}px)`;
      const to = computeTo(moveEvent.clientY);
      rows.forEach((other, j) => {
        if (j === index) return;
        let shift = 0;
        if (index < to && j > index && j < to) shift = -spacing;
        else if (index > to && j >= to && j < index) shift = spacing;
        other.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };

    const onUp = (upEvent) => {
      drag.removeEventListener("pointermove", onMove);
      drag.removeEventListener("pointerup", onUp);
      drag.removeEventListener("pointercancel", onUp);
      try {
        drag.releasePointerCapture(event.pointerId);
      } catch {
        /* 已释放时忽略 */
      }
      const to = computeTo(upEvent.clientY);
      rows.forEach((other) => (other.style.transform = ""));
      row.classList.remove("dragging");
      const current = getEditingAutomation();
      if (current && draggingStepIndex !== null) {
        current.steps = moveStep(current.steps, draggingStepIndex, to);
      }
      setDraggingStepIndex(null);
      renderAutomationSteps();
    };

    drag.addEventListener("pointermove", onMove);
    drag.addEventListener("pointerup", onUp);
    drag.addEventListener("pointercancel", onUp);
  });
  drag.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    const target = index + delta;
    if (target < 0 || target >= script.steps.length) return;
    script.steps = moveStep(script.steps, index, delta < 0 ? target : target + 1);
    renderAutomationSteps();
    const handles = $("automation-steps").querySelectorAll(".step-drag");
    handles[target]?.focus();
  });
  return drag;
}

// 类型按钮：点击弹出菜单，从其他动作中选择切换
function createTypeButton(step, index) {
  const type = document.createElement("button");
  type.type = "button";
  type.className = "step-type";
  type.setAttribute("aria-haspopup", "true");
  type.setAttribute("aria-label", `第 ${index + 1} 步：${stepLabel(step.type)}，点击切换动作`);
  type.innerHTML =
    `<span class="step-type-icon">${stepIconSvg(step.type)}</span>` +
    `<span class="step-type-label">${stepLabel(step.type)}</span>` +
    '<svg class="step-type-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  type.addEventListener("click", (event) => {
    event.stopPropagation();
    openStepTypeMenu(step, type);
  });
  return type;
}

// 按步骤类型渲染对应的参数输入
function appendStepFields(fields, step) {
  const update = (field, value) => {
    step[field] = value;
  };
  const numberInput = (field, value, placeholder) => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "step-number";
    input.min = "0";
    input.value = value ?? 0;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", { x: "屏幕 X 坐标", y: "屏幕 Y 坐标", ms: "等待时间（毫秒）", duration: "录制时长（秒）" }[field]);
    input.addEventListener("input", () => update(field, Math.max(0, Number(input.value) || 0)));
    return input;
  };

  if (step.type === "click") {
    const x = numberInput("x", step.x, "X");
    const y = numberInput("y", step.y, "Y");
    x.title = "屏幕 X 坐标";
    y.title = "屏幕 Y 坐标";
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "ghost step-location";
    locate.textContent = "读取鼠标";
    locate.addEventListener("click", () => openPointPicker(step));
    const xLabel = document.createElement("label");
    xLabel.className = "step-coordinate";
    xLabel.append("X", x);
    const yLabel = document.createElement("label");
    yLabel.className = "step-coordinate";
    yLabel.append("Y", y);
    fields.append(xLabel, yLabel, locate);
    return;
  }
  if (step.type === "keys") {
    if (!Array.isArray(step.keys)) step.keys = [];
    const chips = document.createElement("div");
    chips.className = "step-keys";
    const record = document.createElement("button");
    record.type = "button";
    record.className = "ghost step-location step-keys-record";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "ghost step-keys-clear";
    clear.textContent = "清空";
    clear.addEventListener("click", () => {
      if (keysRecording?.step === step) stopKeysRecording();
      step.keys = [];
      renderKeyChips(step, chips);
    });
    record.addEventListener("click", () => {
      if (keysRecording?.step === step) stopKeysRecording();
      else startKeysRecording(step, chips, record);
      syncKeysRecordButton(record, step);
    });
    renderKeyChips(step, chips);
    syncKeysRecordButton(record, step);
    fields.append(chips, record, clear);
  } else if (step.type === "wait") {
    fields.append(numberInput("ms", step.ms ?? 1000, "毫秒"));
    const hint = document.createElement("span");
    hint.className = "step-hint";
    hint.textContent = "毫秒";
    fields.append(hint);
  } else if (step.type === "capture") {
    const hint = document.createElement("span");
    hint.className = "step-hint";
    hint.textContent = "使用当前预设截图区域和保存设置";
    fields.append(hint);
  } else if (step.type === "record") {
    fields.append(numberInput("duration", step.duration ?? 5, "时长"));
    const hint = document.createElement("span");
    hint.className = "step-hint";
    hint.textContent = "秒，录制当前预设区域";
    fields.append(hint);
  }
}

// 弹出动作切换菜单：列出当前节点以外的其他动作，就近选择，无需滚动到顶部
function openStepTypeMenu(step, anchor) {
  if (stepTypeMenu && stepTypeMenu.anchor === anchor) {
    closeStepTypeMenu();
    return;
  }
  closeStepTypeMenu();
  const menu = document.createElement("div");
  menu.className = "step-type-menu";
  STEP_TYPES.filter(([value]) => value !== step.type).forEach(([value, text]) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `step-type-option type-${value}`;
    option.innerHTML = `<span class="step-type-icon">${stepIconSvg(value)}</span><span>${text}</span>`;
    option.addEventListener("click", () => {
      closeStepTypeMenu();
      if (keysRecording?.step === step) stopKeysRecording();
      resetStepToType(step, value);
      renderAutomationSteps();
    });
    menu.append(option);
  });
  document.body.append(menu);
  positionStepTypeMenu(menu, anchor);
  anchor.classList.add("menu-open");
  setStepTypeMenu({ el: menu, anchor });
  // 延迟绑定，避免当前这次点击立即触发外部关闭
  setTimeout(() => {
    document.addEventListener("pointerdown", onStepTypeMenuOutside, true);
    document.addEventListener("keydown", onStepTypeMenuKey, true);
    window.addEventListener("resize", closeStepTypeMenu);
  }, 0);
}

function positionStepTypeMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.minWidth = `${rect.width}px`;
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const below = window.innerHeight - rect.bottom;
  const top = below < height + 8 && rect.top > height + 8 ? rect.top - height - 4 : rect.bottom + 4;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
}

function onStepTypeMenuOutside(event) {
  if (!stepTypeMenu) return;
  if (stepTypeMenu.el.contains(event.target) || stepTypeMenu.anchor.contains(event.target)) return;
  closeStepTypeMenu();
}

function onStepTypeMenuKey(event) {
  if (event.key === "Escape" && stepTypeMenu) {
    event.preventDefault();
    const anchor = stepTypeMenu.anchor;
    closeStepTypeMenu();
    anchor.focus();
  }
}

export function closeStepTypeMenu() {
  if (!stepTypeMenu) return;
  stepTypeMenu.anchor.classList.remove("menu-open");
  stepTypeMenu.el.remove();
  setStepTypeMenu(null);
  document.removeEventListener("pointerdown", onStepTypeMenuOutside, true);
  document.removeEventListener("keydown", onStepTypeMenuKey, true);
  window.removeEventListener("resize", closeStepTypeMenu);
}

// 渲染键盘输入节点已录制的按键序列。
function renderKeyChips(step, container) {
  container.replaceChildren();
  if (!step.keys.length) {
    const empty = document.createElement("span");
    empty.className = "step-hint";
    empty.textContent = keysRecording?.step === step ? "请按下按键，可连续录入…" : "未录制按键";
    container.append(empty);
    return;
  }
  step.keys.forEach((key, index) => {
    const chip = document.createElement("span");
    chip.className = "step-key-chip";
    const text = document.createElement("span");
    text.textContent = key.label || "?";
    const del = document.createElement("button");
    del.type = "button";
    del.setAttribute("aria-label", `删除按键 ${key.label || index + 1}`);
    del.textContent = "×";
    del.addEventListener("click", () => {
      step.keys.splice(index, 1);
      renderKeyChips(step, container);
    });
    chip.append(text, del);
    container.append(chip);
  });
}

function syncKeysRecordButton(button, step) {
  const active = keysRecording?.step === step;
  button.classList.toggle("recording", active);
  button.textContent = active ? "完成录制" : step.keys.length ? "继续录制" : "录制按键";
}

function startKeysRecording(step, container, button) {
  if (recordingKey || automationShortcutRecording) return;
  if (keysRecording) stopKeysRecording();
  setKeysRecording({ step, container, button });
  renderKeyChips(step, container);
  setStatus("请按下按键，可连续录入；完成后按 Esc 或点击“完成录制”", "");
}

export function stopKeysRecording() {
  if (!keysRecording) return;
  const { step, container, button } = keysRecording;
  setKeysRecording(null);
  renderKeyChips(step, container);
  syncKeysRecordButton(button, step);
}

// 录制键盘输入节点期间捕获按键，Esc 结束录制。
export function handleKeysRecordingKeydown(e) {
  if (!keysRecording) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === "Escape") {
    stopKeysRecording();
    setStatus("已结束按键录制", "");
    return true;
  }
  const stroke = buildKeyStroke(e, IS_MAC);
  if (!stroke) return true; // 仅修饰键，等待主键
  keysRecording.step.keys.push(stroke);
  renderKeyChips(keysRecording.step, keysRecording.container);
  return true;
}

// 打开全屏取点窗记录点击步骤的屏幕坐标
export async function openPointPicker(step) {
  return withCaptureOverlayLock(() => openPointPickerLocked(step)).catch((error) => {
    setPointPickingStep(null);
    setStatus(`无法打开取点窗口：${error}`, "err");
  });
}

// 在捕获锁内等待取点窗创建完成，避免与录屏启动交错。
async function openPointPickerLocked(step) {
  if (captureOverlaysBlocked()) return;
  if (await WebviewWindow.getByLabel("overlay")) return;
  if (pointPickingStep) return;
  setPointPickingStep(step);
  const existing = await WebviewWindow.getByLabel("point-picker");
  if (existing) await existing.close();
  let [width, height] = [1440, 900];
  try {
    [width, height] = await invoke("primary_size");
  } catch {
    /* 使用兜底尺寸 */
  }
  const picker = new WebviewWindow("point-picker", {
    x: 0,
    y: 0,
    url: "point-picker.html",
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    width,
    height,
    title: "选择鼠标位置",
  });
  picker.once("tauri://error", (event) => {
    setPointPickingStep(null);
    setStatus(`无法打开取点窗口：${event.payload}`, "err");
  });
  picker.once("tauri://destroyed", () => {
    setPointPickingStep(null);
  });
  await waitCaptureWindowCreated(picker);
  setStatus("请在屏幕上点击目标位置，按 Esc 取消", "");
}
import { withCaptureOverlayLock, captureOverlaysBlocked, waitCaptureWindowCreated } from "../capture-overlays.js";
