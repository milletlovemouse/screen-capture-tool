import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";

const selection = document.getElementById("selection");
const sizeLabel = document.getElementById("size-label");
const loupe = document.getElementById("loupe");
const loupeInfo = document.getElementById("loupe-info");
const virtualPointer = document.getElementById("virtual-pointer");
const ctx = loupe.getContext("2d");
const self = getCurrentWindow();

// 放大镜取样用的离屏画布（接收后端返回的小块 RGBA）
const regionCanvas = document.createElement("canvas");
const regionCtx = regionCanvas.getContext("2d");

const LOUPE_SIZE = 150; // 放大镜尺寸(px)
const SRC_SPAN = 30; // 取样的源区域边长（逻辑像素，越大放大倍数越低，此处约 5x）

let startX = 0;
let startY = 0;
let pointerX = 0;
let pointerY = 0;
let dragging = false;
let keyboardMode = false; // 方向键微调时为 true，此时才显示虚拟指针
let lastCursorX = null;
let lastCursorY = null;
let running = true;
let origin = { x: 0, y: 0 };
let bounds = { width: window.innerWidth, height: window.innerHeight };

// 覆盖主屏、跨桌面可见
async function initCover() {
  try {
    const [w, h] = await invoke("primary_size");
    bounds = { width: w, height: h };
    await self.setPosition(new LogicalPosition(0, 0));
    await self.setSize(new LogicalSize(w, h));
  } catch {
    /* 取不到尺寸时保持创建时的大小 */
  }
  await self.setAlwaysOnTop(true);
  try {
    await self.setVisibleOnAllWorkspaces(true);
  } catch {
    /* 非 macOS 可忽略 */
  }
  try {
    await self.setCursorIcon("crosshair"); // 强制系统指针为十字
  } catch {
    /* 不支持时退回 CSS 的 crosshair */
  }
  await self.setFocus();
  const position = await self.innerPosition();
  const scale = await self.scaleFactor();
  origin = { x: position.x / scale, y: position.y / scale };
}

