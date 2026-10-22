import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.js";

const update = {
  version: "0.3.5",
  body: "修复框选边缘显示\n优化更新体验",
};

// 等待 setupAbout 中不阻塞启动的自动检查完成。
const flushUpdateCheck = () => new Promise((resolve) => setImmediate(resolve));

test("startup shows available version and release notes", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.3.4";
    globalThis.check = async () => (${JSON.stringify(update)});
    globalThis.relaunch = async () => {};
    document.querySelectorAll = () => [];
  `);

  await h.evaluate("setupAbout()");
  await flushUpdateCheck();

  assert.equal(h.elements.get("update-prompt").hidden, false);
  assert.equal(h.elements.get("update-current-version").textContent, "v0.3.4");
  assert.equal(h.elements.get("update-latest-version").textContent, "v0.3.5");
  assert.equal(h.elements.get("update-release-notes").textContent, update.body);
});

test("skipped version stays hidden automatically but remains available manually", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.3.4";
    globalThis.check = async () => (${JSON.stringify(update)});
    globalThis.relaunch = async () => {};
    document.querySelectorAll = () => [];
  `);

  await h.evaluate("setupAbout()");
  await flushUpdateCheck();
  h.evaluate('$("update-skip").listeners.get("click")()');
  assert.equal(JSON.parse(h.storage.get("sct-settings")).skippedUpdateVersion, "0.3.5");

  h.elements.get("update-prompt").hidden = true;
  await h.evaluate("checkForUpdates(true)");
  assert.equal(h.elements.get("update-prompt").hidden, true);

  await h.evaluate("checkForUpdates(false)");
  assert.equal(h.elements.get("update-prompt").hidden, false);
});

test("update action downloads, reports progress and relaunches", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.3.4";
    globalThis.relaunchCount = 0;
    globalThis.relaunch = async () => { relaunchCount += 1; };
    globalThis.check = async () => ({
      version: "0.3.5",
      body: "更新内容",
      downloadAndInstall: async (onEvent) => {
        onEvent({ event: "Started", data: { contentLength: 100 } });
        onEvent({ event: "Progress", data: { chunkLength: 40 } });
        onEvent({ event: "Finished" });
      },
    });
    document.querySelectorAll = () => [];
  `);

  await h.evaluate("setupAbout()");
  await flushUpdateCheck();
  h.evaluate('$("update-confirm").listeners.get("click")()');
  await flushUpdateCheck();

  assert.equal(h.evaluate("relaunchCount"), 1);
  assert.equal(h.elements.get("update-progress-bar").style.width, "100%");
});
