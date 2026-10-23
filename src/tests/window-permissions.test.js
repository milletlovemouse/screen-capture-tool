import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { harness } from "./harness.js";

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

test("Windows uses a transparent custom title bar without a logo", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  const base = await readFile(new URL("../styles/base.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../styles/layout.css", import.meta.url), "utf8");
  const windowsConfig = JSON.parse(await readFile(new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"));

  assert.equal(windowsConfig.app.windows[0].decorations, false);
  assert.match(layout, /\.platform-windows \.window-drag-region\s*\{/);
  assert.match(layout, /\.platform-windows \.window-controls\s*\{/);
  assert.match(layout, /\.platform-windows \.window-drag-region\s*\{[^]*left:\s*160px/);
  assert.match(layout, /\.platform-windows \.sidebar\s*\{[^]*padding-top:\s*12px/);
  assert.match(layout, /\.platform-windows \.content\s*\{[^]*padding-top:\s*44px/);
  assert.match(base, /:where\(button, input, select, textarea\):focus\s*\{[^]*outline:\s*none/);
  assert.match(base, /:where\(button, input, select, textarea\):focus-visible\s*\{[^]*outline:\s*2px solid var\(--focus-ring\)/);
  assert.match(layout, /\.nav-item:focus-visible\s*\{[^]*outline:\s*none[^]*background:\s*var\(--nav-hover-bg\)/);
  const controls = html.match(/<div class="window-controls"[^]*?<\/div>/)?.[0] || "";
  assert.doesNotMatch(controls, /<img\b|brand-logo/);
});

test("Windows custom title bar keeps native window actions", async () => {
  const h = harness(false);

  h.evaluate('setupWindowControls(); $("window-minimize").listeners.get("click")();');
  h.evaluate('$("window-maximize").listeners.get("click")();');
  h.evaluate('$("window-close").listeners.get("click")();');
  await Promise.resolve();

  assert.deepEqual(h.calls, ["window:minimize", "window:toggle-maximize", "window:close"]);
});
