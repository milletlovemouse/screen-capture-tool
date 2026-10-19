import { getCurrentWindow } from "@tauri-apps/api/window";

// 根据实际停止方式展示提示；按键标识仅作说明，不接收点击。
async function initAutomationStatus() {
  const self = getCurrentWindow();
  const mode = new URLSearchParams(location.search).get("mode");
  document.getElementById("automation-status-escape").hidden = mode !== "escape";
  document.getElementById("automation-status-shortcut").hidden = mode === "escape";
  // 创建方负责隐藏创建、穿透后显示；子窗口不能绕过主窗口的捕获锁自行显示。
  // 置顶与内容保护通过创建选项设置，避免加载后才生效的竞态及重复授权。
  try {
    await self.setVisibleOnAllWorkspaces(true);
  } catch {
    /* 部分平台不支持跨工作区显示 */
  }
}

initAutomationStatus();
