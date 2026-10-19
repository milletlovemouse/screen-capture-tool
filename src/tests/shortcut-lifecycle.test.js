import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

// 使用既有 harness，仅为本组测试补充编辑器所需 DOM 行为。
function editorHarness() {
  const h = harness();
  h.evaluate(`
    renderAutomationList = () => {};
    renderHomeAutomations = () => {};
    renderAutomationSteps = () => {};
    confirmDialog = async () => true;
    automationScripts = [
      { id: "a", name: "old", shortcut: "Alt+A", runMode: "once", runCount: 1, steps: [] },
      { id: "b", name: "other", shortcut: "", runMode: "once", runCount: 1, steps: [] },
    ];
    $("automation-editor").classList = { add() {}, remove() {} };
    openAutomationEditor("a");
    saveSettings();
  `);
  return h;
}

// 暂停一个原生调用，精确构造保存和删除交错的时序。
function pauseNative(h, method) {
  return h.evaluate(`
    globalThis.nativeCall = ${method};
    globalThis.nativeStarted = new Promise((resolve) => { globalThis.markNativeStarted = resolve; });
    globalThis.nativeGate = new Promise((resolve) => { globalThis.releaseNative = resolve; });
    ${method} = async (...args) => {
      markNativeStarted();
      await nativeGate;
      return nativeCall(...args);
    };
    nativeStarted;
  `);
}

test("conflicting save leaves persisted settings, old shortcut and editor identity unchanged", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  const before = h.storage.get("sct-settings");
  const occupied = () => {};
  h.shortcuts.set("Alt+B", occupied);
  await h.evaluate(`
    $("automation-name").value = "new";
    $("automation-shortcut").value = "Alt+B";
    saveAutomationEditor();
  `);
  assert.equal(h.storage.get("sct-settings"), before);
  assert.equal(h.evaluate('automationScripts[0].name'), "old");
  assert.equal(h.evaluate('$("automation-editor-name").textContent'), "old");
  assert.equal(h.evaluate('$("automation-shortcut").value'), "Alt+B");
  assert.equal(h.evaluate('isEditorDirty()'), true);
  assert.equal(h.evaluate('automationActiveShortcuts.get("a")'), "Alt+A");
  assert.equal(h.shortcuts.get("Alt+B"), occupied);
  assert.equal(h.evaluate('$("status").textContent'), "");
});

test("pending save is deduplicated, commits only after registration and keeps latest run settings", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  const started = pauseNative(h, "register");
  const saving = h.evaluate(`
    $("automation-name").value = "new";
    $("automation-shortcut").value = "Alt+C";
    saveAutomationEditor();
  `);
  await started;
  await h.evaluate('saveAutomationEditor()');
  assert.equal(h.evaluate('automationScripts[0].name'), "old");
  h.evaluate('saveAutomationRunSettings("a", "count", 9); releaseNative()');
  await saving;
  const saved = JSON.parse(h.storage.get("sct-settings")).automations[0];
  assert.equal(saved.name, "new");
  assert.equal(saved.shortcut, "Alt+C");
  assert.equal(saved.runCount, 9);
  assert.equal(h.evaluate('isEditorDirty()'), false);
  assert.deepEqual([...h.shortcuts.keys()], ["Alt+C"]);
  assert.equal(h.evaluate('automationEditorSaves.size'), 0);
});

test("saving keeps step bindings on the draft and clearing a shortcut releases the old key", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  await h.evaluate(`
    editingAutomationDraft.steps.push({ type: "wait", ms: 5 });
    globalThis.boundStep = editingAutomationDraft.steps[0];
    $("automation-shortcut").value = "";
    saveAutomationEditor();
  `);
  assert.equal(h.shortcuts.size, 0);
  assert.equal(h.evaluate('automationScripts[0].shortcut'), "");
  h.evaluate('boundStep.ms = 10');
  assert.equal(h.evaluate('editingAutomationDraft.steps[0].ms'), 10);
  assert.equal(h.evaluate('automationScripts[0].steps[0].ms'), 5);
  assert.equal(h.evaluate('isEditorDirty()'), true);
});

test("save followed by repeated delete removes all script shortcuts", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  const started = pauseNative(h, "register");
  const saving = h.evaluate('$("automation-shortcut").value = "Alt+C"; saveAutomationEditor()');
  await started;
  const deleting = h.evaluate('deleteAutomationScript("a")');
  await h.evaluate('deleteAutomationScript("a")');
  h.evaluate('releaseNative()');
  await Promise.all([saving, deleting]);
  assert.equal(h.shortcuts.size, 0);
  assert.equal(h.evaluate('automationActiveShortcuts.size'), 0);
  assert.equal(h.evaluate('automationScripts.some((s) => s.id === "a")'), false);
  assert.equal(h.evaluate('editingAutomationDraft'), null);
  assert.equal(JSON.parse(h.storage.get("sct-settings")).automations.length, 1);
});

test("delete followed by save cannot register a removed script", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  const started = pauseNative(h, "unregister");
  const deleting = h.evaluate('deleteAutomationScript("a")');
  await started;
  const saving = h.evaluate('$("automation-shortcut").value = "Alt+C"; saveAutomationEditor()');
  h.evaluate('releaseNative()');
  await Promise.all([deleting, saving]);
  assert.equal(h.shortcuts.size, 0);
  assert.equal(h.evaluate('automationActiveShortcuts.size'), 0);
  assert.equal(h.evaluate('automationScripts.some((s) => s.id === "a")'), false);
});

