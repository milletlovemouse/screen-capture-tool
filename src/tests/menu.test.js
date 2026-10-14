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
    getCurrentWindow = () => ({
      show: async () => windowActions.push("show"),
      unminimize: async () => windowActions.push("unminimize"),
      setFocus: async () => windowActions.push("focus"),
    });`);
  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.equal(h.evaluate('windowActions.join(",")'), "show,unminimize,focus");
  h.evaluate('getCurrentWindow = () => ({ show: async () => { throw new Error("窗口已关闭"); } })');
  await h.evaluate('handleDesktopMenuAction("settings")');
  assert.equal(h.elements.get("status").textContent, "");
});
