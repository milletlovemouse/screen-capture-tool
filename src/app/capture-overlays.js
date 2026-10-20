import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { sleep } from "../core/dom.js";
import { automationRuns, recordingActive, recordingBusy, automationRecordingRun } from "../core/state.js";

let captureOverlayQueue = Promise.resolve();
const captureOverlayOwners = new Set();
const captureOverlayRestore = new Set();

// 等待原生窗口完成创建，避免随后捕获查不到仍在创建中的覆盖层。
export async function waitCaptureWindowCreated(win) {
  let listeners = [];
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("窗口创建超时")), 5000);
      listeners = [
        win.once("tauri://created", resolve),
        win.once("tauri://error", (event) => reject(new Error(String(event.payload)))),
      ];
      for (const listener of listeners) listener.catch(reject);
    });
  } catch (error) {
    await win.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    for (const listener of listeners) {
      void listener.then((unlisten) => unlisten()).catch(() => {});
    }
  }
}

// 窗口创建、隐藏和恢复共用队列，避免截图与录屏相互提前恢复窗口。
export function withCaptureOverlayLock(action) {
  const result = captureOverlayQueue.then(action);
  captureOverlayQueue = result.catch(() => {});
  return result;
}

export function captureOverlaysBlocked() {
  return captureOverlayOwners.size > 0 || recordingActive || recordingBusy || Boolean(automationRecordingRun);
}

// 选区/取点期间不启动捕获，避免将覆盖层拍入结果。
export async function assertNoCapturePicker() {
  for (const label of ["overlay", "point-picker"]) {
    if (await WebviewWindow.getByLabel(label)) throw new Error("请先完成或取消框选/取点");
  }
}

// 每个捕获任务独立持有租约，隐藏失败时禁止继续捕获。
export function acquireCaptureOverlays() {
  return withCaptureOverlayLock(async () => {
    await assertNoCapturePicker();
    const owner = Symbol("capture");
    captureOverlayOwners.add(owner);
    try {
      let hidden = false;
      for (const label of ["indicator", "automation-status"]) {
        const win = await WebviewWindow.getByLabel(label);
        if (win && await win.isVisible()) {
          captureOverlayRestore.add(label);
          await win.hide();
          hidden = true;
        }
      }
      if (hidden) await sleep(80);
    } catch (error) {
      captureOverlayOwners.delete(owner);
      if (!captureOverlayOwners.size) await restoreCaptureOverlayWindows();
      throw error;
    }
    let released = false;
    return () => withCaptureOverlayLock(async () => {
      if (released) return;
      released = true;
      captureOverlayOwners.delete(owner);
      if (!captureOverlayOwners.size) await restoreCaptureOverlayWindows();
    });
  });
}

// 仅恢复原本显示的窗口；录制中创建的状态窗由运行任务决定是否显示。
async function restoreCaptureOverlayWindows() {
  if (automationRuns.size) captureOverlayRestore.add("automation-status");
  for (const label of captureOverlayRestore) {
    if (label === "automation-status" && !automationRuns.size) continue;
    try {
      const win = await WebviewWindow.getByLabel(label);
      if (win) {
        await win.show();
        if (label === "indicator") {
          await invoke("raise_capture_auxiliary_window", { label });
        }
      }
    } catch {
      /* 恢复失败不能覆盖捕获结果，也不能阻塞其他租约释放 */
    }
  }
  captureOverlayRestore.clear();
}

// 用户主动隐藏或清空选区后，不在任务结束时重新显示。
export function forgetCaptureOverlay(label) {
  captureOverlayRestore.delete(label);
}
