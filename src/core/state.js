// 跨模块共享的可变状态集中在此，写入统一走 setter，避免分散的隐式耦合。

// ---- 窗口 ----
// 窗口是否已钉在最上层
export let pinned = false;
export function setPinned(value) {
  pinned = value;
}

// 用户是否开启“显示选区”；区域暂时为空时仍保留该意图。
export let indicatorEnabled = false;
export function setIndicatorEnabled(value) {
  indicatorEnabled = Boolean(value);
}

// ---- 屏幕录制 ----
export let recordingActive = false;
export let recordingBusy = false;
// 录屏期间是否因避免拍入而临时隐藏了选区
export let recordingHidIndicator = false;
// 当前占用录屏资源的自动化运行实例
export let automationRecordingRun = null;
export function setRecordingActive(value) {
  recordingActive = value;
}
export function setRecordingBusy(value) {
  recordingBusy = value;
}
export function setRecordingHidIndicator(value) {
  recordingHidIndicator = value;
}
export function setAutomationRecordingRun(value) {
  automationRecordingRun = value;
}

// ---- 快捷键与按键录制（互斥门禁） ----
// 正在录制的全局快捷键目标：capture / record
export let recordingKey = null;
export let prevShortcut = "";
// 自动化脚本按键序列录制上下文
export let keysRecording = null;
// 自动化脚本快捷键录制上下文
export let automationShortcutRecording = null;
export function setRecordingKey(value) {
  recordingKey = value;
}
export function setPrevShortcut(value) {
  prevShortcut = value;
}
export function setKeysRecording(value) {
  keysRecording = value;
}
export function setAutomationShortcutRecording(value) {
  automationShortcutRecording = value;
}

// ---- 自动化脚本 ----
export let automationScripts = [];
// 正在编辑的脚本 id 与草稿（草稿保存后才写回 automationScripts）
export let editingAutomationId = null;
export let editingAutomationDraft = null;
export function setAutomationScripts(value) {
  automationScripts = value;
}
export function setEditingAutomationId(value) {
  editingAutomationId = value;
}
export function setEditingAutomationDraft(value) {
  editingAutomationDraft = value;
}

// ---- 自动化编辑器交互 ----
// 正在取点的点击步骤、拖动中的步骤序号、打开的动作切换菜单
export let pointPickingStep = null;
export let draggingStepIndex = null;
export let stepTypeMenu = null;
export function setPointPickingStep(value) {
  pointPickingStep = value;
}
export function setDraggingStepIndex(value) {
  draggingStepIndex = value;
}
export function setStepTypeMenu(value) {
  stepTypeMenu = value;
}

// ---- 自动化运行时索引 ----
// id -> 已注册快捷键 / 运行实例 / 首页控件 / 列表状态标签
export const automationActiveShortcuts = new Map();
export const automationRuns = new Map();
export const automationHomeControls = new Map();
export const automationStatusLabels = new Map();
