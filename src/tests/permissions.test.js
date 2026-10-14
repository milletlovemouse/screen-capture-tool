import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

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
