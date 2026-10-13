import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { defaultWindowIcon, exit } from "@tauri-apps/api/app";
import { open, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission as requestNotificationPermission,
  sendNotification,
  onAction,
  registerActionTypes,
} from "@tauri-apps/plugin-notification";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import { buildKeyStroke } from "./mac-keycodes";
import { IS_MAC, shortcutText } from "./platform";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "sct-settings";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let automationScripts = [];
let editingAutomationId = null;
let editingAutomationDraft = null;
let automationShortcutRecording = null;
let keysRecording = null;
let pointPickingStep = null;
let draggingStepIndex = null;
let stepTypeMenu = null;
const automationActiveShortcuts = new Map();
const automationRuns = new Map();
const automationHomeControls = new Map();
const automationStatusLabels = new Map();

function normalizeAutomationScripts(value) {
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

// 窗口是否已钉在最上层
let pinned = false;

// 两个全局快捷键：截图、录屏开始/结束。active 记录已注册值，便于更新时先注销
const SHORTCUTS = {
  capture: {
    input: "shortcut",
    btn: "record-shortcut",
    active: null,
    action: () => doCapture(),
  },
  record: {
    input: "shortcut-record",
    btn: "record-shortcut-rec",
    active: null,
    action: () => toggleRecording(),
  },
};

// 读取/写入本地持久化设置
function loadSettings() {
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
    pinned = !!s.pinned;
    automationScripts = normalizeAutomationScripts(s.automations);
  } catch {
    /* 忽略损坏的本地数据 */
  }
}

