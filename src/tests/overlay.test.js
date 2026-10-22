import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const overlaySource = (await readFile(new URL("../windows/overlay.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\r?\n/gm, "")
  .replace(/initCover\(\)\.then\(loop\)\.catch\([\s\S]*$/, "");

// 隔离窗口 API，验证主屏覆盖与拖拽越界，不触发真实屏幕捕获。
function overlayHarness(isMac = false) {
  const calls = [];
  const handlers = new Map();
  const elements = new Map();
  const captured = new Set();
  const classes = new Set();
  const monitor = {
    position: { x: 0, y: 0, type: "Physical" },
    size: { width: 2560, height: 1440, type: "Physical" },
    scaleFactor: 1.5,
  };
  const self = Object.fromEntries(
    ["setPosition", "setSize", "setAlwaysOnTop",
      "setVisibleOnAllWorkspaces", "setCursorIcon", "show", "setFocus", "close"]
      .map((name) => [name, async (...args) => { calls.push([name, ...args]); }])
  );
  self.innerPosition = async () => monitor.position;
  self.innerSize = async () => monitor.size;
  self.scaleFactor = async () => monitor.scaleFactor;
  const context = vm.createContext({
    IS_MAC: isMac,
    getCurrentWindow: () => self,
    primaryMonitor: async () => monitor,
    LogicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
    LogicalSize: class { constructor(width, height) { this.width = width; this.height = height; } },
    PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
    PhysicalSize: class { constructor(width, height) { this.width = width; this.height = height; } },
    invoke: async () => [1440, 900],
    emit: async (name, payload) => { calls.push([name, payload]); },
    document: {
      body: {
        classList: { add: (name) => classes.add(name) },
        setPointerCapture: (id) => captured.add(id),
        hasPointerCapture: (id) => captured.has(id),
        releasePointerCapture: (id) => captured.delete(id),
      },
      createElement: () => ({ getContext: () => ({}) }),
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { style: {}, getContext: () => ({}) });
        return elements.get(id);
      },
    },
    window: {
      innerWidth: 1707, innerHeight: 960,
      addEventListener: (name, callback) => handlers.set(name, callback),
    },
  });
  vm.runInContext(overlaySource, context);
  return { calls, handlers, captured, classes, monitor, context };
}

test("Windows overlay overdraws the monitor without native fullscreen", async () => {
  const h = overlayHarness();
  await vm.runInContext("initCover()", h.context);
  assert.equal(h.calls[0][0], "setPosition");
  assert.equal(h.calls[0][1].x, -2);
  assert.equal(h.calls[0][1].y, -2);
  assert.equal(h.calls[1][0], "setSize");
  assert.equal(h.calls[1][1].width, 2564);
  assert.equal(h.calls[1][1].height, 1444);
  assert.equal(h.calls.some(([name]) => name === "setFullscreen"), false);
  assert.ok(h.calls.findIndex(([name]) => name === "show") > 1);
  assert.equal(vm.runInContext("bounds.height", h.context), 960);
});

test("overlay captures the pointer and clips an out-of-bounds release to the screen", async () => {
  const h = overlayHarness();
  await vm.runInContext("initCover()", h.context);
  h.handlers.get("pointerdown")({ button: 0, pointerId: 1, clientX: 10, clientY: 20, preventDefault() {} });
  assert.equal(h.captured.has(1), true);
  await h.handlers.get("pointerup")({ button: 0, pointerId: 1, clientX: 3000, clientY: 2000 });
  assert.equal(h.captured.size, 0);
  const result = h.calls.find(([name]) => name === "region-selected")[1];
  assert.equal(result.height, 940);
  assert.equal(result.width, Math.round(2560 / 1.5 - 10));
});

test("macOS overlay keeps the logical cover without entering native fullscreen", async () => {
  const h = overlayHarness(true);
  await vm.runInContext("initCover()", h.context);
  assert.equal(h.calls.some(([name]) => name === "setFullscreen"), false);
  assert.equal(h.classes.has("overlay-body-windows"), false);
});
