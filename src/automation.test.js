import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { shortcutText } from "./platform.js";

// 隔离原生调用，验证真实执行逻辑的次数、顺序和取消行为。
const source = (await readFile(new URL("./main.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "")
  .replace(/\ninit\(\);\s*$/, "");

function harness(isMac = true) {
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

test("keyboard steps forward every recorded stroke, skipping empty ones", async () => {
  const h = harness();
  await h.run({ runMode: "once", steps: [
    { type: "keys", keys: [
      { keycode: 8, flags: 1048576, label: "⌘C" },
      { keycode: 9, flags: 1048576, label: "⌘V" },
    ] },
    { type: "keys", keys: [] },
    { type: "keys", keys: [{ keycode: 36, flags: 0, label: "↩" }] },
  ] });
  const keyCalls = h.calls.filter((call) => call.command === "simulate_keys");
  assert.equal(keyCalls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(keyCalls[0].args.keys)), [
    { keycode: 8, flags: 1048576 }, { keycode: 9, flags: 1048576 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(keyCalls[1].args.keys)), [{ keycode: 36, flags: 0 }]);
});

test("uniqueCopyName appends 副本 and numbers only when needed", () => {
  const h = harness();
  const name = (base, existing) =>
    h.evaluate(`uniqueCopyName(${JSON.stringify(base)}, ${JSON.stringify(existing)})`);
  assert.equal(name("每日截图", []), "每日截图 副本");
  assert.equal(name("每日截图", ["每日截图 副本"]), "每日截图 副本2");
  assert.equal(name("每日截图", ["每日截图 副本", "每日截图 副本2"]), "每日截图 副本3");
  assert.equal(name("", []), "未命名脚本 副本");
});

test("duplicateAutomationScript deep-copies, reindexes and clears the shortcut", () => {
  const h = harness();
  h.evaluate(`
    renderAutomationList = () => {};
    renderHomeAutomations = () => {};
    openAutomationEditor = () => {};
    automationScripts = [
      { id: "a", name: "脚本A", shortcut: "Alt+A", runMode: "count", runCount: 3,
        steps: [{ type: "keys", keys: [{ keycode: 8, flags: 1 }] }] },
      { id: "b", name: "脚本B", shortcut: "Alt+B", runMode: "once", runCount: 1, steps: [] },
    ];
    duplicateAutomationScript("a");
  `);
  const scripts = JSON.parse(h.storage.get("sct-settings")).automations;
  assert.deepEqual(scripts.map((s) => s.name), ["脚本A", "脚本A 副本", "脚本B"]);
  const copy = scripts[1];
  assert.notEqual(copy.id, "a");
  assert.equal(copy.shortcut, "");
  assert.equal(copy.runMode, "count");
  assert.equal(copy.runCount, 3);
  // 深拷贝：修改副本步骤不应影响原脚本
  assert.deepEqual(copy.steps, [{ type: "keys", keys: [{ keycode: 8, flags: 1 }] }]);
  h.evaluate('automationScripts[1].steps[0].keys[0].keycode = 99');
  assert.equal(h.evaluate("automationScripts[0].steps[0].keys[0].keycode"), 8);
});

test("missingPermissions lists only the ungranted permissions", () => {
  const h = harness();
  const missing = (status) =>
    JSON.parse(h.evaluate(`JSON.stringify(missingPermissions(${JSON.stringify(status)}))`));
  assert.deepEqual(missing({ screen: true, accessibility: true, notification: true }), []);
  assert.deepEqual(missing({ screen: false, accessibility: true, notification: true }), ["screen"]);
  assert.deepEqual(missing({ screen: true, accessibility: false, notification: true }), ["accessibility"]);
  assert.deepEqual(missing({ screen: true, accessibility: true, notification: false }), ["notification"]);
  assert.deepEqual(missing(null), ["screen", "accessibility", "notification"]);
});

test("moveStep reorders steps for drag and keyboard without mutating the source", () => {
  const h = harness();
  const base = JSON.stringify(["a", "b", "c", "d"]);
  const move = (from, insertBefore) =>
    h.evaluate(`JSON.stringify(moveStep(${base}, ${from}, ${insertBefore}))`);
  // 下移：插入点在原索引之后会自动修正，等价于相邻交换
  assert.equal(move(0, 2), JSON.stringify(["b", "a", "c", "d"]));
  // 拖到末尾
  assert.equal(move(0, 4), JSON.stringify(["b", "c", "d", "a"]));
  // 上移到最前
  assert.equal(move(3, 0), JSON.stringify(["d", "a", "b", "c"]));
  // 原地不动
  assert.equal(move(1, 1), base);
  assert.equal(move(1, 2), base);
  // 越界的插入点被夹紧，越界的来源原样返回
  assert.equal(move(2, 99), JSON.stringify(["a", "b", "d", "c"]));
  assert.equal(move(9, 0), base);
});

test("single and counted runs preserve the full step order", async () => {  for (const [runMode, runCount, expected] of [["once", 5, 1], ["count", 3, 3]]) {
    const h = harness();
    await h.run({ runMode, runCount, steps: [
      { type: "click", x: 10, y: 20 }, { type: "click", x: 30, y: 40 },
    ] });
    assert.deepEqual(h.calls.map((call) => call.args.x), Array.from({ length: expected }, () => [10, 30]).flat());
    assert.equal(h.evaluate("automationRuns.size"), 0);
  }
});

// 提供最小按钮模型，检查真实运行事件带来的界面状态切换。
function attachControls(h) {
  h.evaluate(`
    automationHomeControls.set("test", {
      button: { classList: { toggle() {} }, setAttribute() {}, disabled: false },
      caption: {}, config: {}, meta: {}, stepCount: 1,
    });
  `);
}

test("start, stop and completion update the home button without an enable switch", async () => {
  const h = harness();
  attachControls(h);
  const read = (field) => h.evaluate(`automationHomeControls.get("test").${field}`);
  const execution = h.run({ enabled: false, runMode: "loop", steps: [{ type: "wait", ms: 1000 }] });
  assert.equal(read("caption.textContent"), "停止执行");
  assert.equal(read("config.disabled"), true);
  const stopping = h.stop();
  assert.equal(read("caption.textContent"), "正在停止…");
  assert.equal(read("button.disabled"), true);
  await stopping;
  await execution;
  assert.equal(read("caption.textContent"), "开始执行");
  assert.equal(read("config.disabled"), false);
  assert.equal(read("button.disabled"), false);

  await h.run({ runMode: "once", steps: [{ type: "wait", ms: 0 }] });
  assert.equal(read("caption.textContent"), "开始执行");
  await h.run({ runMode: "once", steps: [] });
  assert.equal(read("caption.textContent"), "开始执行");
  assert.equal(read("config.disabled"), false);
});

test("home settings persist independently and reject invalid counts", () => {
  const h = harness();
  h.evaluate(`automationScripts = [
    { id: "a", runMode: "once", runCount: 1 },
    { id: "b", runMode: "loop", runCount: 1 },
  ]`);
  assert.equal(h.evaluate('saveAutomationRunSettings("a", "count", 5)'), true);
  assert.equal(h.evaluate('saveAutomationRunSettings("a", "count", 1.5)'), false);
  const scripts = JSON.parse(h.storage.get("sct-settings")).automations;
  assert.equal(scripts[0].runCount, 5);
  assert.equal(scripts[0].runMode, "count");
  assert.equal(scripts[1].runMode, "loop");
});

test("saving an editor draft preserves the latest home execution settings", async () => {
  const h = harness();
  await h.evaluate(`
    automationScripts = [{ id: "a", name: "old", runMode: "once", runCount: 1, steps: [] }];
    editingAutomationDraft = cloneAutomation(automationScripts[0]);
    saveAutomationRunSettings("a", "count", 7);
    $("automation-name").value = "new";
    $("automation-shortcut").value = "";
    renderAutomationList = () => {};
    renderHomeAutomations = () => {};
    saveAutomationEditor();
  `);
  const script = JSON.parse(h.storage.get("sct-settings")).automations[0];
  assert.equal(script.name, "new");
  assert.equal(script.runMode, "count");
  assert.equal(script.runCount, 7);
});

test("legacy start/end shortcuts migrate to one toggle shortcut", () => {
  const h = harness();
  const scripts = JSON.parse(h.evaluate(`JSON.stringify(normalizeAutomationScripts([
    { startShortcut: "Alt+A", endShortcut: "Alt+B" },
    { endShortcut: "Alt+B" },
    { shortcut: "Alt+C", startShortcut: "Alt+A" },
    { shortcut: "", startShortcut: "Alt+A" }
  ]))`));
  assert.deepEqual(scripts.map((script) => script.shortcut), ["Alt+A", "Alt+B", "Alt+C", ""]);
  assert.ok(scripts.every((script) => !("startShortcut" in script) && !("endShortcut" in script)));
});

test("one shortcut toggles execution, ignores repeats and updates the home button", async () => {
  const h = harness();
  attachControls(h);
  await h.evaluate(`
    automationScripts = [{
      id: "test", name: "test", shortcut: "Alt+A",
      runMode: "loop", steps: [{ type: "wait", ms: 1000 }]
    }];
    registerAutomationScriptShortcuts(automationScripts[0]);
  `);
  const fire = h.shortcuts.get("Alt+A");
  fire({ state: "Pressed" });
  const finished = h.evaluate('automationRuns.get("test").finished');
  fire({ state: "Pressed" });
  assert.equal(h.evaluate('automationRuns.get("test").cancelled'), false);
  assert.equal(h.evaluate('automationHomeControls.get("test").caption.textContent'), "停止执行");
  fire({ state: "Released" });
  assert.equal(h.evaluate('automationRuns.get("test").cancelled'), false);
  fire({ state: "Pressed" });
  await finished;
  assert.equal(h.evaluate("automationRuns.size"), 0);
  assert.equal(h.evaluate('automationHomeControls.get("test").caption.textContent'), "开始执行");
});

test("shortcut conflicts preserve the old key, and successful changes release it", async () => {
  const h = harness();
  await h.evaluate('registerAutomationScriptShortcuts({ id: "test", shortcut: "Alt+A" })');
  const occupied = () => {};
  h.shortcuts.set("Alt+B", occupied);
  assert.equal(await h.evaluate('registerAutomationScriptShortcuts({ id: "test", shortcut: "Alt+B" })'), false);
  assert.ok(h.shortcuts.has("Alt+A"));
  assert.equal(h.shortcuts.get("Alt+B"), occupied);
  assert.equal(await h.evaluate('registerAutomationScriptShortcuts({ id: "test", shortcut: "Alt+C" })'), true);
  assert.equal(h.shortcuts.has("Alt+A"), false);
  assert.ok(h.shortcuts.has("Alt+C"));
  await h.evaluate('unregisterAutomationShortcuts("test")');
  assert.equal(h.shortcuts.has("Alt+C"), false);
  assert.equal(h.shortcuts.get("Alt+B"), occupied);
});

test("global capture shortcut conflicts preserve the active key", async () => {
  const h = harness();
  await h.evaluate(`
    $("shortcut").value = "Alt+A";
    registerShortcut("capture");
  `);
  h.shortcuts.set("Alt+B", () => {});
  await h.evaluate(`
    $("shortcut").value = "Alt+B";
    registerShortcut("capture");
  `);
  assert.ok(h.shortcuts.has("Alt+A"));
  assert.ok(h.shortcuts.has("Alt+B"));
  assert.equal(h.evaluate("SHORTCUTS.capture.active"), "Alt+A");
});

test("zero-wait loops yield and can be stopped without another round", async () => {
  const h = harness();
  const execution = h.run({ runMode: "loop", steps: [{ type: "wait", ms: 0 }] });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await h.stop();
  await execution;
  assert.match(h.elements.get("status").textContent, /已停止/);
  assert.equal(h.evaluate("automationRuns.size"), 0);
});

test("stopping during timed recording finalizes exactly once", async () => {
  const h = harness();
  const execution = h.run({ runMode: "loop", steps: [
    { type: "record", duration: 60 }, { type: "click", x: 1, y: 1 },
  ] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all([h.stop(), h.stop()]);
  await execution;
  assert.deepEqual(h.calls.map((call) => call.command), ["start_recording", "stop_recording"]);
  assert.equal(h.evaluate("automationRecordingRun"), null);
});

test("empty scripts and invalid counts fail before executing any action", async () => {
  for (const script of [
    { runMode: "loop", steps: [] },
    ...[0, -1, 1.5, Infinity].map((runCount) => ({
      runMode: "count", runCount, steps: [{ type: "click", x: 1, y: 1 }],
    })),
  ]) {
    const h = harness();
    await h.run(script);
    assert.equal(h.calls.length, 0);
    assert.match(h.elements.get("status").textContent, /自动化失败/);
  }
});

test("legacy scripts default to once and retain saved execution settings", () => {
  const h = harness();
  const scripts = JSON.parse(h.evaluate(`JSON.stringify(normalizeAutomationScripts([
    { id: "old" }, { id: "counted", runMode: "count", runCount: 4 },
    { id: "looped", runMode: "loop" }
  ]))`));
  assert.deepEqual(scripts.map(({ runMode, runCount }) => [runMode, runCount]),
    [["once", 1], ["count", 4], ["loop", 1]]);
});

test("save notifications register once and retain their own file paths", async () => {
  const h = harness();
  await h.evaluate(`Promise.all([
    notifySavedFile("截图成功", "/tmp/旧目录/图片 1.png"),
    notifySavedFile("录屏完成", "/tmp/新目录/录像.mov")
  ])`);
  assert.equal(h.notificationListeners.length, 1);
  assert.equal(h.actionTypes.length, 1);
  assert.equal(h.notifications.length, 2);
  h.evaluate('$("dir").value = "/tmp/another"');
  for (const notification of h.notifications) {
    await h.notificationListeners[0]({ actionId: "tap", notification });
  }
  assert.deepEqual(h.calls.map(({ command, args }) => [command, args.path]), [
    ["reveal_saved_file", "/tmp/旧目录/图片 1.png"],
    ["reveal_saved_file", "/tmp/新目录/录像.mov"],
  ]);
});

test("notification dismissal and notifications without saved files do nothing", async () => {
  const h = harness();
  await h.evaluate(`handleNotificationAction({
    actionId: "dismiss", notification: { extra: { savedPath: "/tmp/file.png" } }
  })`);
  await h.evaluate('handleNotificationAction({ actionId: "tap", notification: null })');
  await h.evaluate('handleNotificationAction({ actionId: "tap", notification: { extra: {} } })');
  assert.equal(h.calls.length, 0);
});

test("manual capture and recording notifications contain backend output paths", async () => {
  const h = harness();
  await h.evaluate("doCapture()");
  await h.evaluate("toggleRecording()");
  await h.evaluate("toggleRecording()");
  assert.deepEqual(h.notifications.map((n) => [n.title, n.extra.savedPath]), [
    ["截图成功", "/tmp/result"], ["录屏完成", "/tmp/result"],
  ]);
});

test("automation completion links its last output and plain scripts have no file link", async () => {
  const h = harness();
  h.evaluate(`const originalInvoke = invoke;
    invoke = async (command, args) => command === "stop_recording"
      ? "/tmp/last.mov" : originalInvoke(command, args)`);
  await h.run({ runMode: "once", steps: [
    { type: "capture" }, { type: "record", duration: 0 },
  ] });
  assert.equal(h.notifications[0].extra.savedPath, "/tmp/last.mov");
  await h.run({ runMode: "once", steps: [{ type: "wait", ms: 0 }] });
  assert.equal(h.notifications[1].extra, undefined);
});

test("notification open errors are reported without an unhandled rejection", async () => {
  const h = harness();
  h.evaluate('invoke = async () => { throw new Error("目录不存在"); }');
  await h.evaluate(`handleNotificationAction({
    actionId: "tap", notification: { extra: { savedPath: "/tmp/gone.png" } }
  })`);
  assert.match(h.elements.get("status").textContent, /打开保存位置失败.*目录不存在/);
});

test("the registered notification action opens the same file as a body click", async () => {
  const h = harness();
  await h.evaluate('notifySavedFile("截图成功", "/tmp/图片.png")');
  const action = h.actionTypes[0].actions[0];
  assert.equal(action.title, "打开保存位置");
  for (const actionId of ["tap", action.id]) {
    await h.notificationListeners[0]({ actionId, notification: h.notifications[0] });
  }
  assert.deepEqual(h.calls.map(({ command, args }) => [command, args.path]), [
    ["reveal_saved_file", "/tmp/图片.png"], ["reveal_saved_file", "/tmp/图片.png"],
  ]);
});

test("notification registration failures can retry without duplicate listeners", async () => {
  const h = harness();
  h.evaluate(`const originalRegisterActions = registerActionTypes;
    registerActionTypes = async () => { throw new Error("注册失败"); }`);
  await assert.rejects(h.evaluate('notifySavedFile("截图", "/tmp/a.png")'), /注册失败/);
  assert.equal(h.notificationListeners.length, 0);
  assert.equal(h.notifications.length, 0);
  h.evaluate("registerActionTypes = originalRegisterActions");
  await h.evaluate('notifySavedFile("截图", "/tmp/a.png")');
  assert.equal(h.notificationListeners.length, 1);
  assert.equal(h.notifications.length, 1);
});

test("native notification send failures propagate to the caller", async () => {
  const h = harness();
  h.evaluate('invoke = async () => { throw new Error("发送失败"); }');
  await assert.rejects(h.evaluate('notifySavedFile("截图", "/tmp/a.png")'), /发送失败/);
});

test("desktop menus capture and share the existing recording ownership guard", async () => {
  const h = harness();
  await h.evaluate('handleDesktopMenuAction("capture")');
  assert.equal(h.calls.filter(({ command }) => command === "capture_region").length, 1);
  await h.evaluate(`Promise.all([
    handleDesktopMenuAction("record"), handleDesktopMenuAction("record")
  ])`);
  assert.equal(h.calls.filter(({ command }) => command === "start_recording").length, 1);
  await h.evaluate('handleDesktopMenuAction("record")');
  assert.equal(h.calls.filter(({ command }) => command === "stop_recording").length, 1);
  h.evaluate('automationRecordingRun = { id: "active" }');
  await h.evaluate('handleDesktopMenuAction("record")');
  assert.equal(h.calls.filter(({ command }) => command === "start_recording").length, 1);
});

test("desktop menu restores a minimized window before focusing it", async () => {
  const h = harness();
  h.evaluate(`const windowActions = [];
    getCurrentWindow = () => ({
      show: async () => windowActions.push("show"),
      unminimize: async () => windowActions.push("unminimize"),
      setFocus: async () => windowActions.push("focus"),
    });`);
  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.equal(h.evaluate('windowActions.join(",")'), "show,unminimize,focus");
  h.evaluate('getCurrentWindow = () => ({ show: async () => { throw new Error("窗口已关闭"); } })');
  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.match(h.elements.get("status").textContent, /菜单操作失败.*窗口已关闭/);
});
