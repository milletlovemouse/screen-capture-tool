import { setStatus } from "../../core/dom.js";
import { saveSettings } from "../../core/settings.js";
import {
  automationHomeControls,
  automationRuns,
  automationScripts,
  automationStatusLabels,
  editingAutomationDraft,
} from "../../core/state.js";

// 读取本地数据时补全缺失字段，并兼容历史的 start/end 双快捷键格式
export function normalizeAutomationScripts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((script) => script && typeof script === "object")
    .map((script, index) => ({
      id: String(script.id || `automation-${index}-${Date.now()}`),
      name: String(script.name || "未命名脚本"),
      shortcut: String(script.shortcut ?? (script.startShortcut || script.endShortcut || "")),
      runMode: ["once", "loop", "count"].includes(script.runMode)
        ? script.runMode
        : "once",
      runCount: Number.isSafeInteger(Number(script.runCount)) && Number(script.runCount) > 0
        ? Number(script.runCount)
        : 1,
      steps: Array.isArray(script.steps)
        ? script.steps.filter((step) => step && typeof step === "object")
        : [],
    }));
}

// 创建自动化脚本的默认数据
export function newAutomationScript() {
  return {
    id: newAutomationId(),
    name: "未命名脚本",
    shortcut: "",
    runMode: "once",
    runCount: 1,
    steps: [],
  };
}

export function newAutomationId() {
  return `automation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 为复制出的脚本生成不与现有重名的名称（追加“副本”并按需编号）。
export function uniqueCopyName(name, existingNames) {
  const base = `${name || "未命名脚本"} 副本`;
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

export function getEditingAutomation() {
  return editingAutomationDraft;
}

export function cloneAutomation(script) {
  return JSON.parse(JSON.stringify(script));
}

// 步骤类型及显示名称（顺序即添加/切换菜单顺序）
export const STEP_TYPES = [
  ["click", "模拟点击"],
  ["keys", "键盘输入"],
  ["wait", "等待"],
  ["capture", "执行截图"],
  ["record", "执行录制"],
];

// 各类型图标（内层 svg 路径），用于节点与切换菜单
const STEP_ICONS = {
  click: '<path d="m5 3 14 9-7 1-3 7z"/>',
  keys: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  capture: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
  record: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
};

export function stepIconSvg(type) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STEP_ICONS[type] || ""}</svg>`;
}

export function stepLabel(type) {
  return Object.fromEntries(STEP_TYPES)[type] || "步骤";
}

// 将步骤重置为指定类型，清除旧字段并写入该类型的默认值
export function resetStepToType(step, type) {
  for (const key of ["x", "y", "keys", "ms", "duration"]) delete step[key];
  step.type = type;
  if (type === "click") {
    step.x = 0;
    step.y = 0;
  } else if (type === "keys") {
    step.keys = [];
  } else if (type === "wait") {
    step.ms = 1000;
  } else if (type === "record") {
    step.duration = 5;
  }
}

// 把 steps 中第 from 项移动到 insertBefore 指示的插入位置（0..length），返回新数组。
export function moveStep(steps, from, insertBefore) {
  if (from < 0 || from >= steps.length) return steps;
  const next = steps.slice();
  const [item] = next.splice(from, 1);
  const adjusted = insertBefore > from ? insertBefore - 1 : insertBefore;
  next.splice(Math.max(0, Math.min(adjusted, next.length)), 0, item);
  return next;
}

// 直接根据执行状态更新按钮，快捷键和首页按钮共用同一状态。
export function updateAutomationRunUI(id) {
  const run = automationRuns.get(id);
  const state = run?.cancelled ? "正在停止…" : run ? "执行中" : "未运行";
  const status = automationStatusLabels.get(id);
  if (status) {
    status.textContent = state;
    status.classList.toggle("running", Boolean(run));
  }
  const controls = automationHomeControls.get(id);
  if (!controls) return;
  controls.button.classList.toggle("recording", Boolean(run));
  controls.button.setAttribute("aria-pressed", String(Boolean(run)));
  controls.button.disabled = Boolean(run?.cancelled);
  controls.caption.textContent = run?.cancelled ? "正在停止…" : run ? "停止执行" : "开始执行";
  controls.config.disabled = Boolean(run);
  controls.meta.textContent = run
    ? `${state} · 已完成 ${run.completedRuns} 次`
    : `${controls.stepCount} 个步骤`;
}

// 首页执行参数立即保存；编辑器保存时以这里的最新参数为准。
export function saveAutomationRunSettings(id, mode, count) {
  const script = automationScripts.find((item) => item.id === id);
  if (!script || automationRuns.has(id)) return false;
  if (!["once", "loop", "count"].includes(mode) ||
      !Number.isSafeInteger(count) || count < 1) {
    setStatus("执行次数必须为大于 0 的整数", "err");
    return false;
  }
  script.runMode = mode;
  script.runCount = count;
  saveSettings();
  return true;
}
