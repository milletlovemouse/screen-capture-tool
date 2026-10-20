import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 原生权限不会被 VM mock 检查，单独验证新窗口所属的 capability。
test("automation status has workspace permission without broad application permissions", async () => {
  const config = JSON.parse(await readFile(new URL("../../src-tauri/capabilities/automation-status.json", import.meta.url), "utf8"));
  assert.deepEqual(config.windows, ["automation-status"]);
  assert.ok(config.permissions.includes("core:window:allow-set-visible-on-all-workspaces"));
  assert.equal(config.permissions.some((permission) => permission.startsWith("global-shortcut:")), false);
  const main = JSON.parse(await readFile(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.ok(main.permissions.includes("core:window:allow-set-ignore-cursor-events"));
  assert.ok(main.permissions.includes("core:window:allow-start-dragging"));
  assert.ok(main.permissions.includes("core:app:allow-exit"));
});

test("macOS transparent title bar keeps a dedicated drag region", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  const layout = await readFile(new URL("../styles/layout.css", import.meta.url), "utf8");

  assert.match(html, /class="window-drag-region"[^>]*data-tauri-drag-region/);
  assert.match(layout, /\.platform-macos \.window-drag-region\s*\{/);
  assert.match(layout, /left:\s*72px/);
});
