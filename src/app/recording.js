import { invoke } from "@tauri-apps/api/core";
import { $, setStatus, sleep } from "../core/dom.js";
import { notifySavedFile } from "./capture.js";
import { broadcastRegion, getIndicator, regionPayload } from "./region.js";
import {
  automationRecordingRun,
  recordingActive,
  recordingBusy,
  recordingHidIndicator,
  setRecordingActive,
  setRecordingBusy,
  setRecordingHidIndicator,
} from "../core/state.js";

// 按当前录屏状态刷新首页按钮
export function updateRecUI() {
  const btn = $("record-toggle");
  const label = $("rec-label");
  if (!btn) return;
  btn.disabled = recordingBusy || Boolean(automationRecordingRun);
  btn.classList.toggle("recording", recordingActive);
  if (label) label.textContent = recordingActive ? "停止录屏" : "开始录屏";
}

// 录屏前隐藏常驻选区框，避免红色虚线被录进画面
export async function hideIndicatorForRecording() {
  try {
    const ind = await getIndicator();
    if (ind && (await ind.isVisible())) {
      setRecordingHidIndicator(true);
      await ind.hide();
      await sleep(60);
    }
  } catch {
    /* 无选区框或查询失败时忽略，不影响录屏 */
  }
}

// 录屏结束后恢复之前显示的选区框
export async function restoreIndicatorAfterRecording() {
  if (!recordingHidIndicator) return;
  setRecordingHidIndicator(false);
  try {
    const ind = await getIndicator();
    if (ind) {
      await ind.show();
      broadcastRegion();
    }
  } catch {
    /* 恢复失败时忽略 */
  }
}

// 开始/停止录屏（录制预设区域，无区域则录主屏）
export async function toggleRecording() {
  if (recordingBusy) return;
  const dir = $("dir").value.trim();
  if (!recordingActive && !dir) {
    return;
  }
  if (automationRecordingRun) {
    setStatus("自动化正在录制，请使用自动化脚本按钮停止执行", "err");
    return;
  }
  setRecordingBusy(true);
  updateRecUI();
  try {
    if (recordingActive) {
      let path;
      try {
        path = await invoke("stop_recording");
      } finally {
        setRecordingActive(false);
        await restoreIndicatorAfterRecording();
      }
      setStatus(`录屏已保存：${path}`, "ok");
      try {
        await notifySavedFile("录屏完成", path);
      } catch {
        /* 通知权限未开启时忽略 */
      }
    } else {
      const { x, y, width, height } = regionPayload();
      const prefix = $("prefix").value || "recording";
      await hideIndicatorForRecording();
      try {
        await invoke("start_recording", { x, y, width, height, dir, prefix });
      } catch (e) {
        await restoreIndicatorAfterRecording();
        throw e;
      }
      setRecordingActive(true);
      updateRecUI();
      setStatus("正在录屏…（再次点击停止并保存）", "ok");
    }
  } catch (e) {
    setStatus(`录屏操作失败：${e}`, "err");
  } finally {
    setRecordingBusy(false);
    updateRecUI();
  }
}
