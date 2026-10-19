import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.js";

// 不使用固定睡眠猜测启动时序，等待目标条件且限制总等待时间。
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("等待交互状态超时");
}

test("overlapping capture leases restore windows only after the last owner", async () => {
  const h = harness();
  h.evaluate('new WebviewWindow("indicator")');
  const first = await h.evaluate("acquireCaptureOverlays()");
  const second = await h.evaluate("acquireCaptureOverlays()");
  assert.equal(h.windows.get("indicator").visible, false);
  await first();
  assert.equal(h.windows.get("indicator").visible, false);
  await second();
  assert.equal(h.windows.get("indicator").visible, true);
  await first();
  assert.equal(h.evaluate("captureOverlayOwners.size"), 0);
});

test("capture finishing cannot reveal overlays while recording owns them", async () => {
  const h = harness();
  h.evaluate('new WebviewWindow("indicator")');
  const captureRelease = await h.evaluate("acquireCaptureOverlays()");
  await h.evaluate("hideIndicatorForRecording()");
  await captureRelease();
  assert.equal(h.windows.get("indicator").visible, false);
  await h.evaluate("restoreIndicatorAfterRecording()");
  assert.equal(h.windows.get("indicator").visible, true);
});

test("capture aborts rather than photographing an overlay that failed to hide", async () => {
  const h = harness();
  h.evaluate('new WebviewWindow("indicator")');
  h.windows.get("indicator").hide = async () => { throw new Error("hide failed"); };
  await assert.rejects(h.evaluate("doCapture({throwOnError:true})"), /hide failed/);
  assert.equal(h.calls.some((call) => call.command === "capture_region"), false);
  assert.equal(h.evaluate("captureOverlayOwners.size"), 0);
});

test("recording blocks region picker and point picker through their shared entry points", async () => {
  const h = harness();
  h.evaluate("setRecordingActive(true)");
  await h.evaluate("openRegionPicker()");
  await h.evaluate("openPointPicker({})");
  assert.equal(h.windows.has("overlay"), false);
  assert.equal(h.windows.has("point-picker"), false);
  assert.equal(h.evaluate("pointPickingStep"), null);
});

test("capture cannot start while a picker exists", async () => {
  const h = harness();
  h.evaluate('new WebviewWindow("point-picker")');
  await assert.rejects(h.evaluate("doCapture({throwOnError:true})"), /框选\/取点/);
  assert.equal(h.calls.length, 0);
});

test("stopping during preparation never starts a recording", async () => {
  const h = harness();
  const running = h.run({ runMode: "once", steps: [{ type: "record", duration: 60 }] });
  await h.stop();
  await running;
  assert.equal(h.calls.some((call) => call.command === "start_recording"), false);
  assert.equal(h.evaluate("captureOverlayOwners.size"), 0);
});

test("unexpected native recording termination updates UI and releases the overlay lease", async () => {
  const h = harness();
  h.evaluate('new WebviewWindow("indicator")');
  await h.evaluate("hideIndicatorForRecording()");
  h.evaluate(`
    setRecordingActive(true);
    invoke = async () => false;
    startRecordingMonitor();
  `);
  await until(() => h.evaluate("!recordingActive"));
  await until(() => h.windows.get("indicator").visible);
  assert.equal(h.evaluate("captureOverlayOwners.size"), 0);
});

