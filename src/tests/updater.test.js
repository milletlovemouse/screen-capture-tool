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
      install: async () => {},
      download: async (onEvent) => {
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

test("closing a stalled download dismisses the prompt and prevents late installation", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.3.4";
    globalThis.installCount = 0;
    globalThis.relaunchCount = 0;
    globalThis.closeCount = 0;
    globalThis.downloadCount = 0;
    globalThis.relaunch = async () => { relaunchCount += 1; };
    globalThis.check = async () => ({
      version: "0.3.5",
      download: async (onEvent, options) => {
        downloadCount += 1;
        globalThis.downloadTimeout = options.timeout;
        globalThis.progressEvent = onEvent;
        await new Promise((resolve) => { globalThis.finishDownload = resolve; });
      },
      install: async () => { installCount += 1; },
      close: async () => { closeCount += 1; },
    });
    document.querySelectorAll = () => [];
  `);
  await h.evaluate("setupAbout()");
  await flushUpdateCheck();
  const installing = h.evaluate("installAvailableUpdate()");
  assert.equal(h.elements.get("update-cancel").disabled, false);
  await h.evaluate("installAvailableUpdate()");
  assert.equal(h.evaluate("downloadCount"), 1);
  h.evaluate('$("update-cancel").listeners.get("click")()');
  assert.equal(h.elements.get("update-prompt").hidden, true);
  h.evaluate(`
    progressEvent({ event: "Progress", data: { chunkLength: 50 } });
    finishDownload();
  `);
  await installing;
  assert.equal(h.evaluate("installCount"), 0);
  assert.equal(h.evaluate("relaunchCount"), 0);
  assert.equal(h.evaluate("closeCount"), 1);
  assert.equal(h.evaluate("downloadTimeout"), 120_000);
  assert.equal(h.elements.get("update-status").textContent, "");
  assert.equal(h.elements.get("check-update").disabled, false);
  assert.equal(h.elements.get("update-confirm").disabled, false);
});

test("installation locks cancellation only after the download completes", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.3.4";
    globalThis.relaunch = async () => {};
    globalThis.check = async () => ({
      version: "0.3.5",
      download: async () => {},
      install: async () => {
        await new Promise((resolve) => { globalThis.finishInstall = resolve; });
      },
    });
    document.querySelectorAll = () => [];
  `);
  await h.evaluate("setupAbout()");
  await flushUpdateCheck();
  const installing = h.evaluate("installAvailableUpdate()");
  await flushUpdateCheck();
  assert.equal(h.elements.get("update-cancel").disabled, true);
  h.evaluate("hideUpdatePrompt()");
  assert.equal(h.elements.get("update-prompt").hidden, false);
  h.evaluate("finishInstall()");
  await installing;
});

test("background download keeps progress available and waits for an explicit installation", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.appIconUrl = "icon.png";
    globalThis.getVersion = async () => "0.4.5";
    globalThis.installCount = 0;
    globalThis.relaunchCount = 0;
    globalThis.downloadCount = 0;
    globalThis.checkCount = 0;
    globalThis.relaunch = async () => { relaunchCount += 1; };
    globalThis.check = async () => {
      checkCount += 1;
      return {
        version: "0.4.6",
        download: async (onEvent) => {
          downloadCount += 1;
          globalThis.progressEvent = onEvent;
          onEvent({ event: "Started", data: { contentLength: 100 } });
          await new Promise((resolve) => { globalThis.finishDownload = resolve; });
          onEvent({ event: "Finished" });
        },
        install: async () => { installCount += 1; },
      };
    };
    document.querySelectorAll = () => [];
  `);
  await h.evaluate("setupAbout()");
  await flushUpdateCheck();
  assert.equal(h.elements.get("update-background").hidden, true);
  const downloading = h.evaluate("installAvailableUpdate()");
  assert.equal(h.elements.get("update-background").hidden, false);
  h.evaluate('$("update-background").listeners.get("click")()');
  assert.equal(h.elements.get("update-prompt").hidden, true);
  h.evaluate('progressEvent({ event: "Progress", data: { chunkLength: 40 } })');
  await h.evaluate('$("install-update").listeners.get("click")()');
  assert.equal(h.elements.get("update-prompt").hidden, false);
  assert.equal(h.elements.get("update-progress-bar").style.width, "40%");
  h.evaluate('$("update-background").listeners.get("click")()');
  h.evaluate("finishDownload()");
  await downloading;
  assert.equal(h.evaluate("installCount"), 0);
  assert.equal(h.evaluate("relaunchCount"), 0);
  assert.equal(h.elements.get("update-prompt").hidden, true);
  assert.equal(h.elements.get("install-update").textContent, "安装并重启");
  assert.equal(h.elements.get("update-background").hidden, true);
  await h.evaluate("checkForUpdates(false)");
  assert.equal(h.evaluate("checkCount"), 1);
  assert.equal(h.elements.get("update-prompt").hidden, false);
  assert.equal(h.elements.get("update-progress-bar").style.width, "100%");
  await h.evaluate('$("update-confirm").listeners.get("click")()');
  assert.equal(h.evaluate("downloadCount"), 1);
  assert.equal(h.evaluate("installCount"), 1);
  assert.equal(h.evaluate("relaunchCount"), 1);
});
