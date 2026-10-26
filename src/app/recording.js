import { invoke } from "@tauri-apps/api/core";
import { getAudioEnabled, getAudioSourceId } from "../core/settings.js";
import { $, setStatus } from "../core/dom.js";
import { notifySavedFile } from "./capture.js";
import { regionPayload } from "./region.js";
import { acquireCaptureOverlays } from "./capture-overlays.js";
import { requestDesktopMenuRefresh } from "./desktop-menu-state.js";
import {
  automationRecordingRun,
  recordingActive,
  recordingBusy,
  setRecordingActive,
  setRecordingBusy,
} from "../core/state.js";

let recordingOverlayLease = null;
let recordingMonitorTimer = null;
let recordingMonitorGeneration = 0;

// 用代次丢弃旧查询结果；停止/重启期间不会由旧轮询覆盖新录制状态。
export function startRecordingMonitor() {
  stopRecordingMonitor();
  const generation = recordingMonitorGeneration;
  const check = async () => {
    try {
      if (!recordingBusy && recordingActive) {
        const active = await invoke("is_recording");
        if (generation !== recordingMonitorGeneration) return;
        if (active === false && !recordingBusy) {
          setRecordingBusy(true);
          const run = automationRecordingRun;
          if (run) {
            run.recording = false;
            run.cancelled = true;
          }
          setRecordingActive(false);
          try {
            await restoreIndicatorAfterRecording();
          } finally {
            setRecordingBusy(false);
            updateRecUI();
          }
          return;
        }
      }
    } catch {
      /* 查询失败不等同于录制已结束，下次继续确认。 */
    }
    if (generation === recordingMonitorGeneration && recordingActive) {
      recordingMonitorTimer = setTimeout(check, 500);
    }
  };
  recordingMonitorTimer = setTimeout(check, 500);
}

export function stopRecordingMonitor() {
  recordingMonitorGeneration += 1;
  if (recordingMonitorTimer) clearTimeout(recordingMonitorTimer);
  recordingMonitorTimer = null;
}

// 按当前录屏状态刷新首页按钮
export function updateRecUI() {
  void requestDesktopMenuRefresh();
  const btn = $("record-toggle");
  const label = $("rec-label");
  if (!btn) return;
  btn.disabled = recordingBusy || Boolean(automationRecordingRun);
  btn.classList.toggle("recording", recordingActive);
  if (label) label.textContent = recordingActive ? "停止录屏" : "开始录屏";
}

// 录屏前隐藏常驻选区，避免红色虚线被录进画面
export async function hideIndicatorForRecording() {
  if (!recordingOverlayLease) recordingOverlayLease = await acquireCaptureOverlays();
}

// 录屏结束后恢复之前显示的选区
export async function restoreIndicatorAfterRecording() {
  const release = recordingOverlayLease;
  recordingOverlayLease = null;
  if (release) await release();
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
  $("record-toggle")?.removeAttribute("title");
  try {
    if (recordingActive) {
      stopRecordingMonitor();
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
        await invoke("start_recording", {
          x, y, width, height, dir, prefix,
          audioEnabled: getAudioEnabled(),
          audioSourceId: getAudioSourceId(),
        });
      } catch (e) {
        await restoreIndicatorAfterRecording();
        throw e;
      }
      setRecordingActive(true);
      startRecordingMonitor();
      updateRecUI();
      setStatus("正在录屏…（再次点击停止并保存）", "ok");
    }
  } catch (e) {
    const button = $("record-toggle");
    if (button) button.title = String(e);
    setStatus(`录屏操作失败：${e}`, "err");
  } finally {
    setRecordingBusy(false);
    updateRecUI();
  }
}