function rectFrom(x1, y1, x2, y2) {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

// 更新框选终点（拖拽或方向键移动共用）
function updateSelectionEnd() {
  const r = rectFrom(startX, startY, pointerX, pointerY);
  selection.style.left = r.left - origin.x + "px";
  selection.style.top = r.top - origin.y + "px";
  selection.style.width = r.width + "px";
  selection.style.height = r.height + "px";
  sizeLabel.style.left = r.left - origin.x + "px";
  sizeLabel.style.top = Math.max(0, r.top - origin.y - 22) + "px";
  sizeLabel.textContent = `${Math.round(r.width)} x ${Math.round(r.height)}`;
}

// 绘制放大镜内容：把小块画面放大并画准星（内容按帧刷新）
function renderLoupeContent(originX, originY, imageData) {
  regionCanvas.width = imageData.width;
  regionCanvas.height = imageData.height;
  regionCtx.putImageData(imageData, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  ctx.drawImage(
    regionCanvas,
    0,
    0,
    imageData.width,
    imageData.height,
    0,
    0,
    LOUPE_SIZE,
    LOUPE_SIZE,
  );

  // 指针在取样块内的相对位置（可能贴边不在正中）
  const fx = ((pointerX - originX) / SRC_SPAN) * LOUPE_SIZE;
  const fy = ((pointerY - originY) / SRC_SPAN) * LOUPE_SIZE;
  const cell = LOUPE_SIZE / SRC_SPAN;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1;
  ctx.strokeRect(fx - cell / 2 + 0.5, fy - cell / 2 + 0.5, cell, cell);
  ctx.strokeStyle = "rgba(255,0,0,0.85)";
  ctx.beginPath();
  ctx.moveTo(fx, 0);
  ctx.lineTo(fx, LOUPE_SIZE);
  ctx.moveTo(0, fy);
  ctx.lineTo(LOUPE_SIZE, fy);
  ctx.stroke();
}

// 放大镜位置/读数/虚拟指针：随指针高频更新，保证跟随顺滑
function placeLoupe() {
  const off = 20;
  const localX = pointerX - origin.x;
  const localY = pointerY - origin.y;
  let lx = localX + off;
  let ly = localY + off;
  if (lx + LOUPE_SIZE > window.innerWidth) lx = localX - off - LOUPE_SIZE;
  if (ly + LOUPE_SIZE > window.innerHeight) ly = localY - off - LOUPE_SIZE;
  loupe.style.left = lx + "px";
  loupe.style.top = ly + "px";
  loupe.style.display = "block";

  loupeInfo.textContent = dragging
    ? `${Math.round(Math.abs(pointerX - startX))} x ${Math.round(Math.abs(pointerY - startY))}`
    : `(${Math.round(pointerX)}, ${Math.round(pointerY)})`;
  loupeInfo.style.left = lx + "px";
  loupeInfo.style.top = ly + LOUPE_SIZE + 2 + "px";
  loupeInfo.style.display = "block";

  // 虚拟指针仅在方向键模式下显示，避免被实时取样拍进放大镜
  if (keyboardMode) {
    virtualPointer.style.left = `${localX}px`;
    virtualPointer.style.top = `${localY}px`;
    virtualPointer.style.display = "block";
  } else {
    virtualPointer.style.display = "none";
  }
}

// 轮询：跟随真实鼠标（跨桌面也生效，无需先点一下），并实时刷新放大镜画面
async function tick() {
  try {
    const [lx, ly] = await invoke("cursor_position");
    // 真实鼠标移动则跟随并退出方向键模式；静止时保留方向键微调的位置
    if (lx !== lastCursorX || ly !== lastCursorY) {
      lastCursorX = lx;
      lastCursorY = ly;
      pointerX = Math.max(0, Math.min(bounds.width, lx));
      pointerY = Math.max(0, Math.min(bounds.height, ly));
      keyboardMode = false;
    }
    if (dragging) updateSelectionEnd();

    const res = await invoke("capture_around", {
      cx: Math.round(pointerX),
      cy: Math.round(pointerY),
      span: SRC_SPAN,
    });
    const bytes = new Uint8Array(res);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const originX = view.getUint32(0, true);
    const originY = view.getUint32(4, true);
    const w = view.getUint32(8, true);
    const h = view.getUint32(12, true);
    const img = new ImageData(
      new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 16, w * h * 4),
      w,
      h,
    );
    renderLoupeContent(originX, originY, img);
    placeLoupe();
  } catch {
    /* 单帧取样失败忽略，下一帧继续 */
  }
}

// 用 requestAnimationFrame 驱动：每帧刷新一次放大镜内容，天然限频、不空转
async function loop() {
  if (!running) return;
  await tick();
  if (running) requestAnimationFrame(loop);
}

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  startX = pointerX = e.clientX + origin.x;
  startY = pointerY = e.clientY + origin.y;
  selection.style.display = "block";
  sizeLabel.style.display = "block";
});

// 鼠标移动即时更新指针与选区/放大镜位置，内容由取样循环按帧刷新，避免跟随掉帧
window.addEventListener("mousemove", (e) => {
  lastCursorX = pointerX = e.clientX + origin.x;
  lastCursorY = pointerY = e.clientY + origin.y;
  keyboardMode = false;
  if (dragging) updateSelectionEnd();
  placeLoupe();
});

window.addEventListener("mouseup", async (e) => {
  if (!dragging || e.button !== 0) return;
  if (!keyboardMode) {
    pointerX = e.clientX + origin.x;
    pointerY = e.clientY + origin.y;
  }
  dragging = false;
  const r = rectFrom(startX, startY, pointerX, pointerY);
  if (r.width < 2 || r.height < 2) {
    running = false;
    await self.close();
    return;
  }
  // 回传主窗口（逻辑坐标）
  await emit("region-selected", {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
  running = false;
  await self.close();
});

// 键盘：Esc 取消；方向键微调指针位置
window.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") {
    running = false;
    await self.close();
    return;
  }
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    keyboardMode = true;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowUp") pointerY -= step;
    if (e.key === "ArrowDown") pointerY += step;
    if (e.key === "ArrowLeft") pointerX -= step;
    if (e.key === "ArrowRight") pointerX += step;
    pointerX = Math.max(0, Math.min(bounds.width, pointerX));
    pointerY = Math.max(0, Math.min(bounds.height, pointerY));
    if (dragging) updateSelectionEnd();
  }
});

window.addEventListener("beforeunload", () => { running = false; });
initCover().then(loop).catch(console.error);
