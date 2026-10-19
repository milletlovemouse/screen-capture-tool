import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.js";

// 用原生菜单替身保留真实同步队列、事件分发和执行器。
async function menuHarness() {
  const app = harness();
  await app.evaluate(`
    globalThis.menus = [];
    globalThis.Menu = {
      new: async ({ items }) => ({
        items,
        close: async () => {},
      }),
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

test("托盘和 Dock 同步脚本名称、增删，并避免重复刷新", async () => {
  const app = await menuHarness();
  assert.deepEqual(scriptItems(app), [
    { id: "automation:alpha:1", text: "启动：脚本甲", enabled: true },
    { id: "automation:beta", text: "启动：脚本乙", enabled: true },
  ]);
  assert.equal(app.calls.at(-1).command, "update_dock_automation_menu");
  await app.evaluate("refreshAutomationDesktopMenus()");
  assert.equal(app.evaluate("menus.length"), 1);
  await app.evaluate(`
    automationScripts[0].name = "已改名";
    setAutomationScripts(automationScripts.slice(0, 1));
    refreshAutomationDesktopMenus();
  `);
  assert.deepEqual(scriptItems(app), [
    { id: "automation:alpha:1", text: "启动：已改名", enabled: true },
  ]);
  assert.equal(app.calls.at(-1).args.items[0].name, "已改名");
  await app.evaluate("setAutomationScripts([]); refreshAutomationDesktopMenus()");
  assert.deepEqual(scriptItems(app), []);
  assert.equal(app.calls.at(-1).args.items.length, 0);
});

test("菜单复用真实执行器，运行和停止后状态一致", async () => {
  const app = await menuHarness();
  app.evaluate('globalThis.menuRun = handleDesktopMenuAction("automation:alpha:1")');
  await app.evaluate("refreshAutomationDesktopMenus()");
  assert.equal(scriptItems(app)[0].text, "停止：脚本甲");
  await app.evaluate('handleDesktopMenuAction("automation:alpha:1")');
  await app.evaluate("menuRun; refreshAutomationDesktopMenus()");
  assert.equal(scriptItems(app)[0].text, "启动：脚本甲");
  assert.equal(app.evaluate("automationRuns.size"), 0);
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
    id: "automation:alpha:1", text: "正在停止：脚本甲", enabled: false,
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
  assert.equal(scriptItems(app)[0].text, "启动：恢复后名称");
});
