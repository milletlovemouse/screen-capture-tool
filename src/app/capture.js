import { invoke } from "@tauri-apps/api/core";
import { onAction, registerActionTypes } from "@tauri-apps/plugin-notification";
import { $, setStatus, sleep } from "../core/dom.js";
import { getIndicator, regionPayload } from "./region.js";

let notificationActionsReady = null;
const SAVED_FILE_ACTION_TYPE = "saved-file";
const OPEN_SAVED_FILE_ACTION = "open-saved-file";

// 点击通知时定位该次保存的文件，不受后续保存设置变化影响。
export async function handleNotificationAction(event) {
  const path = event.notification?.extra?.savedPath;
  if (!["tap", OPEN_SAVED_FILE_ACTION].includes(event.actionId) ||
      typeof path !== "string" || !path) return;
  try {
    await invoke("reveal_saved_file", { path });
  } catch (error) {
    setStatus(`打开保存位置失败：${error}`, "err");
  }
}

// 共享一个监听器，确保发送前已绑定，避免每次截图重复注册。
export async function notifySavedFile(title, path, body) {
  if (!notificationActionsReady) {
    // 当前 macOS 通知后端需有动作按钮才会等待响应，正文点击也依赖此配置。
    notificationActionsReady = registerActionTypes([{
      id: SAVED_FILE_ACTION_TYPE,
      actions: [{ id: OPEN_SAVED_FILE_ACTION, title: "打开保存位置" }],
    }]).then(() => onAction(handleNotificationAction)).catch((error) => {
      notificationActionsReady = null;
      throw error;
    });
  }
  await notificationActionsReady;
  // 直接等待插件命令，避免 Web Notification 包装器丢弃发送错误。
  await invoke("plugin:notification|notify", {
    options: {
      title,
      body: body || `已保存到 ${path}，点击打开保存位置`,
      actionTypeId: SAVED_FILE_ACTION_TYPE,
      extra: { savedPath: path },
    },
  });
}

// 执行一次截图：读取区域与命名，调用后端命令并自增编号
export async function doCapture({ notify = true, throwOnError = false } = {}) {
  const dir = $("dir").value.trim();
  if (!dir) {
    setStatus("请先选择保存目录", "err");
    if (throwOnError) throw new Error("请先选择保存目录");
    return;
  }
  const { x, y, width, height } = regionPayload();
  const prefix = $("prefix").value || "screenshot";

  // 截图前临时隐藏选区框，避免红框被拍进图里
  let indicator = null;
  let indicatorWasVisible = false;
  try {
    indicator = await getIndicator();
    if (indicator && (await indicator.isVisible())) {
      indicatorWasVisible = true;
      await indicator.hide();
      await sleep(80);
    }
  } catch {
    // 选区窗口查询失败时仍继续截图，避免影响核心操作。
  }

  try {
    const path = await invoke("capture_region", {
      x,
      y,
      width,
      height,
      dir,
      prefix,
    });
    setStatus(`已保存：${path}`, "ok");
    if (notify) {
      try {
        await notifySavedFile("截图成功", path);
      } catch {
        // 系统通知权限未开启时，保留界面状态提示，不影响截图结果
      }
    }
    return path;
  } catch (e) {
    setStatus(`截图失败：${e}`, "err");
    if (throwOnError) throw e;
    return null;
  } finally {
    if (indicatorWasVisible && indicator) {
      try {
        await indicator.show();
      } catch {
        // 恢复窗口失败不应覆盖已经完成的截图结果。
      }
    }
  }
}
