import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

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
    const originalQuerySelector = document.querySelector;
    document.querySelector = (selector) => selector === '.nav-item[data-view="settings"]'
      ? { click: () => windowActions.push("settings") }
      : originalQuerySelector(selector);
    getCurrentWindow = () => ({
      show: async () => windowActions.push("show"),
      unminimize: async () => windowActions.push("unminimize"),
      setFocus: async () => windowActions.push("focus"),
    });`);
  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.equal(h.evaluate('windowActions.join(",")'), "show,unminimize,settings,focus");
  h.evaluate('getCurrentWindow = () => ({ show: async () => { throw new Error("窗口已关闭"); } })');
  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.equal(h.elements.get("status").textContent, "");
});

test("Windows hidden window still opens settings when unminimize rejects", async () => {
  const h = harness(false);
  h.evaluate(`const windowActions = [];
    document.querySelector = (selector) => selector === '.nav-item[data-view="settings"]'
      ? { click: () => windowActions.push("settings") }
      : { classList: { contains: () => false }, focus() {} };
    getCurrentWindow = () => ({
      show: async () => windowActions.push("show"),
      unminimize: async () => { windowActions.push("unminimize"); throw new Error("not minimized"); },
      setFocus: async () => windowActions.push("focus"),
    });`);

  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.equal(h.evaluate('windowActions.join(",")'), "show,unminimize,settings,focus");
});

test("macOS application menu reuses existing actions and pages", async () => {
  const h = harness();
  await h.evaluate(`
    globalThis.appMenuActions = [];
    handleDesktopMenuAction = async (action) => appMenuActions.push(action);
    useFullscreenRegion = async () => appMenuActions.push("fullscreen");
    checkForUpdatesFromMenu = async () => appMenuActions.push("updates");
    document.querySelector = (selector) => ({
      click: () => appMenuActions.push(selector.includes("about") ? "about" : "other"),
      classList: { contains: () => false }, focus() {},
    });
  `);

  await h.evaluate('handleAppMenuAction("app.about")');
  await h.evaluate('handleAppMenuAction("app.check-updates")');
  assert.equal(
    h.evaluate('appMenuActions.join(",")'),
    "about,about,updates"
  );
});
