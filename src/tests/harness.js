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
  "app/region.js",
  "app/capture.js",
  "app/recording.js",
  "app/automation/steps.js",
  "app/automation/shortcuts.js",
  "app/shortcuts.js",
  "app/permissions.js",
  "app/updater.js",
  "app/navigation.js",
  "app/tray.js",
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
  const context = vm.createContext({
    IS_MAC: isMac,
    shortcutText: (value) => shortcutText(value, isMac),
    setTimeout,
    register: async (key, callback) => {
      if (shortcuts.has(key)) throw new Error("快捷键已占用");
      shortcuts.set(key, callback);
    },
    unregister: async (key) => { shortcuts.delete(key); },
    isRegistered: async (key) => shortcuts.has(key),
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    document: {
      querySelector: () => ({ classList: { contains: () => false } }),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          value: id === "dir" ? "/tmp" : "1",
          textContent: "",
          classList: { toggle() {} },
        });
        return elements.get(id);
      },
    },
    invoke: async (command, args) => {
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
    run(script) {
      context.script = { id: "test", name: "test", ...script };
      return vm.runInContext("runAutomation(script)", context);
    },
    stop: () => vm.runInContext('stopAutomation("test")', context),
    evaluate: (code) => vm.runInContext(code, context),
  };
}
