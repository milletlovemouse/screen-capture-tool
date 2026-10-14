import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission as requestNotificationPermission,
} from "@tauri-apps/plugin-notification";
import { IS_MAC } from "../shared/platform";
import { $, setStatus } from "../core/dom.js";

// 权限名称，用于提醒文案
export const PERMISSION_NAMES = {
  screen: "屏幕录制",
  accessibility: "辅助功能（设备控制）",
  notification: "通知",
};

// 返回仍未授权的权限键列表
export function missingPermissions(status) {
  return Object.keys(PERMISSION_NAMES).filter((key) => !status?.[key]);
}

// 更新单个权限行的状态显示
function applyPermissionRow(key, granted) {
  const row = document.querySelector(`.permission-row[data-perm="${key}"]`);
  const label = $(`perm-${key}-status`);
  const button = $(`perm-${key}-btn`);
  if (!row || !label) return;
  if (!IS_MAC && (key === "screen" || key === "accessibility")) {
    label.textContent = "无需单独授权";
    label.className = "permission-status granted";
    if (button) button.hidden = true;
    row.classList.add("is-granted");
    return;
  }
  row.classList.toggle("is-granted", granted);
  label.textContent = granted ? "已授权" : "未授权";
  label.className = "permission-status " + (granted ? "granted" : "denied");
  if (button) button.textContent = !IS_MAC && key === "notification" ? "系统通知设置" : granted ? "已授权" : "请求权限";
}

// 检查并刷新权限状态，未授权则在设置页提醒
export async function refreshPermissions() {
  let status = { screen: true, accessibility: true };
  try {
    status = await invoke("check_permissions");
  } catch {
    // 非 Tauri 环境（如浏览器预览）无法检查，视为已具备
  }
  let notification = true;
  try {
    notification = await isPermissionGranted();
  } catch {
    // 通知插件不可用时不提醒
  }
  status = { ...status, notification };
  applyPermissionRow("screen", !!status.screen);
  applyPermissionRow("accessibility", !!status.accessibility);
  applyPermissionRow("notification", !!status.notification);
  const missing = missingPermissions(status);
  const hint = $("permission-hint");
  if (hint) {
    hint.hidden = missing.length === 0;
    if (missing.length) {
      hint.textContent =
        `尚未授予：${missing.map((k) => PERMISSION_NAMES[k]).join("、")}。` +
        (IS_MAC ? "请点击“请求权限”授权；屏幕录制授权后需重启应用生效。"
          : "请在 Windows 系统设置中检查通知设置。");
    }
  }
  return status;
}

// 请求某项权限，失败则引导到系统设置
async function requestPermission(key) {
  try {
    if (!IS_MAC) {
      await invoke("open_privacy_settings", { section: key });
      return;
    }
    let granted;
    if (key === "notification") {
      granted = (await requestNotificationPermission()) === "granted";
    } else {
      const command =
        key === "screen" ? "request_screen_permission" : "request_accessibility_permission";
      granted = await invoke(command);
    }
    applyPermissionRow(key, granted);
    if (!granted) {
      try {
        await invoke("open_privacy_settings", { section: key });
      } catch {
        /* 打开系统设置失败时仍给出提示 */
      }
      const suffix = key === "screen" ? "后重启应用" : "";
      setStatus(`请在系统设置中开启「${PERMISSION_NAMES[key]}」权限${suffix}`, "err");
    } else {
      setStatus(`已获得「${PERMISSION_NAMES[key]}」权限`, "ok");
    }
  } catch (e) {
    setStatus(`请求权限失败：${e}`, "err");
  }
  await refreshPermissions();
}

export function setupPermissions() {
  $("perm-refresh").addEventListener("click", () => refreshPermissions());
  $("perm-screen-btn").addEventListener("click", () => requestPermission("screen"));
  $("perm-accessibility-btn").addEventListener("click", () =>
    requestPermission("accessibility")
  );
  $("perm-notification-btn").addEventListener("click", () =>
    requestPermission("notification")
  );
}
