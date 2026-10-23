import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { shortcutText } from "../shared/platform.js";

// 隔离原生调用，验证真实执行逻辑的次数、顺序和取消行为。
// 被测代码拆成多个 ES 模块，这里按依赖顺序拼成一份源码后在同一 vm 作用域执行，
// 使模块级状态（automationScripts、automationRuns 等）对断言保持可见。
const MODULES = [
  "core/dom.js",
  "core/state.js",
  "core/settings.js",
  "app/automation/model.js",
  "app/desktop-menu-state.js",
  "app/region.js",
  "app/capture-overlays.js",
  "app/automation/safety.js",
  "app/capture.js",
  "app/recording.js",
  "app/automation/steps.js",
  "app/automation/shortcuts.js",
  "app/shortcuts.js",
    "app/permissions.js",
    "app/updater.js",
    "app/theme.js",
  "app/navigation.js",
    "app/scrollbars.js",
    "app/tray.js",
    "app/window-close.js",
    "app/window-controls.js",
  "app/automation/runner.js",
  "app/automation/list.js",
  "app/automation/editor.js",
  "main.js",
];

// 去掉模块语法：import 由 harness 注入的全局替代，export 只保留声明本身。
function stripModuleSyntax(text) {
  return text
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .replace(/^export\s*\{[\s\S]*?\};?\r?\n/gm, "")
    .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var))/gm, "")
    .replace(/\r?\ninit\(\);\s*$/, "");
}

const source = (
  await Promise.all(
    MODULES.map((name) => readFile(new URL(`../${name}`, import.meta.url), "utf8"))
  )
)
  .map(stripModuleSyntax)
  .join("\n");

export function harness(isMac = true) {
  const calls = [];
  const elements = new Map();
  const storage = new Map();
  const shortcuts = new Map();
  const notifications = [];
  const notificationListeners = [];
  const actionTypes = [];
  const dialogs = [];
  const windows = new Map();
  const exitCodes = [];
  const currentWindow = {
    closeRequested: null,
    hideCount: 0,
    focusCount: 0,
    async hide() { this.hideCount += 1; },
    async show() {},
    async minimize() { calls.push("window:minimize"); },
    async toggleMaximize() { calls.push("window:toggle-maximize"); },
    async close() { calls.push("window:close"); },
    async isVisible() { return true; },
    async setFocus() { this.focusCount += 1; },
    async listen() { return () => {}; },
    async onCloseRequested(callback) {
      this.closeRequested = callback;
      return () => {};
    },
    async setAlwaysOnTop() {},
  };
  class MockWebviewWindow {
    static async getByLabel(label) {
      return windows.get(label) || null;
    }

    constructor(label, options = {}) {
      this.label = label;
      this.visible = options.visible !== false;
      windows.set(label, this);
    }

    async once(name, callback) {
      if (name === "tauri://created") Promise.resolve().then(() => callback({}));
      return () => {};
    }
    async setIgnoreCursorEvents() {}
    async show() { this.visible = true; }
    async hide() { this.visible = false; }
    async isVisible() { return this.visible; }
    async close() {
      this.visible = false;
      windows.delete(this.label);
    }
  }
  const context = vm.createContext({
    IS_MAC: isMac,
    NativeIcon: {
      EnterFullScreen: "EnterFullScreen",
      PreferencesGeneral: "PreferencesGeneral",
      QuickLook: "QuickLook",
      Remove: "Remove",
      RevealFreestanding: "RevealFreestanding",
      StatusAvailable: "StatusAvailable",
      StatusPartiallyAvailable: "StatusPartiallyAvailable",
      StatusUnavailable: "StatusUnavailable",
      StopProgress: "StopProgress",
    },
    shortcutText: (value) => shortcutText(value, isMac),
    setTimeout,
    clearTimeout,
    register: async (key, callback) => {
      if (shortcuts.has(key)) throw new Error("快捷键已占用");
      shortcuts.set(key, callback);
    },
    unregister: async (key) => { shortcuts.delete(key); },
    isRegistered: async (key) => shortcuts.has(key),
    message: async (text, options) => { dialogs.push({ text, options }); },
    WebviewWindow: MockWebviewWindow,
    emit: async () => {},
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: {
      documentElement: { classList: { toggle() {} }, style: {}, setAttribute() {} },
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => ({
        classList: { contains: () => false },
        focus() {},
      }),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          value: ({
            dir: "/tmp",
            "shortcut-region": "CommandOrControl+Shift+X",
            "shortcut-fullscreen": "CommandOrControl+Shift+A",
            "shortcut-indicator": "CommandOrControl+Shift+D",
          })[id] ?? "1",
          textContent: "",
          checked: false,
          hidden: true,
          style: {},
          listeners: new Map(),
          classList: { toggle() {} },
          addEventListener(name, callback) { this.listeners.set(name, callback); },
          removeAttribute(name) { delete this[name]; },
          focus() {},
        });
        return elements.get(id);
      },
    },
    invoke: async (command, args) => {
      if (["begin_automation_operation", "cancel_automation_operation", "end_automation_operation"].includes(command)) return;
      if (command === "is_recording") return true;
      if (command === "primary_size") return [1440, 900];
      if (command === "plugin:notification|notify") {
        assert.equal(notificationListeners.length, 1, "发送前必须绑定点击监听");
        const type = actionTypes.find((type) => type.id === args.options.actionTypeId);
        assert.ok(type?.actions.length, "macOS 点击回调需要实际注册的通知动作");
        notifications.push(args.options);
        return;
      }
      calls.push({ command, args });
      return "/tmp/result";
    },
    registerActionTypes: async (types) => { actionTypes.push(...types); },
    sendNotification: (options) => { notifications.push(options); },
    onAction: async (callback) => {
      notificationListeners.push(callback);
      return { unregister: async () => {} };
    },
    exit: async (code) => { exitCodes.push(code); },
    getCurrentWindow: () => currentWindow,
    window: { addEventListener() {} },
  });
  vm.runInContext(source, context);
  return {
    calls,
    elements,
    storage,
    shortcuts,
    notifications,
    notificationListeners,
    actionTypes,
    dialogs,
    exitCodes,
    currentWindow,
    windows,
    run(script) {
      context.script = { id: "test", name: "test", ...script };
      return vm.runInContext("runAutomation(script)", context);
    },
    stop: () => vm.runInContext('stopAutomation("test")', context),
    evaluate: (code) => vm.runInContext(code, context),
  };
}