function saveSettings() {
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

// 当前预设区域（逻辑坐标）
function regionPayload() {
  return {
    x: Math.max(0, parseInt($("x").value, 10) || 0),
    y: Math.max(0, parseInt($("y").value, 10) || 0),
    width: Math.max(0, parseInt($("w").value, 10) || 0),
    height: Math.max(0, parseInt($("h").value, 10) || 0),
  };
}

// 把当前区域广播给常驻指示窗，使其边框实时跟随
function broadcastRegion() {
  emit("region-geometry", regionPayload());
}

function setStatus(text, type = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status-text" + (type ? " " + type : "");
}

function getIndicator() {
  return WebviewWindow.getByLabel("indicator");
}

let notificationActionsReady = null;
const SAVED_FILE_ACTION_TYPE = "saved-file";
const OPEN_SAVED_FILE_ACTION = "open-saved-file";

// 点击通知时定位该次保存的文件，不受后续保存设置变化影响。
async function handleNotificationAction(event) {
  const path = event.notification?.extra?.savedPath;
  if (!["tap", OPEN_SAVED_FILE_ACTION].includes(event.actionId) ||
      typeof path !== "string" || !path) return;
  try {
    await invoke("reveal_saved_file", { path });
  } catch (error) {
    setStatus(`打开保存位置失败：${error}`, "err");
  }
}

// 共享一个监听器，确保发送前已绑定，避免每次截图重复注册。
async function notifySavedFile(title, path, body) {
  if (!notificationActionsReady) {
    // 当前 macOS 通知后端需有动作按钮才会等待响应，正文点击也依赖此配置。
    notificationActionsReady = registerActionTypes([{
      id: SAVED_FILE_ACTION_TYPE,
      actions: [{ id: OPEN_SAVED_FILE_ACTION, title: "打开保存位置" }],
    }]).then(() => onAction(handleNotificationAction)).catch((error) => {
      notificationActionsReady = null;
      throw error;
    });
  }
  await notificationActionsReady;
  // 直接等待插件命令，避免 Web Notification 包装器丢弃发送错误。
  await invoke("plugin:notification|notify", {
    options: {
      title,
      body: body || `已保存到 ${path}，点击打开保存位置`,
      actionTypeId: SAVED_FILE_ACTION_TYPE,
      extra: { savedPath: path },
    },
  });
}

// 执行一次截图：读取区域与命名，调用后端命令并自增编号
async function doCapture({ notify = true, throwOnError = false } = {}) {
  const dir = $("dir").value.trim();
  if (!dir) {
    setStatus("请先选择保存目录", "err");
    if (throwOnError) throw new Error("请先选择保存目录");
    return;
  }
  const { x, y, width, height } = regionPayload();
  const prefix = $("prefix").value || "screenshot";

  // 截图前临时隐藏选区框，避免红框被拍进图里
  let indicator = null;
  let indicatorWasVisible = false;
  try {
    indicator = await getIndicator();
    if (indicator && (await indicator.isVisible())) {
      indicatorWasVisible = true;
      await indicator.hide();
      await sleep(80);
    }
  } catch {
    // 选区窗口查询失败时仍继续截图，避免影响核心操作。
  }

  try {
    const path = await invoke("capture_region", {
      x,
      y,
      width,
      height,
      dir,
      prefix,
    });
    setStatus(`已保存：${path}`, "ok");
    if (notify) {
      try {
        await notifySavedFile("截图成功", path);
      } catch {
        // 系统通知权限未开启时，保留界面状态提示，不影响截图结果
      }
    }
    return path;
  } catch (e) {
    setStatus(`截图失败：${e}`, "err");
    if (throwOnError) throw e;
    return null;
  } finally {
    if (indicatorWasVisible && indicator) {
      try {
        await indicator.show();
      } catch {
        // 恢复窗口失败不应覆盖已经完成的截图结果。
      }
    }
  }
}

// 打开全屏透明覆盖窗进行拖拽框选
async function openRegionPicker() {
  const existing = await WebviewWindow.getByLabel("overlay");
  if (existing) {
    await existing.close();
  }
  const mainWin = getCurrentWindow();
  // 记录主窗口当前是否可见：从主窗口发起则框选后恢复，从托盘发起（后台）则保持隐藏
  const wasVisible = await mainWin.isVisible();
  if (wasVisible) {
    await mainWin.hide();
  }

  // 取主屏逻辑尺寸，用普通窗口覆盖全屏（不走原生全屏，避免独占一个桌面空间）
  let sw = 1440;
  let sh = 900;
  try {
    [sw, sh] = await invoke("primary_size");
  } catch {
    /* 取不到时用兜底尺寸 */
  }

  const overlay = new WebviewWindow("overlay", {
    x: 0,
    y: 0,
    url: "overlay.html",
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    width: sw,
    height: sh,
    title: "框选区域",
  });
  overlay.once("tauri://error", async (e) => {
    if (wasVisible) await mainWin.show();
    setStatus(`无法打开框选窗口：${e.payload}`, "err");
  });
  // 覆盖窗关闭后（无论完成选择还是取消）按需恢复主窗口
  overlay.once("tauri://destroyed", async () => {
    if (wasVisible) {
      await mainWin.show();
      await mainWin.setFocus();
    }
  });
}

// 创建常驻选区框窗口，边框附近可调整，内部点击穿透。
function createIndicator() {
  const { width, height } = regionPayload();
  const win = new WebviewWindow("indicator", {
    x: 0,
    y: 0,
    url: "indicator.html",
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
    acceptFirstMouse: true,
    width: width || 800,
    height: height || 600,
    title: "选区",
  });
  win.once("tauri://error", (e) => {
    setStatus(`无法打开选区框：${e.payload}`, "err");
  });
  return win;
}

// 确保选区框已显示（默认启动时调用）
async function ensureIndicator() {
  if (recordingActive || recordingBusy || automationRecordingRun) return;
  const win = await getIndicator();
  if (win) {
    await win.show();
    broadcastRegion();
  } else {
    createIndicator();
  }
}

// 清空当前预设选区：重置坐标并隐藏选区框
async function clearRegion() {
  if (recordingKey) return;
  ["x", "y", "w", "h"].forEach((id) => ($(id).value = 0));
  saveSettings();
  const ind = await getIndicator();
  if (ind) await ind.hide();
  setStatus("已清空选区", "ok");
}

// 显示/隐藏常驻选区框
async function toggleIndicator() {
  if (recordingActive || recordingBusy || automationRecordingRun) {
    setStatus("录屏期间选区框保持隐藏，结束后恢复", "");
    return;
  }
  const win = await getIndicator();
  if (win) {
    if (await win.isVisible()) {
      await win.hide();
      setStatus("已隐藏选区框", "ok");
    } else {
      await win.show();
      broadcastRegion();
      setStatus("已显示选区框", "ok");
    }
    return;
  }
  createIndicator();
}

// 将配置的组合键转为 macOS 常用符号，保留原始值供悬停查看。
function showHomeShortcut(element, shortcut, label = "快捷键") {
  if (!element) return;
  const value = (shortcut || "").trim();
  const display = shortcutText(value);
  element.textContent = display;
  element.hidden = !value;
  element.title = value ? `${label}：${value}` : "";
}

// 首页展示已配置值，录制中的临时提示不作为快捷键显示。
function updateHomeShortcuts() {
  for (const [key, cfg] of Object.entries(SHORTCUTS)) {
    const value = recordingKey === key ? prevShortcut : $(cfg.input).value;
    showHomeShortcut($(`home-${key}-shortcut`), value, key === "record" ? "开始 / 停止" : "快捷键");
  }
}

// 注册某个全局快捷键（key: capture / record）
async function registerShortcut(key) {
  const cfg = SHORTCUTS[key];
  const accel = $(cfg.input).value.trim();
  if (!accel) {
    setStatus("请输入快捷键", "err");
    return;
  }
  const previous = cfg.active;
  try {
    if (previous === accel && (await isRegistered(accel))) {
      setStatus(`快捷键已注册：${accel}`, "ok");
      return;
    }
    let pressed = false;
    await register(accel, (event) => {
      if (event.state === "Released") { pressed = false; return; }
      if (event.state !== "Pressed" || pressed) return;
      pressed = true;
      if (!recordingKey && !automationShortcutRecording && !keysRecording) cfg.action();
    });
    try {
      if (previous && previous !== accel && (await isRegistered(previous))) {
        await unregister(previous);
      }
    } catch (error) {
      await unregister(accel);
      throw error;
    }
    cfg.active = accel;
    saveSettings();
    setStatus(`快捷键已注册：${accel}`, "ok");
  } catch (e) {
    setStatus(`快捷键注册失败：${e}`, "err");
  }
}

// ---- 快捷键录制：直接按组合键捕获，而非手动输入 ----
let recordingKey = null; // 正在录制的目标：capture / record
let prevShortcut = "";

// 把键盘事件转换为 Tauri 加速键字符串（如 CommandOrControl+Shift+S）
function normalizeKey(e) {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const code = e.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  const map = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    " ": "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: null,
  };
  if (e.key in map) return map[e.key];
  if (e.key.length === 1) return e.key.toUpperCase();
  return null;
}