test("concurrent replacements and unregister serialize without orphaned keys", async () => {
  const h = harness();
  const started = pauseNative(h, "register");
  const first = h.evaluate('registerAutomationScriptShortcuts({ id: "a", shortcut: "Alt+A" })');
  await started;
  const second = h.evaluate('registerAutomationScriptShortcuts({ id: "a", shortcut: "Alt+B" })');
  const removal = h.evaluate('unregisterAutomationShortcuts("a")');
  h.evaluate('releaseNative()');
  await Promise.all([first, second, removal]);
  assert.equal(h.shortcuts.size, 0);
  assert.equal(h.evaluate('automationActiveShortcuts.size'), 0);
});

test("failed removal preserves configuration and can be retried", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  h.evaluate('globalThis.originalUnregister = unregister; unregister = async () => { throw new Error("busy"); }');
  await h.evaluate('deleteAutomationScript("a")');
  assert.equal(h.evaluate('automationScripts.length'), 2);
  assert.equal(h.evaluate('automationActiveShortcuts.get("a")'), "Alt+A");
  h.evaluate('unregister = originalUnregister');
  await h.evaluate('deleteAutomationScript("a")');
  assert.equal(h.shortcuts.size, 0);
  assert.equal(h.evaluate('automationScripts.length'), 1);
});

test("old-key cleanup failure rolls back new key without committing the draft", async () => {
  const h = editorHarness();
  await h.evaluate('registerAutomationScriptShortcuts(automationScripts[0])');
  await h.evaluate(`
    globalThis.originalUnregister = unregister;
    unregister = async (key) => {
      if (key === "Alt+A") throw new Error("busy");
      return originalUnregister(key);
    };
    $("automation-shortcut").value = "Alt+C";
    saveAutomationEditor();
  `);
  assert.deepEqual([...h.shortcuts.keys()], ["Alt+A"]);
  assert.equal(h.evaluate('automationScripts[0].shortcut'), "Alt+A");
});

test("completed save never overwrites another editor or newer draft input", async () => {
  for (const switchEditor of [true, false]) {
    const h = editorHarness();
    const started = pauseNative(h, "register");
    const saving = h.evaluate('$("automation-name").value = "saved"; saveAutomationEditor()');
    await started;
    h.evaluate(switchEditor ? 'openAutomationEditor("b")' : '$("automation-name").value = "newer"; editingAutomationDraft.steps.push({ type: "wait", ms: 5 })');
    h.evaluate('releaseNative()');
    await saving;
    assert.equal(h.evaluate('automationScripts[0].name'), "saved");
    assert.equal(h.evaluate('$("automation-name").value'), switchEditor ? "other" : "newer");
    assert.equal(h.evaluate('editingAutomationDraft.id'), switchEditor ? "b" : "a");
    if (!switchEditor) assert.equal(h.evaluate('editingAutomationDraft.steps.length'), 1);
  }
});

test("page changes end every keyboard recording and restore shortcut inputs", () => {
  const h = harness();
  h.evaluate(`
    document.createElement = () => ({ append() {}, addEventListener() {}, setAttribute() {} });
    globalThis.navButton = {
      dataset: { view: "home" }, classList: { contains: () => false, toggle() {} },
      addEventListener: (name, callback) => { globalThis.navigate = callback; },
    };
    document.querySelectorAll = (selector) => selector === ".view" ? [] : [navButton];
    $("record-shortcut").classList = { remove() {} };
    setRecordingKey("capture");
    setPrevShortcut("Alt+A");
    $("shortcut").value = "按下组合键…";
    setAutomationShortcutRecording({
      input: $("automation-shortcut"), previous: "Alt+B", button: { classList: { remove() {} } },
    });
    setKeysRecording({ step: { keys: [] }, container: { replaceChildren() {}, append() {} },
      button: { classList: { toggle() {} } } });
    setupNav();
    navigate();
  `);
  assert.equal(h.evaluate('recordingKey'), null);
  assert.equal(h.evaluate('automationShortcutRecording'), null);
  assert.equal(h.evaluate('keysRecording'), null);
  assert.equal(h.evaluate('$("shortcut").value'), "Alt+A");
  assert.equal(h.evaluate('$("automation-shortcut").value'), "Alt+B");
  assert.equal(h.evaluate('$("status").textContent'), "");
});

test("startup registrations are serial and continue after a rejection", async () => {
  const h = editorHarness();
  h.evaluate(`
    globalThis.startupOrder = [];
    globalThis.startupGate = new Promise((resolve) => { globalThis.releaseStartup = resolve; });
    registerShortcut = async (key) => {
      startupOrder.push(key);
      if (key === "capture") { await startupGate; throw new Error("conflict"); }
    };
    registerAutomationScriptShortcuts = async (script) => {
      startupOrder.push(script.id);
      if (script.id === "a") throw new Error("conflict");
    };
  `);
  const startup = h.evaluate('registerStartupShortcuts()');
  assert.equal(h.evaluate('startupOrder.join(",")'), "capture");
  h.evaluate('releaseStartup()');
  await startup;
  assert.equal(h.evaluate('startupOrder.join(",")'), "capture,record,a,b,region,fullscreen,indicator");
});

test("startup catches initialization failures without changing the harness entry point", async () => {
  const h = harness();
  await h.evaluate('initializeMainWindow = async () => { throw new Error("startup"); }; init()');
  assert.equal(h.evaluate('$("status").textContent'), "");
});

test("external link rejections are handled without restoring ordinary error feedback", async () => {
  const h = harness();
  await h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.2.3";
    $("check-update").addEventListener = () => {};
    $("install-update").addEventListener = () => {};
    document.querySelectorAll = () => [{ href: "https://example.com", addEventListener: (name, callback) => {
      globalThis.clickExternalLink = callback;
    } }];
    invoke = async () => { throw new Error("browser unavailable"); };
    setupAbout();
  `);
  h.evaluate('clickExternalLink({ preventDefault() {} })');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.evaluate('$("status").textContent'), "");
});
