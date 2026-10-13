import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeyStroke, MAC_KEYCODES, FLAG } from "./mac-keycodes.js";

test("maps a modified key to its macOS keycode, flags and label", () => {
  const stroke = buildKeyStroke({ code: "KeyC", metaKey: true });
  assert.deepEqual(stroke, { keycode: 8, flags: FLAG.command, label: "⌘C" });
});

test("combines every modifier flag and symbol in a stable order", () => {
  const stroke = buildKeyStroke({
    code: "KeyS", metaKey: true, ctrlKey: true, altKey: true, shiftKey: true,
  });
  assert.equal(stroke.keycode, MAC_KEYCODES.KeyS);
  assert.equal(stroke.flags, FLAG.command + FLAG.control + FLAG.alternate + FLAG.shift);
  assert.equal(stroke.label, "⌘⌃⌥⇧S");
});

test("plain keys and named keys resolve without modifiers", () => {
  assert.deepEqual(buildKeyStroke({ code: "Enter" }), { keycode: 36, flags: 0, label: "↩" });
  assert.deepEqual(buildKeyStroke({ code: "ArrowLeft" }), { keycode: 123, flags: 0, label: "←" });
  assert.deepEqual(buildKeyStroke({ code: "Digit7" }), { keycode: 26, flags: 0, label: "7" });
});

test("modifier-only presses and unknown codes return null", () => {
  for (const code of ["ShiftLeft", "MetaRight", "ControlLeft", "AltLeft", "Unidentified"]) {
    assert.equal(buildKeyStroke({ code, shiftKey: true }), null);
  }
});