function buildAccelerator(e) {
  const mods = [];
  if (e.metaKey) mods.push(IS_MAC ? "CommandOrControl" : "Super");
  if (e.ctrlKey) mods.push(IS_MAC ? "Control" : "CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = normalizeKey(e);
  return { mods, key, accel: key ? [...mods, key].join("+") : null };
}

function startRecording(key) {
  if (recordingKey || keysRecording || automationShortcutRecording) return;
  recordingKey = key;
  const cfg = SHORTCUTS[key];
  prevShortcut = $(cfg.input).value;
  $(cfg.input).value = "按下组合键…";
  $(cfg.btn).classList.add("recording");
  setStatus("请按下想要的组合键，Esc 取消", "");
  // 保留旧注册，通过回调门禁防止误触发；取消或新键冲突时旧键仍可用。
}

function stopRecording(restore) {
  if (!recordingKey) return;
  const cfg = SHORTCUTS[recordingKey];
  $(cfg.btn).classList.remove("recording");
  if (restore) $(cfg.input).value = prevShortcut;
  recordingKey = null;
  updateHomeShortcuts();
}

function onRecordKeydown(e) {
  if (keysRecording && handleKeysRecordingKeydown(e)) return;
  if (automationShortcutRecording && handleAutomationShortcutKeydown(e)) return;
  if (!recordingKey) return;
  e.preventDefault();
  const cfg = SHORTCUTS[recordingKey];
  if (e.key === "Escape") {
    e.stopImmediatePropagation();
    stopRecording(true);
    setStatus("已取消录制", "");
    return;
  }
  const { mods, accel } = buildAccelerator(e);
  if (!accel) {
    // 仅按下修饰键，先展示预览等待主键
    $(cfg.input).value = mods.length ? mods.join("+") + "+…" : "按下组合键…";
    return;
  }
  $(cfg.input).value = accel;
  const key = recordingKey;
  stopRecording(false);
  saveSettings();
  // 录制完成后自动注册
  registerShortcut(key);
}

// ---- 屏幕录制 ----
let recordingActive = false;
let recordingBusy = false;
let recordingHidIndicator = false; // 录屏期间是否因避免拍入而临时隐藏了选区框
let automationRecordingRun = null; // 当前占用录屏资源的自动化运行实例

function updateRecUI() {
  const btn = $("record-toggle");
  const label = $("rec-label");
  if (!btn) return;
  btn.disabled = recordingBusy || Boolean(automationRecordingRun);
  btn.classList.toggle("recording", recordingActive);
  if (label) label.textContent = recordingActive ? "停止录屏" : "开始录屏";
}

// 录屏前隐藏常驻选区框，避免红色虚线被录进画面
async function hideIndicatorForRecording() {
  try {
    const ind = await getIndicator();
    if (ind && (await ind.isVisible())) {
      recordingHidIndicator = true;
      await ind.hide();
      await sleep(60);
    }
  } catch {
    /* 无选区框或查询失败时忽略，不影响录屏 */
  }
}

// 录屏结束后恢复之前显示的选区框
async function restoreIndicatorAfterRecording() {
  if (!recordingHidIndicator) return;
  recordingHidIndicator = false;
  try {
    const ind = await getIndicator();
    if (ind) {
      await ind.show();
      broadcastRegion();
    }
  } catch {
    /* 恢复失败时忽略 */
  }
}

// 开始/停止录屏（录制预设区域，无区域则录主屏）
async function toggleRecording() {
  if (recordingBusy) return;
  const dir = $("dir").value.trim();
  if (!recordingActive && !dir) {
    setStatus("请先在设置里选择保存目录", "err");
    return;
  }
  if (automationRecordingRun) {
    setStatus("自动化正在录制，请使用自动化脚本按钮停止执行", "err");
    return;
  }
  recordingBusy = true;
  updateRecUI();
  try {
    if (recordingActive) {
      let path;
      try {
        path = await invoke("stop_recording");
      } finally {
        recordingActive = false;
        await restoreIndicatorAfterRecording();
      }
      setStatus(`录屏已保存：${path}`, "ok");
      try {
        await notifySavedFile("录屏完成", path);
      } catch {
        /* 通知权限未开启时忽略 */
      }
    } else {
      const { x, y, width, height } = regionPayload();
      const prefix = $("prefix").value || "recording";
      await hideIndicatorForRecording();
      try {
        await invoke("start_recording", { x, y, width, height, dir, prefix });
      } catch (e) {
        await restoreIndicatorAfterRecording();
        throw e;
      }
      recordingActive = true;
      updateRecUI();
      setStatus("正在录屏…（再次点击停止并保存）", "ok");
    }
  } catch (e) {
    setStatus(`录屏操作失败：${e}`, "err");
  } finally {
    recordingBusy = false;
    updateRecUI();
  }
}

// 创建自动化脚本的默认数据
function newAutomationScript() {
  return {
    id: newAutomationId(),
    name: "未命名脚本",
    shortcut: "",
    runMode: "once",
    runCount: 1,
    steps: [],
  };
}

function newAutomationId() {
  return `automation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 为复制出的脚本生成不与现有重名的名称（追加“副本”并按需编号）。
function uniqueCopyName(name, existingNames) {
  const base = `${name || "未命名脚本"} 副本`;
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

function getEditingAutomation() {
  return editingAutomationDraft;
}

function cloneAutomation(script) {
  return JSON.parse(JSON.stringify(script));
}

// 步骤类型及显示名称（顺序即添加/切换菜单顺序）
const STEP_TYPES = [
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

function stepIconSvg(type) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STEP_ICONS[type] || ""}</svg>`;
}

function stepLabel(type) {
  return Object.fromEntries(STEP_TYPES)[type] || "步骤";
}

// 将步骤重置为指定类型，清除旧字段并写入该类型的默认值
function resetStepToType(step, type) {
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

// 直接根据执行状态更新按钮，快捷键和首页按钮共用同一状态。
function updateAutomationRunUI(id) {
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
function saveAutomationRunSettings(id, mode, count) {
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

// 首页每个脚本独立选择执行方式，并直接开始或停止。
function renderHomeAutomations() {
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

function renderAutomationList() {
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
      automationScripts = automationScripts.filter((item) => item.id !== script.id);
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

function renderAutomationSteps() {
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

    // 拖动手柄：按住拖动调整顺序，或聚焦后用上下方向键移动
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
      draggingStepIndex = index;
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
        draggingStepIndex = null;
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

    const number = document.createElement("span");
    number.className = "step-index";
    number.textContent = String(index + 1);
    // 类型按钮：点击弹出菜单，从其他动作中选择切换
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
    const fields = document.createElement("div");
    fields.className = "step-fields";

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
    } else if (step.type === "keys") {
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

// 把 steps 中第 from 项移动到 insertBefore 指示的插入位置（0..length），返回新数组。
function moveStep(steps, from, insertBefore) {
  if (from < 0 || from >= steps.length) return steps;
  const next = steps.slice();
  const [item] = next.splice(from, 1);
  const adjusted = insertBefore > from ? insertBefore - 1 : insertBefore;
  next.splice(Math.max(0, Math.min(adjusted, next.length)), 0, item);
  return next;
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
  stepTypeMenu = { el: menu, anchor };
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

function closeStepTypeMenu() {
  if (!stepTypeMenu) return;
  stepTypeMenu.anchor.classList.remove("menu-open");
  stepTypeMenu.el.remove();
  stepTypeMenu = null;
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
  keysRecording = { step, container, button };
  renderKeyChips(step, container);
  setStatus("请按下按键，可连续录入；完成后按 Esc 或点击“完成录制”", "");
}

function stopKeysRecording() {
  if (!keysRecording) return;
  const { step, container, button } = keysRecording;
  keysRecording = null;
  renderKeyChips(step, container);
  syncKeysRecordButton(button, step);
}

// 录制键盘输入节点期间捕获按键，Esc 结束录制。
function handleKeysRecordingKeydown(e) {
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

async function openPointPicker(step) {
  if (pointPickingStep) return;
  pointPickingStep = step;
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
    pointPickingStep = null;
    setStatus(`无法打开取点窗口：${event.payload}`, "err");
  });
  picker.once("tauri://destroyed", () => {
    pointPickingStep = null;
  });
  setStatus("请在屏幕上点击目标位置，按 Esc 取消", "");
}

function openAutomationEditor(id) {
  const script = automationScripts.find((item) => item.id === id);
  if (!script) return;
  stopAutomationShortcutRecording();
  editingAutomationId = id;
  editingAutomationDraft = cloneAutomation(script);
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
async function toggleAutomationEditor(id) {
  if (editingAutomationId === id) {
    await requestCloseEditor();
    return;
  }
  // 切换到其他脚本时，若当前有未保存改动也先确认
  if (editingAutomationId && isEditorDirty() && !(await confirmDiscard())) return;
  openAutomationEditor(id);
}

// 判断编辑器相对已保存脚本是否有改动（名称/快捷键/步骤）
function isEditorDirty() {
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

function confirmDiscard() {
  return confirmDialog("本次修改尚未保存，确定取消编辑并放弃修改吗？", {
    title: "放弃修改",
    kind: "warning",
    okLabel: "放弃",
    cancelLabel: "继续编辑",
  });
}

// 取消编辑：若有未保存改动先确认，确认后关闭
async function requestCloseEditor() {
  if (isEditorDirty() && !(await confirmDiscard())) return false;
  closeAutomationEditor();
  return true;
}

function closeAutomationEditor() {
  stopAutomationShortcutRecording();
  stopKeysRecording();
  closeStepTypeMenu();
  editingAutomationId = null;
  editingAutomationDraft = null;
  $("automation-editor").classList.add("hidden");
  $("automation-editor-status").textContent = "";
  renderAutomationList();
}

async function addAutomationScript() {
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
async function duplicateAutomationScript(id) {
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

async function saveAutomationEditor() {
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
  editingAutomationDraft = cloneAutomation(script);
  saveSettings();
  const registered = await registerAutomationScriptShortcuts(script);
  const nameLabel = $("automation-editor-name");
  if (nameLabel) nameLabel.textContent = script.name;
  renderAutomationList();
  renderHomeAutomations();
  if (registered) setStatus(`脚本“${script.name}”已保存`, "ok");
}

// 允许结束快捷键及时中断等待或定时录制
async function cancellableAutomationWait(ms, run) {
  let remain = Math.max(0, Number(ms) || 0);
  while (remain > 0 && !run.cancelled) {
    const chunk = Math.min(50, remain);
    await sleep(chunk);
    remain -= chunk;
  }
}

// 停止自动化占用的录屏资源，统一处理状态与选区框恢复。
async function stopAutomationRecording(run) {
  if (!run.recording) return;
  run.recording = false;
  try {
    run.lastSavedPath = await invoke("stop_recording");
  } finally {
    recordingActive = false;
    await restoreIndicatorAfterRecording();
    if (automationRecordingRun === run) automationRecordingRun = null;
    updateRecUI();
  }
}

async function runAutomation(script) {
  if (automationRuns.has(script.id)) return;
  const countInput = automationHomeControls.get(script.id)?.countInput;
  if (script.runMode === "count" && countInput) {
    if (!countInput.reportValidity() ||
        !saveAutomationRunSettings(script.id, script.runMode, Number(countInput.value))) return;
  }
  script = cloneAutomation(script);
  const run = { cancelled: false, recording: false, completedRuns: 0 };
  let finishRun;
  run.finished = new Promise((resolve) => { finishRun = resolve; });
  automationRuns.set(script.id, run);
  setStatus(`正在执行：${script.name}`, "ok");
  try {
    updateAutomationRunUI(script.id);
    if (!script.steps.length) {
      throw new Error("脚本没有配置步骤");
    }
    if (script.runMode === "count" &&
        (!Number.isSafeInteger(script.runCount) || script.runCount < 1)) {
      throw new Error("执行次数必须为大于 0 的整数");
    }
    const totalRuns =
      script.runMode === "loop"
        ? Number.POSITIVE_INFINITY
        : script.runMode === "count"
          ? script.runCount
          : 1;
    let completedRuns = 0;
    while (!run.cancelled && completedRuns < totalRuns) {
      for (const step of script.steps) {
        if (run.cancelled) break;
        if (step.type === "click") {
          await invoke("simulate_click", { x: Number(step.x) || 0, y: Number(step.y) || 0 });
        } else if (step.type === "keys") {
          const keys = (step.keys || []).map((key) => ({
            keycode: Number(key.keycode) || 0,
            flags: Number(key.flags) || 0,
          }));
          if (keys.length) await invoke("simulate_keys", { keys });
        } else if (step.type === "wait") {
          await cancellableAutomationWait(step.ms, run);
        } else if (step.type === "capture") {
          run.lastSavedPath = await doCapture({ notify: false, throwOnError: true });
        } else if (step.type === "record") {
          const { x, y, width, height } = regionPayload();
          const dir = $("dir").value.trim();
          if (!dir) throw new Error("请先在设置里选择保存目录");
          if (recordingActive || recordingBusy || automationRecordingRun) throw new Error("当前已有录屏正在进行");
          automationRecordingRun = run;
          await hideIndicatorForRecording();
          try {
            await invoke("start_recording", {
              x,
              y,
              width,
              height,
              dir,
              prefix: $("prefix").value || "recording",
            });
          } catch (error) {
            await restoreIndicatorAfterRecording();
            throw error;
          }
          run.recording = true;
          automationRecordingRun = run;
          recordingActive = true;
          updateRecUI();
          try {
            await cancellableAutomationWait(
              Math.max(0, Number(step.duration) || 0) * 1000,
              run
            );
          } finally {
            await stopAutomationRecording(run);
          }
        }
      }
      if (run.cancelled) break;
      completedRuns += 1;
      run.completedRuns = completedRuns;
      updateAutomationRunUI(script.id);
      if (script.runMode !== "once") {
        setStatus(
          script.runMode === "loop"
            ? `正在循环执行：${script.name}（第 ${completedRuns} 次）`
            : `正在执行：${script.name}（${completedRuns}/${totalRuns}）`,
          "ok"
        );
      }
      // 每轮让出事件循环，零等待节点也能响应停止指令。
      if (completedRuns < totalRuns) await cancellableAutomationWait(50, run);
    }
    if (run.cancelled) {
      setStatus(`已停止自动化：${script.name}`, "");
    } else {
      setStatus(`自动化完成：${script.name}`, "ok");
      try {
        if (run.lastSavedPath) {
          await notifySavedFile("自动化完成", run.lastSavedPath, `${script.name}，点击查看最后保存的文件`);
        } else {
          sendNotification({ title: "自动化完成", body: script.name });
        }
      } catch {
        /* 忽略通知权限 */
      }
    }
  } catch (e) {
    if (run.recording) {
      try {
        await stopAutomationRecording(run);
      } catch {
        /* 忽略停止录制错误 */
      }
    }
    setStatus(`自动化失败：${e}`, "err");
  } finally {
    if (run.recording) {
      try {
        await stopAutomationRecording(run);
      } catch {
        /* 忽略清理录制错误 */
      }
    }
    if (automationRecordingRun === run) {
      await restoreIndicatorAfterRecording();
      automationRecordingRun = null;
      updateRecUI();
    }
    automationRuns.delete(script.id);
    finishRun();
    updateAutomationRunUI(script.id);
  }
}

// 由执行循环统一停止录屏，避免两个停止请求竞争。
async function stopAutomation(id) {
  const run = automationRuns.get(id);
  if (!run) return;
  run.cancelled = true;
  updateAutomationRunUI(id);
  await run.finished;
}

// 首页按钮和快捷键共用启停入口。
async function toggleAutomation(id) {
  if (automationRuns.has(id)) {
    await stopAutomation(id);
  } else {
    const script = automationScripts.find((item) => item.id === id);
    if (script) await runAutomation(script);
  }
}

async function unregisterAutomationShortcuts(id) {
  const active = automationActiveShortcuts.get(id);
  if (!active) return;
  if (await isRegistered(active)) await unregister(active);
  automationActiveShortcuts.delete(id);
}

async function registerAutomationScriptShortcuts(script) {
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

function stopAutomationShortcutRecording(restore = true) {
  if (!automationShortcutRecording) return;
  const target = automationShortcutRecording;
  target.button.classList.remove("recording");
  if (restore) target.input.value = target.previous;
  automationShortcutRecording = null;
}

function startAutomationShortcutRecording(field, button) {
  if (recordingKey || automationShortcutRecording || keysRecording) return;
  const input = $(field);
  automationShortcutRecording = {
    field,
    input,
    button: $(button),
    previous: input.value,
  };
  input.value = "按下组合键…";
  $(button).classList.add("recording");
  setStatus("请按下脚本快捷键，Esc 取消", "");
}

function handleAutomationShortcutKeydown(e) {
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

function setupAutomation() {
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

// 托盘和 Dock 共用操作入口，保持快捷操作的行为一致。
async function handleDesktopMenuAction(action) {
  try {
    switch (action) {
      case "capture": await doCapture(); break;
      case "pick": await openRegionPicker(); break;
      case "record": await toggleRecording(); break;
      case "toggle": await toggleIndicator(); break;
      case "settings": {
        const w = getCurrentWindow();
        await w.show();
        await w.unminimize();
        await w.setFocus();
        break;
      }
      case "quit": await exit(0); break;
    }
  } catch (error) {
    setStatus(`菜单操作失败：${error}`, "err");
  }
}

// 创建菜单栏托盘图标与右键菜单。
async function setupTray() {
  const sep = await PredefinedMenuItem.new({ item: "Separator" });
  const menu = await Menu.new({
    items: [
      { id: "capture", text: "立即截图", action: () => handleDesktopMenuAction("capture") },
      { id: "pick", text: "框选区域", action: () => handleDesktopMenuAction("pick") },
      { id: "record", text: "开始/停止录屏", action: () => handleDesktopMenuAction("record") },
      { id: "toggle", text: "显示/隐藏选区框", action: () => handleDesktopMenuAction("toggle") },
      {
        id: "settings",
        text: "打开设置窗口",
        action: () => handleDesktopMenuAction("settings"),
      },
      sep,
      { id: "quit", text: "退出", action: () => handleDesktopMenuAction("quit") },
    ],
  });
  await TrayIcon.new({
    icon: await defaultWindowIcon(),
    tooltip: "截图工具",
    menu,
    showMenuOnLeftClick: false, // 右键显示菜单
  });
}

function bindEvents() {
  $("pick-region").addEventListener("click", openRegionPicker);
  $("capture-now").addEventListener("click", doCapture);
  $("toggle-indicator").addEventListener("click", toggleIndicator);
  $("record-toggle").addEventListener("click", toggleRecording);

  // 快捷键录制：两个录制按钮分别录制截图/录屏快捷键
  ["capture", "record"].forEach((key) => {
    $(SHORTCUTS[key].btn).addEventListener("click", () => {
      if (recordingKey === key) {
        stopRecording(true);
        setStatus("已取消录制", "");
      } else {
        if (recordingKey) stopRecording(true);
        startRecording(key);
      }
    });
  });
  window.addEventListener("keydown", onRecordKeydown, true);

  // 已选区域后按 Esc 清空选区（录制快捷键/按键录制时的 Esc 不走这里）
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !recordingKey && !keysRecording && !automationShortcutRecording) {
      clearRegion();
    }
  });

  $("use-fullscreen").addEventListener("click", async () => {
    try {
      const [w, h] = await invoke("primary_size");
      $("x").value = 0;
      $("y").value = 0;
      $("w").value = w;
      $("h").value = h;
      saveSettings();
      broadcastRegion();
      setStatus(`已设置为全屏区域 ${w}x${h}`, "ok");
    } catch (e) {
      setStatus(`获取屏幕尺寸失败：${e}`, "err");
    }
  });

  $("pick-dir").addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      $("dir").value = selected;
      saveSettings();
    }
  });

  $("prefix").addEventListener("input", () => {
    saveSettings();
  });
  ["x", "y", "w", "h"].forEach((id) =>
    $(id).addEventListener("input", () => {
      saveSettings();
      broadcastRegion();
    })
  );

  // 接收覆盖窗回传的框选结果
  listen("region-selected", (event) => {
    const { x, y, width, height } = event.payload;
    $("x").value = x;
    $("y").value = y;
    $("w").value = width;
    $("h").value = height;
    saveSettings();
    broadcastRegion();
    ensureIndicator();
    setStatus(`已选择区域 ${width}x${height} @ (${x}, ${y})`, "ok");
  });

  // 指示窗就绪后下发当前区域
  listen("indicator-ready", () => broadcastRegion());

  // 二次调整沿用预设区域保存流程，不主动显示或聚焦任何窗口。
  listen("region-adjusted", ({ payload }) => {
    const { x, y, width, height } = payload;
    if (![x, y, width, height].every(Number.isInteger) ||
        x < 0 || y < 0 || width < 2 || height < 2) return;
    $("x").value = x;
    $("y").value = y;
    $("w").value = width;
    $("h").value = height;
    saveSettings();
    broadcastRegion();
    setStatus(`选区已调整：${width} × ${height} @ (${x}, ${y})`, "ok");
  });

  // 自动化点击节点通过全屏取点窗记录屏幕坐标
  listen("mouse-position-selected", (event) => {
    if (!pointPickingStep) return;
    const { x, y } = event.payload;
    pointPickingStep.x = x;
    pointPickingStep.y = y;
    pointPickingStep = null;
    renderAutomationSteps();
    setStatus(`已记录鼠标位置 (${x}, ${y})`, "ok");
  });

  // 关闭主窗口时不退出，仅隐藏到菜单栏后台运行
  getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    await getCurrentWindow().hide();
  });
}

// 左侧菜单切换首页/设置视图
function setupNav() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  const views = document.querySelectorAll(".view");
  items.forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      items.forEach((b) => b.classList.toggle("active", b === btn));
      views.forEach((section) => {
        section.classList.toggle("hidden", section.id !== `view-${view}`);
      });
      // 进入设置时刷新一次权限状态
      if (view === "settings") refreshPermissions();
    });
  });
}

// 权限名称，用于提醒文案
const PERMISSION_NAMES = {
  screen: "屏幕录制",
  accessibility: "辅助功能（设备控制）",
  notification: "通知",
};

// 返回仍未授权的权限键列表
function missingPermissions(status) {
  return Object.keys(PERMISSION_NAMES).filter((key) => !status?.[key]);
}

// 更新单个权限行的状态显示
function applyPermissionRow(key, granted) {
  const row = document.querySelector(`.permission-row[data-perm="${key}"]`);
  const label = $(`perm-${key}-status`);
  const button = $(`perm-${key}-btn`);
  if (!row || !label) return;
  if (!IS_MAC && (key === "screen" || key === "accessibility")) {
    label.textContent = "无需单独授权";
    label.className = "permission-status granted";
    if (button) button.hidden = true;
    row.classList.add("is-granted");
    return;
  }
  row.classList.toggle("is-granted", granted);
  label.textContent = granted ? "已授权" : "未授权";
  label.className = "permission-status " + (granted ? "granted" : "denied");
  if (button) button.textContent = !IS_MAC && key === "notification" ? "系统通知设置" : granted ? "已授权" : "请求权限";
}

// 检查并刷新权限状态，未授权则在设置页提醒
async function refreshPermissions() {
  let status = { screen: true, accessibility: true };
  try {
    status = await invoke("check_permissions");
  } catch {
    // 非 Tauri 环境（如浏览器预览）无法检查，视为已具备
  }
  let notification = true;
  try {
    notification = await isPermissionGranted();
  } catch {
    // 通知插件不可用时不提醒
  }
  status = { ...status, notification };
  applyPermissionRow("screen", !!status.screen);
  applyPermissionRow("accessibility", !!status.accessibility);
  applyPermissionRow("notification", !!status.notification);
  const missing = missingPermissions(status);
  const hint = $("permission-hint");
  if (hint) {
    hint.hidden = missing.length === 0;
    if (missing.length) {
      hint.textContent =
        `尚未授予：${missing.map((k) => PERMISSION_NAMES[k]).join("、")}。` +
        (IS_MAC ? "请点击“请求权限”授权；屏幕录制授权后需重启应用生效。"
          : "请在 Windows 系统设置中检查通知设置。");
    }
  }
  return status;
}

// 请求某项权限，失败则引导到系统设置
async function requestPermission(key) {
  try {
    if (!IS_MAC) {
      await invoke("open_privacy_settings", { section: key });
      return;
    }
    let granted;
    if (key === "notification") {
      granted = (await requestNotificationPermission()) === "granted";
    } else {
      const command =
        key === "screen" ? "request_screen_permission" : "request_accessibility_permission";
      granted = await invoke(command);
    }
    applyPermissionRow(key, granted);
    if (!granted) {
      try {
        await invoke("open_privacy_settings", { section: key });
      } catch {
        /* 打开系统设置失败时仍给出提示 */
      }
      const suffix = key === "screen" ? "后重启应用" : "";
      setStatus(`请在系统设置中开启「${PERMISSION_NAMES[key]}」权限${suffix}`, "err");
    } else {
      setStatus(`已获得「${PERMISSION_NAMES[key]}」权限`, "ok");
    }
  } catch (e) {
    setStatus(`请求权限失败：${e}`, "err");
  }
  await refreshPermissions();
}

function setupPermissions() {
  $("perm-refresh").addEventListener("click", () => refreshPermissions());
  $("perm-screen-btn").addEventListener("click", () => requestPermission("screen"));
  $("perm-accessibility-btn").addEventListener("click", () =>
    requestPermission("accessibility")
  );
  $("perm-notification-btn").addEventListener("click", () =>
    requestPermission("notification")
  );
}

// 收起/展开侧边栏 + 窗口置顶
function setupSidebar() {
  const layout = document.querySelector(".layout");
  $("toggle-sidebar").addEventListener("click", () => {
    layout.classList.toggle("collapsed");
    saveSettings();
  });
  $("pin-toggle").addEventListener("click", togglePin);
}

// 置顶：alwaysOnTop + 跨桌面可见（切换桌面仍在最上层）
async function togglePin() {
  const next = !pinned;
  const w = getCurrentWindow();
  try {
    await w.setAlwaysOnTop(next);
    try {
      await w.setVisibleOnAllWorkspaces(next);
    } catch {
      /* 非 macOS 可忽略 */
    }
    pinned = next;
    $("pin-toggle").classList.toggle("active", pinned);
    setStatus(pinned ? "已钉在最上层（切换桌面保持）" : "已取消置顶", "ok");
    saveSettings();
  } catch (e) {
    setStatus(`置顶失败：${e}`, "err");
  }
}

async function init() {
  loadSettings();
  if (!IS_MAC) {
    const screenInfo = document.querySelector('.permission-row[data-perm="screen"] .permission-desc');
    const inputInfo = document.querySelector('.permission-row[data-perm="accessibility"] .permission-desc');
    if (screenInfo) screenInfo.textContent = "截图与录屏使用 Windows 系统捕获；受保护的画面可能无法捕获";
    if (inputInfo) inputInfo.textContent = "模拟输入可操作同等权限的窗口，管理员窗口需要相同权限";
  }
  updateHomeShortcuts();
  bindEvents();
  setupNav();
  setupSidebar();
  setupAutomation();
  setupPermissions();

  // 恢复置顶状态
  if (pinned) {
    $("pin-toggle").classList.add("active");
    const w = getCurrentWindow();
    try {
      await w.setAlwaysOnTop(true);
      try {
        await w.setVisibleOnAllWorkspaces(true);
      } catch {
        /* 非 macOS 可忽略 */
      }
    } catch {
      /* 忽略 */
    }
  }

  // 保留 Dock 图标，并接收原生右键菜单的操作。
  if (IS_MAC) {
    await getCurrentWindow().listen("desktop-menu-action", (event) => {
      void handleDesktopMenuAction(event.payload);
    });
  }
  await setupTray();

  // 默认显示常驻选区框
  await ensureIndicator();

  // 同步录屏状态（防止上次未正常结束）
  try {
    recordingActive = await invoke("is_recording");
    updateRecUI();
  } catch {
    /* 忽略 */
  }

  // 启动时自动注册已保存的快捷键
  if ($("shortcut").value.trim()) registerShortcut("capture");
  if ($("shortcut-record").value.trim()) registerShortcut("record");
  automationScripts.forEach((script) => registerAutomationScriptShortcuts(script));

  // 启动时检查权限，缺失则提醒去设置页授权
  const status = await refreshPermissions();
  const missing = missingPermissions(status);
  if (missing.length) {
    setStatus(
      `请在“设置 → 系统权限”中授予：${missing.map((k) => PERMISSION_NAMES[k]).join("、")}`,
      "err"
    );
  }
}

init();
