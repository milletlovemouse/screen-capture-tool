import { exit } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { $ } from "../core/dom.js";
import { getCloseAction, setCloseAction } from "../core/settings.js";
import { IS_MAC } from "../shared/platform.js";

let closePromptOpen = false;

function hideClosePrompt() {
  closePromptOpen = false;
  $("close-prompt").hidden = true;
  $("close-remember").checked = false;
}

function showClosePrompt() {
  if (closePromptOpen) return;
  closePromptOpen = true;
  $("close-prompt").hidden = false;
  document.querySelector(".close-prompt-panel").focus();
}

async function applyCloseAction(action) {
  if ($("close-remember").checked) setCloseAction(action);
  else setCloseAction("");

  hideClosePrompt();
  if (action === "quit") {
    await exit(0);
    return;
  }
  await getCurrentWindow().hide();
}

export function setupWindowClose() {
  $("close-background-label").textContent = IS_MAC ? "隐藏到菜单栏" : "最小化到托盘";
  $("close-prompt-dismiss").addEventListener("click", hideClosePrompt);
  $("close-to-tray").addEventListener("click", () => {
    void applyCloseAction("tray");
  });
  $("close-quit").addEventListener("click", () => {
    void applyCloseAction("quit");
  });
  $("close-prompt").addEventListener("click", (event) => {
    if (event.target === $("close-prompt")) hideClosePrompt();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !closePromptOpen) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideClosePrompt();
  }, true);

  getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    const action = getCloseAction();
    if (action === "quit") {
      await exit(0);
    } else if (action === "tray") {
      await getCurrentWindow().hide();
    } else {
      showClosePrompt();
    }
  });
}
