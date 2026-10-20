import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

function closeEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

test("closing asks before hiding or quitting", async () => {
  const h = harness();
  h.evaluate("setupWindowClose()");

  const event = closeEvent();
  await h.currentWindow.closeRequested(event);

  assert.equal(event.prevented, true);
  assert.equal(h.elements.get("close-prompt").hidden, false);
  assert.equal(h.currentWindow.hideCount, 0);
  assert.deepEqual(h.exitCodes, []);
});

test("remembered tray choice hides immediately on later closes", async () => {
  const h = harness();
  h.evaluate("setupWindowClose()");
  await h.currentWindow.closeRequested(closeEvent());

  h.evaluate('$("close-remember").checked = true');
  await h.elements.get("close-to-tray").listeners.get("click")();

  assert.equal(h.currentWindow.hideCount, 1);
  assert.equal(JSON.parse(h.storage.get("sct-settings")).closeAction, "tray");

  await h.currentWindow.closeRequested(closeEvent());
  assert.equal(h.currentWindow.hideCount, 2);
  assert.equal(h.elements.get("close-prompt").hidden, true);
});

test("quit choice exits the application", async () => {
  const h = harness();
  h.evaluate("setupWindowClose()");
  await h.currentWindow.closeRequested(closeEvent());
  await h.elements.get("close-quit").listeners.get("click")();

  assert.deepEqual(h.exitCodes, [0]);
  assert.equal(h.currentWindow.hideCount, 0);
});
