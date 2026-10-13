import { listen, emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { regionHit, adjustRegion } from "./region-geometry";

const self = getCurrentWindow();
const box = document.querySelector(".indicator-box");
const label = document.getElementById("label");
const cursors = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  move: "move",
};
let region = null;
let bounds;
let drag = null;
let hover = "";
let interactive = false;
let updating = false;
let running = true;
let origin = { x: 0, y: 0 };

// macOS 可能将窗口下移到菜单栏下方，统一将局部坐标换算为屏幕坐标。
function screenPoint(event) {
  return { x: event.clientX + origin.x, y: event.clientY + origin.y };
}

async function syncOrigin() {
  const position = await self.innerPosition();
  const scale = window.devicePixelRatio || 1;
  origin = { x: position.x / scale, y: position.y / scale };
  render();
}

// 只更新 DOM，拖动期间不移动原生窗口，保持指针捕获稳定。
function render() {
  box.hidden = !region;
  if (!region) return;
  Object.assign(box.style, {
    left: `${region.x - origin.x}px`, top: `${region.y - origin.y}px`,
    width: `${region.width}px`, height: `${region.height}px`,
  });
  label.textContent = `${region.width} × ${region.height}`;
}

// 串行切换穿透状态，避免异步请求乱序让整屏意外拦截点击。
async function syncInteraction() {
  if (updating) return;
  updating = true;
  try {
    while (interactive !== Boolean(drag || hover)) {
      const next = Boolean(drag || hover);
      await self.setIgnoreCursorEvents(!next);
      interactive = next;
    }
  } catch (error) {
    console.error("选区交互状态更新失败", error);
  } finally {
    updating = false;
  }
}

// 接近边缘时显示控制点并使用对应的缩放光标。
function setHover(hit) {
  hover = hit;
  document.body.style.cursor = cursors[drag?.hit || hit] || "default";
  box.classList.toggle("adjustable", Boolean(drag || hit));
  box.dataset.edge = drag?.hit || hit;
  void syncInteraction();
}

// 隐藏时降低检测频率；不截图、不重叠发送鼠标查询。
async function pollCursor() {
  let visible = false;
  try {
    visible = await self.isVisible();
    if (!visible) {
      if (drag) finishDrag(false);
      setHover("");
    } else if (!drag && region) {
      const [x, y] = await invoke("cursor_position");
      if (!drag) {
        setHover(regionHit(region, x, y));
      }
    }
  } catch {
    if (!drag) setHover("");
  } finally {
    if (running) setTimeout(pollCursor, visible ? 80 : 400);
  }
}

// 结束或撤销本次拖动；只在松开时保存一次。
function finishDrag(commit) {
  if (!drag) return;
  const previous = drag;
  drag = null;
  if (!commit) region = previous.region;
  if (document.body.hasPointerCapture(previous.pointerId)) {
    document.body.releasePointerCapture(previous.pointerId);
  }
  render();
  setHover("");
  if (commit) void emitTo("main", "region-adjusted", region).catch(console.error);
}

// 覆盖主屏以接收边框外侧的拖动，内部默认保持鼠标穿透。
async function init() {
  await self.setIgnoreCursorEvents(true);
  const [width, height] = await invoke("primary_size");
  bounds = { width, height };
  await self.setPosition(new LogicalPosition(0, 0));
  await self.setSize(new LogicalSize(width, height));
  await syncOrigin();
  await self.onMoved(() => { void syncOrigin().catch(console.error); });
  await self.setAlwaysOnTop(true);
  try {
    await self.setVisibleOnAllWorkspaces(true);
  } catch { /* 非 macOS 可忽略 */ }

  for (const hit of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const handle = document.createElement("span");
    handle.className = `region-handle handle-${hit}`;
    box.append(handle);
  }
  await listen("region-geometry", ({ payload }) => {
    if (drag) finishDrag(false);
    region = payload.width > 0 && payload.height > 0 ? payload : null;
    setHover("");
    render();
  });
  await emitTo("main", "indicator-ready");
  void pollCursor();
}

document.body.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag) return;
  const point = screenPoint(event);
  const hit = regionHit(region, point.x, point.y);
  if (!hit) { setHover(""); return; }
  event.preventDefault();
  drag = {
    hit, x: point.x, y: point.y, region: { ...region },
    pointerId: event.pointerId,
  };
  document.body.setPointerCapture(event.pointerId);
  setHover(hit);
  void self.setFocus().catch(console.error);
});

document.body.addEventListener("pointermove", (event) => {
  const point = screenPoint(event);
  if (!drag) {
    setHover(regionHit(region, point.x, point.y));
    return;
  }
  region = adjustRegion(drag.region, drag.hit, point.x - drag.x, point.y - drag.y, bounds);
  render();
});

document.body.addEventListener("pointerup", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const point = screenPoint(event);
  region = adjustRegion(drag.region, drag.hit, point.x - drag.x, point.y - drag.y, bounds);
  finishDrag(true);
});
document.body.addEventListener("pointercancel", () => finishDrag(false));
document.body.addEventListener("lostpointercapture", () => finishDrag(false));
window.addEventListener("blur", () => finishDrag(false));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drag) {
    event.preventDefault();
    finishDrag(false);
  }
});
window.addEventListener("beforeunload", () => { running = false; });
init().catch(console.error);
