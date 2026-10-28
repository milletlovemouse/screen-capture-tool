import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

// 隔离无关启动操作，验证真实主窗口初始化中的录屏恢复顺序。
function startupRecordingHarness(active) {
  const h = harness(false);
  h.evaluate(`
    loadSettings = () => {};
    updateHomeShortcuts = () => {};
    bindEvents = () => {};
    setupNav = () => {};
    setupAbout = async () => {};
    setupSidebar = () => {};
    setupAutomation = () => {};
    setupPermissions = () => {};
    setupAudioSources = () => {};
    setupTray = async () => {};
    registerStartupShortcuts = async () => {};
    refreshPermissions = async () => {};
    globalThis.recordingStartupOrder = [];
    invoke = async (command) => {
      recordingStartupOrder.push(command);
      return ${active};
    };
    updateRecUI = () => recordingStartupOrder.push("ui:" + recordingActive);
    hideIndicatorForRecording = async () => recordingStartupOrder.push("hide");
    startRecordingMonitor = () => recordingStartupOrder.push("monitor");
    setIndicatorEnabled = (value) => recordingStartupOrder.push("enabled:" + value);
    ensureIndicator = async () => recordingStartupOrder.push("indicator:" + recordingActive);
  `);
  return h;
}

test("startup awaits overlay hiding before monitoring an existing recording and never shows the indicator", async () => {
  const h = startupRecordingHarness(true);
  h.evaluate(`
    globalThis.hideStarted = new Promise((resolve) => { globalThis.markHideStarted = resolve; });
    globalThis.hideGate = new Promise((resolve) => { globalThis.finishHide = resolve; });
    hideIndicatorForRecording = async () => {
      recordingStartupOrder.push("hide");
      markHideStarted();
      await hideGate;
    };
  `);
  const initializing = h.evaluate("initializeMainWindow()");
  await h.evaluate("hideStarted");
  assert.equal(h.evaluate('recordingStartupOrder.join(",")'), "is_recording,ui:true,hide");
  h.evaluate("finishHide()");
  await initializing;
  assert.equal(h.evaluate("recordingActive"), true);
  assert.equal(h.evaluate('recordingStartupOrder.join(",")'), "is_recording,ui:true,hide,monitor");
});

test("startup shows the indicator only after restoring an inactive recording state", async () => {
  const h = startupRecordingHarness(false);
  await h.evaluate("initializeMainWindow()");
  assert.equal(h.evaluate('recordingStartupOrder.join(",")'), "is_recording,ui:false,enabled:true,indicator:false");
});

test("failed overlay hiding during recording does not fall through to showing the indicator", async () => {
  const h = startupRecordingHarness(true);
  await h.evaluate(`
    hideIndicatorForRecording = async () => { throw new Error("hide failed"); };
    initializeMainWindow();
  `);
  assert.equal(h.evaluate('recordingStartupOrder.join(",")'), "is_recording,ui:true");
});

test("script shortcut handles toggle rejection and still ignores repeated presses", async () => {
  const h = harness();
  await h.evaluate(`
    globalThis.shortcutToggleCalls = 0;
    toggleAutomation = async () => {
      shortcutToggleCalls += 1;
      throw new Error("toggle failed");
    };
    registerAutomationScriptShortcuts({ id: "a", shortcut: "Alt+A" });
  `);
  const fire = h.shortcuts.get("Alt+A");
  fire({ state: "Pressed" });
  fire({ state: "Pressed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.evaluate("shortcutToggleCalls"), 1);
  assert.equal(h.evaluate('$("status").textContent'), "");
  fire({ state: "Released" });
  fire({ state: "Pressed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.evaluate("shortcutToggleCalls"), 2);
});

for (const isMac of [true, false]) {
  test(`${isMac ? "macOS" : "Windows"} recording monitor finalizes a failed native task and preserves its error`, async () => {
    const h = harness(isMac);
    h.evaluate(`
      globalThis.monitorCalls = [];
      setTimeout = (callback) => { globalThis.pollRecording = callback; return 1; };
      clearTimeout = () => {};
      invoke = async (command) => {
        monitorCalls.push(command);
        if (command === "is_recording") return false;
        if (command === "stop_recording") throw new Error("原生编码器错误");
      };
      restoreIndicatorAfterRecording = async () => { monitorCalls.push("restore"); };
      updateRecUI = () => {};
      setRecordingActive(true);
      startRecordingMonitor();
    `);
    await h.evaluate("pollRecording()");
    assert.equal(h.evaluate('monitorCalls.join(",")'), "is_recording,stop_recording,restore");
    assert.match(h.elements.get("record-toggle").title, /原生编码器错误/);
    assert.equal(h.evaluate("recordingActive"), false);
    assert.equal(h.evaluate("recordingBusy"), false);
  });
}

test("recording status query failure leaves an active recording running", async () => {
  const h = harness();
  h.evaluate(`
    setTimeout = (callback) => { globalThis.pollRecording = callback; return 1; };
    clearTimeout = () => {};
    globalThis.monitorCalls = [];
    invoke = async (command) => {
      monitorCalls.push(command);
      throw new Error("查询失败");
    };
    setRecordingActive(true);
    startRecordingMonitor();
  `);
  await h.evaluate("pollRecording()");
  assert.equal(h.evaluate("recordingActive"), true);
  assert.equal(h.evaluate('monitorCalls.join(",")'), "is_recording");
});
