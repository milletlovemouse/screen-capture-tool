import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";

const win = getCurrentWindow();

async function init() {
  const [width, height] = await invoke("primary_size");
  await win.setPosition(new LogicalPosition(0, 0));
  await win.setSize(new LogicalSize(width, height));
  await win.setAlwaysOnTop(true);
  try {
    await win.setVisibleOnAllWorkspaces(true);
  } catch {
    /* Windows 不支持跨虚拟桌面置顶 */
  }
  await win.setCursorIcon("crosshair");
  await win.setFocus();
  const position = await win.innerPosition();
  const scale = await win.scaleFactor();
  let selected = false;

  document.body.addEventListener("click", async (event) => {
    if (selected) return;
    selected = true;
    await emit("mouse-position-selected", {
      x: Math.round(event.clientX + position.x / scale),
      y: Math.round(event.clientY + position.y / scale),
    });
    await win.close();
  });

  document.body.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      await win.close();
    }
  });
}

init().catch(console.error);
