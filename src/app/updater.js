import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import appIconUrl from "../../app-icon.png";
import { $, setStatus } from "../core/dom.js";
import { getSkippedUpdateVersion, setSkippedUpdateVersion } from "../core/settings.js";

let availableUpdate = null;
let currentVersion = "";
let updateChecking = false;
let updateInstalling = false;

function setUpdateButtonsDisabled(disabled) {
  for (const id of ["update-cancel", "update-skip", "update-confirm"]) {
    const button = $(id);
    if (button) button.disabled = disabled;
  }
}

function hideUpdatePrompt() {
  if (updateInstalling) return;
  $("update-prompt").hidden = true;
}

function showUpdatePrompt(update) {
  $("update-current-version").textContent = `v${currentVersion}`;
  $("update-latest-version").textContent = `v${update.version}`;
  $("update-release-notes").textContent = update.body?.trim() || "此版本暂无更新说明。";
  $("update-progress").hidden = true;
  $("update-progress-bar").style.width = "0%";
  setUpdateButtonsDisabled(false);
  $("update-prompt").hidden = false;
  document.querySelector(".update-prompt-panel").focus();
}

// 读取应用版本、图标与外链，并绑定更新按钮。
export async function setupAbout() {
  const version = $("about-version");
  if (!version) return;
  const brandLogo = $("brand-logo-image");
  const aboutLogo = $("about-logo-image");
  if (brandLogo) brandLogo.src = appIconUrl;
  if (aboutLogo) aboutLogo.src = appIconUrl;
  try {
    currentVersion = await getVersion();
    version.textContent = `版本 v${currentVersion}`;
  } catch {
    version.textContent = "版本信息不可用";
  }
  $("check-update")?.addEventListener("click", () => {
    void checkForUpdates(false);
  });
  $("install-update")?.addEventListener("click", installAvailableUpdate);
  $("update-cancel")?.addEventListener("click", hideUpdatePrompt);
  $("update-skip")?.addEventListener("click", () => {
    if (!availableUpdate || updateInstalling) return;
    setSkippedUpdateVersion(availableUpdate.version);
    hideUpdatePrompt();
  });
  $("update-confirm")?.addEventListener("click", installAvailableUpdate);
  $("update-prompt")?.addEventListener("click", (event) => {
    if (event.target === $("update-prompt")) hideUpdatePrompt();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || $("update-prompt").hidden || updateInstalling) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideUpdatePrompt();
  }, true);
  // webview 不会处理 target=_blank，交给系统默认浏览器打开
  for (const link of document.querySelectorAll("#view-about a[href^='http']")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void invoke("open_external_url", { url: link.href }).catch((error) => {
        setStatus(`打开链接失败：${error}`, "err");
      });
    });
  }
  void checkForUpdates(true);
}

// 更新状态文案：正文保持简短，完整错误放在 title 里便于排查
function setUpdateStatus(text, detail = "") {
  const status = $("update-status");
  if (!status) return;
  status.textContent = text;
  if (detail) status.title = detail;
  else status.removeAttribute("title");
}

// 检查 GitHub Release 中是否有当前架构可用的新版本。
async function checkForUpdates(automatic = false) {
  const checkButton = $("check-update");
  const installButton = $("install-update");
  if (!checkButton || updateChecking || updateInstalling) return;
  updateChecking = true;
  checkButton.disabled = true;
  if (!automatic) setUpdateStatus("正在检查更新…");
  if (installButton) installButton.hidden = true;
  try {
    availableUpdate = await check();
    if (!availableUpdate) {
      if (!automatic) setUpdateStatus("当前已是最新版本");
      return;
    }
    setUpdateStatus(`发现新版本 v${availableUpdate.version}`);
    if (installButton) installButton.hidden = false;
    if (!automatic || availableUpdate.version !== getSkippedUpdateVersion()) {
      showUpdatePrompt(availableUpdate);
    }
  } catch (error) {
    availableUpdate = null;
    if (!automatic) setUpdateStatus("检查更新失败，请稍后重试", String(error));
  } finally {
    updateChecking = false;
    checkButton.disabled = false;
  }
}

// 下载并安装更新，完成后重启应用。
async function installAvailableUpdate() {
  if (!availableUpdate) return;
  const installButton = $("install-update");
  const confirmButton = $("update-confirm");
  const progress = $("update-progress");
  const progressBar = $("update-progress-bar");
  updateInstalling = true;
  if (installButton) installButton.disabled = true;
  if (confirmButton) confirmButton.textContent = "正在更新…";
  setUpdateButtonsDisabled(true);
  if (progress) progress.hidden = false;
  let total = 0;
  let downloaded = 0;
  try {
    await availableUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data?.contentLength || 0;
        downloaded = 0;
        setUpdateStatus("正在下载更新…");
      }
      if (event.event === "Progress") {
        downloaded += event.data?.chunkLength || 0;
        const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
        setUpdateStatus(percent === null ? "正在下载更新…" : `正在下载更新… ${percent}%`);
        if (progressBar && percent !== null) progressBar.style.width = `${percent}%`;
      }
      if (event.event === "Finished") {
        setUpdateStatus("更新下载完成，正在重启…");
        if (progressBar) progressBar.style.width = "100%";
      }
    });
    await relaunch();
  } catch (error) {
    setUpdateStatus("安装更新失败，请稍后重试", String(error));
    updateInstalling = false;
    if (installButton) installButton.disabled = false;
    if (confirmButton) confirmButton.textContent = "更新";
    setUpdateButtonsDisabled(false);
  }
}
