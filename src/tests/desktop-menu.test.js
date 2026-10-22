import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.js";

// 用原生菜单替身保留真实同步队列、事件分发和执行器。
async function menuHarness(isMac = true) {
  const app = harness(isMac);
  await app.evaluate(`
    globalThis.menus = [];
    globalThis.Menu = {
      new: async ({ items }) => ({
        items,
        close: async () => {},
      }),
    };
    globalThis.IconMenuItem = {
      new: async (options) => ({ ...options, close: async () => {} }),
    };
    globalThis.MenuItem = {
      new: async (options) => ({ ...options, close: async () => {} }),
    };
    globalThis.TrayIcon = {
      new: async () => ({ setMenu: async (menu) => { menus.push(menu); } }),
    };
    globalThis.defaultWindowIcon = async () => null;
    createMacTrayIcon = async () => ({ close: async () => {} });
    setAutomationScripts([
      { id: "alpha:1", name: "脚本甲", runMode: "loop", steps: [{ type: "wait", ms: 1000 }] },
      { id: "beta", name: "脚本乙", runMode: "once", steps: [] },
    ]);
    setAutomationMenuAction(toggleAutomation);
    setupTray();
  `);
  return app;
}

// 将 VM 内的菜单投影转换为普通对象，避免跨上下文原型影响断言。
function scriptItems(app) {
  return JSON.parse(app.evaluate(`JSON.stringify(menus.at(-1).items
    .filter((item) => item.id?.startsWith("automation:"))
    .map(({ id, text, enabled }) => ({ id, text, enabled })))`));
}

function iconItems(app) {
  return JSON.parse(app.evaluate(`JSON.stringify(menus.at(-1).items
    .filter((item) => item.id)
    .map(({ id, icon }) => ({ id, icon })))`));
}

test("托盘同步脚本名称、增删，并避免重复刷新", async () => {
  const app = await menuHarness();
  assert.equal(iconItems(app).every(({ icon }) => Boolean(icon)), true);
  assert.deepEqual(scriptItems(app), [
    { id: "automation:alpha:1", text: "脚本甲", enabled: true },
    { id: "automation:beta", text: "脚本乙", enabled: true },
  ]);
  assert.equal(app.calls.at(-1).command, "update_tray_menu");
  assert.equal(app.calls.at(-1).args.items.length, 2);
  await app.evaluate("refreshAutomationDesktopMenus()");
  assert.equal(app.evaluate("menus.length"), 1);
  await app.evaluate(`
    automationScripts[0].name = "已改名";
    setAutomationScripts(automationScripts.slice(0, 1));
    refreshAutomationDesktopMenus();
  `);
  assert.deepEqual(scriptItems(app), [
    { id: "automation:alpha:1", text: "已改名", enabled: true },
  ]);
  await app.evaluate("setAutomationScripts([]); refreshAutomationDesktopMenus()");
  assert.deepEqual(scriptItems(app), []);
  assert.equal(app.calls.at(-1).command, "update_tray_menu");
});

test("Windows 托盘菜单使用无图标的普通菜单项", async () => {
  const app = await menuHarness(false);
  const items = JSON.parse(app.evaluate(`JSON.stringify(menus.at(-1).items
    .filter((item) => item.id)
    .map(({ id, text, icon }) => ({ id, text, icon })))`));

  assert.equal(items.every(({ icon }) => icon == null), true);
  assert.equal(items.find(({ id }) => id === "capture").text, "立即截图");
  assert.equal(items.find(({ id }) => id === "record").text, "开始录屏");
  assert.equal(
    app.evaluate('typeof menus.at(-1).items.find(({ id }) => id === "capture").action'),
    "function"
  );
});

test("macOS 托盘菜单操作交给原生菜单事件统一转发", async () => {
  const app = await menuHarness();
  assert.equal(
    app.evaluate(`menus.at(-1).items
      .filter(({ id }) => id)
      .every(({ action }) => action == null)`),
    true
  );
});

test("菜单复用真实执行器，运行和停止后状态一致", async () => {
  const app = await menuHarness();
  app.evaluate('globalThis.menuRun = handleDesktopMenuAction("automation:alpha:1")');
  await app.evaluate("refreshAutomationDesktopMenus()");
  assert.equal(scriptItems(app)[0].text, "脚本甲");
  await app.evaluate('handleDesktopMenuAction("automation:alpha:1")');
  await app.evaluate("menuRun; refreshAutomationDesktopMenus()");
  assert.equal(scriptItems(app)[0].text, "脚本甲");
  assert.equal(app.evaluate("automationRuns.size"), 0);
});

test("录屏和选区菜单根据当前状态切换文字与图标", async () => {
  const app = await menuHarness();
  const menuItem = (id) => JSON.parse(app.evaluate(`JSON.stringify(
    menus.at(-1).items.find((item) => item.id === "${id}")
  )`));

  assert.equal(menuItem("record").text, "开始录屏");
  assert.equal(menuItem("record").icon, "StatusAvailable");
  assert.equal(menuItem("toggle").text, "显示选区");
  assert.equal(menuItem("toggle").icon, "RevealFreestanding");

  await app.evaluate(`
    setRecordingActive(true);
    setIndicatorEnabled(true);
    new WebviewWindow("indicator");
    refreshAutomationDesktopMenus();
  `);
  assert.equal(menuItem("record").text, "停止录屏");
  assert.equal(menuItem("record").icon, "StopProgress");
  assert.equal(menuItem("toggle").text, "隐藏选区");
  assert.equal(menuItem("toggle").icon, "Remove");
  assert.equal(app.calls.at(-1).args.recordingActive, true);
  assert.equal(app.calls.at(-1).args.indicatorVisible, true);

  await app.evaluate(`
    setRecordingBusy(true);
    refreshAutomationDesktopMenus();
  `);
  assert.equal(menuItem("record").text, "正在停止录屏");
  assert.equal(menuItem("record").icon, "StatusPartiallyAvailable");
  assert.equal(menuItem("record").enabled, false);
  assert.equal(app.calls.at(-1).args.recordingBusy, true);
});

test("停止中的菜单禁用，并忽略滞后的重复点击", async () => {
  const app = await menuHarness();
  await app.evaluate(`
    globalThis.toggleCalls = [];
    setAutomationMenuAction(async (id) => { toggleCalls.push(id); });
    automationRuns.set("alpha:1", { cancelled: true });
    refreshAutomationDesktopMenus();
  `);
  assert.deepEqual(scriptItems(app)[0], {
    id: "automation:alpha:1", text: "脚本甲", enabled: false,
  });
  await app.evaluate('handleDesktopMenuAction("automation:alpha:1")');
  assert.equal(app.evaluate("toggleCalls.length"), 0);
  await app.evaluate('handleDesktopMenuAction("automation:beta")');
  assert.equal(app.evaluate("toggleCalls[0]"), "beta");
});

test("菜单刷新失败后允许重试最新状态", async () => {
  const app = await menuHarness();
  await app.evaluate(`
    globalThis.originalMenuNew = Menu.new;
    Menu.new = async () => { throw new Error("暂时失败"); };
    automationScripts[0].name = "恢复后名称";
    refreshAutomationDesktopMenus();
  `);
  await app.evaluate("Menu.new = originalMenuNew; refreshAutomationDesktopMenus()");
  assert.equal(scriptItems(app)[0].text, "恢复后名称");
});