test("a new run waits for emergency shortcut cleanup then re-registers before executing", async () => {
  const h = harness();
  const a = h.run({ id: "a", runMode: "loop", steps: [{ type: "wait", ms: 1000 }] });
  await until(() => h.shortcuts.has("Escape") && h.windows.has("automation-status"));
  h.evaluate(`
    const originalUnregister = unregister;
    globalThis.cleanupEntered = false;
    unregister = async (key) => {
      if (key === "Escape") {
        cleanupEntered = true;
        await new Promise(resolve => { globalThis.finishCleanup = resolve; });
      }
      await originalUnregister(key);
    };
  `);
  const stopping = h.evaluate('stopAutomation("a")');
  await until(() => h.evaluate("cleanupEntered"));
  const b = h.run({ id: "b", runMode: "loop", steps: [{ type: "click", x: 5, y: 6 }] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.calls.some((call) => call.command === "simulate_click"), false);
  h.evaluate("finishCleanup(); unregister = originalUnregister;");
  await stopping;
  await a;
  await until(() => h.calls.some((call) => call.command === "simulate_click"));
  assert.equal(h.shortcuts.has("Escape"), true);
  await h.evaluate('stopAutomation("b")');
  await b;
});

test("a run started during recording keeps its status window hidden and restores it afterwards", async () => {
  const h = harness();
  await h.evaluate("hideIndicatorForRecording();");
  h.evaluate("setRecordingActive(true)");
  const running = h.run({ runMode: "loop", steps: [{ type: "wait", ms: 1000 }] });
  await until(() => h.windows.has("automation-status"));
  assert.equal(h.windows.get("automation-status").visible, false);
  h.evaluate("setRecordingActive(false)");
  await h.evaluate("restoreIndicatorAfterRecording()");
  assert.equal(h.windows.get("automation-status").visible, true);
  await h.stop();
  await running;
});

test("emergency cancellation reaches the backend before an in-flight click returns", async () => {
  const h = harness();
  h.evaluate(`
    const originalInvoke = invoke;
    globalThis.nativeCommands = [];
    invoke = async (command, args) => {
      nativeCommands.push(command);
      if (command === "simulate_click") {
        await new Promise(resolve => { globalThis.finishClick = resolve; });
      }
      return originalInvoke(command, args);
    };
  `);
  const running = h.run({ steps: [{ type: "click", x: 5, y: 6 }, { type: "click", x: 10, y: 20 }] });
  await until(() => h.evaluate('nativeCommands.includes("simulate_click")'));
  const emergency = h.shortcuts.get("Escape");
  emergency({ state: "Pressed" }); emergency({ state: "Released" });
  emergency({ state: "Pressed" }); emergency({ state: "Released" });
  assert.equal(h.evaluate('nativeCommands.includes("cancel_automation_operation")'), true);
  h.evaluate("finishClick()");
  await running;
  assert.equal(h.calls.filter((call) => call.command === "simulate_click").length, 1);
  assert.equal(h.evaluate('nativeCommands.includes("end_automation_operation")'), true);
});

test("status window initialization failure never starts automation or leaves a visible blocker", async () => {
  const h = harness();
  h.evaluate('WebviewWindow.prototype.setIgnoreCursorEvents = async () => { throw new Error("denied"); }');
  await h.run({ steps: [{ type: "click", x: 5, y: 6 }] });
  assert.equal(h.calls.length, 0);
  assert.equal(h.windows.has("automation-status"), false);
  assert.equal(h.shortcuts.has("Escape"), false);
});

test("a stale toggle shortcut map does not bypass the emergency stop requirement", async () => {
  const h = harness();
  h.shortcuts.set("Escape", () => {});
  h.evaluate('automationActiveShortcuts.set("test", "Alt+F8")');
  await h.run({ shortcut: "Alt+F8", steps: [{ type: "click", x: 5, y: 6 }] });
  assert.equal(h.calls.length, 0);
  assert.equal(h.dialogs.length, 1);
});

test("global Escape clears a selected region without a focused main window", async () => {
  const h = harness();
  h.evaluate('$("w").value = 200; $("h").value = 100; new WebviewWindow("indicator")');
  await h.evaluate("registerRegionEscape()");
  h.shortcuts.get("Escape")({ state: "Pressed" });
  await until(() => !h.shortcuts.has("Escape"));
  assert.equal(h.elements.get("w").value, 0);
  assert.equal(h.elements.get("h").value, 0);
  assert.equal(h.windows.get("indicator").visible, false);
});

test("automation keeps its double Escape behavior while a selected region owns Escape", async () => {
  const h = harness();
  h.evaluate('$("w").value = 200; $("h").value = 100');
  await h.evaluate("registerRegionEscape()");
  const running = h.run({ runMode: "loop", steps: [{ type: "wait", ms: 1000 }] });
  await until(() => h.windows.has("automation-status"));
  const escape = h.shortcuts.get("Escape");
  escape({ state: "Pressed" }); escape({ state: "Released" });
  assert.equal(h.evaluate('automationRuns.get("test").cancelled'), false);
  assert.equal(h.elements.get("w").value, 200);
  escape({ state: "Pressed" }); escape({ state: "Released" });
  await running;
  assert.equal(h.windows.has("automation-status"), false);
  assert.equal(h.shortcuts.has("Escape"), true);
  await h.evaluate("clearRegion()");
  assert.equal(h.shortcuts.has("Escape"), false);
});

test("region shortcuts register independently and full screen ignores repeat presses and recording", async () => {
  const h = harness();
  h.evaluate("globalThis.regionEvents = []; globalThis.emit = async (...args) => regionEvents.push(args)");
  await h.evaluate("registerRegionShortcuts()");
  const keys = ["CommandOrControl+Shift+X", "CommandOrControl+Shift+A", "CommandOrControl+Shift+D"];
  for (const key of keys) assert.equal(h.shortcuts.has(key), true);
  const fullscreen = h.shortcuts.get(keys[1]);
  fullscreen({ state: "Pressed" });
  fullscreen({ state: "Pressed" });
  await until(() => h.evaluate("regionEvents.length") === 1);
  assert.equal(h.elements.get("w").value, 1440);
  assert.equal(h.elements.get("h").value, 900);
  fullscreen({ state: "Released" });
  h.evaluate('setRecordingKey("capture")');
  fullscreen({ state: "Pressed" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.evaluate("regionEvents.length"), 1);
  await h.evaluate("registerRegionShortcuts()");
  assert.equal(h.shortcuts.size, 3);
});

test("a conflicting region shortcut does not prevent the other region keys from registering", async () => {
  const h = harness();
  const owner = () => {};
  h.shortcuts.set("CommandOrControl+Shift+X", owner);
  await h.evaluate("registerRegionShortcuts()");
  assert.equal(h.shortcuts.get("CommandOrControl+Shift+X"), owner);
  assert.equal(h.shortcuts.has("CommandOrControl+Shift+A"), true);
  assert.equal(h.shortcuts.has("CommandOrControl+Shift+D"), true);
});

test("region shortcut settings persist, replace registrations and roll back conflicts", async () => {
  const h = harness();
  await h.evaluate("registerRegionShortcuts()");
  h.evaluate('$("shortcut-region").value = "Alt+F9"');
  await h.evaluate('registerShortcut("region")');
  assert.equal(h.shortcuts.has("CommandOrControl+Shift+X"), false);
  assert.equal(h.shortcuts.has("Alt+F9"), true);
  assert.equal(JSON.parse(h.storage.get("sct-settings")).regionShortcut, "Alt+F9");
  assert.match(h.elements.get("pick-region").title, /F9/);
  h.shortcuts.set("Alt+F10", () => {});
  h.evaluate('$("shortcut-region").value = "Alt+F10"');
  await h.evaluate('registerShortcut("region")');
  assert.equal(h.elements.get("shortcut-region").value, "Alt+F9");
  assert.equal(JSON.parse(h.storage.get("sct-settings")).regionShortcut, "Alt+F9");
  assert.equal(h.shortcuts.has("Alt+F9"), true);
  h.evaluate('localStorage.getItem = () => JSON.stringify({regionShortcut:"Alt+F6", fullscreenShortcut:"Alt+F7", indicatorShortcut:"Alt+F8"}); loadSettings()');
  assert.equal(h.elements.get("shortcut-region").value, "Alt+F6");
  assert.equal(h.elements.get("shortcut-fullscreen").value, "Alt+F7");
  assert.equal(h.elements.get("shortcut-indicator").value, "Alt+F8");
});
