import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutText } from "./platform.js";
import { buildKeyStroke } from "./mac-keycodes.js";

test("shortcut captions use the correct platform modifiers", () => {
  assert.equal(shortcutText("CommandOrControl+Shift+S", true), "⌘ ⇧ S");
  assert.equal(shortcutText("CommandOrControl+Shift+S", false), "Ctrl+Shift+S");
  assert.equal(shortcutText("Super+Alt+R", false), "Win+Alt+R");
});

test("Windows recorded strokes preserve the existing storage format and use Windows labels", () => {
  const event = { code: "KeyV", ctrlKey: true, shiftKey: true, metaKey: false, altKey: false };
  const mac = buildKeyStroke(event);
  const windows = buildKeyStroke(event, false);
  assert.equal(windows.keycode, mac.keycode);
  assert.equal(windows.flags, mac.flags);
  assert.equal(windows.label, "Ctrl+Shift+V");
  assert.equal(buildKeyStroke({ code: "ArrowLeft", metaKey: true }, false).label, "Win+ArrowLeft");
});
