import { invoke } from "@tauri-apps/api/core";
import { getAudioEnabled, getAudioSourceId } from "../../core/settings.js";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { $, setStatus, sleep } from "../../core/dom.js";
import { doCapture, notifySavedFile } from "../capture.js";
import { regionPayload } from "../region.js";
import { refreshAutomationDesktopMenus } from "../tray.js";
import {
  hideIndicatorForRecording,
  restoreIndicatorAfterRecording,
  updateRecUI,
  startRecordingMonitor,
  stopRecordingMonitor,
} from "../recording.js";
import {
  cloneAutomation,
  saveAutomationRunSettings,
  updateAutomationRunUI,
} from "./model.js";
import {
  prepareAutomationSafety,
  releaseAutomationSafety,
} from "./safety.js";
import {
  automationHomeControls,
  automationRecordingRun,
  automationRuns,
  automationScripts,
  recordingActive,
  recordingBusy,
  setAutomationRecordingRun,
  setRecordingActive,
} from "../../core/state.js";

let automationRunSequence = 0;

// 允许结束快捷键及时中断等待或定时录制
async function cancellableAutomationWait(ms, run) {
  let remain = Math.max(0, Number(ms) || 0);
  while (remain > 0 && !run.cancelled) {
    const chunk = Math.min(50, remain);
    await sleep(chunk);
    remain -= chunk;
  }
}

// 停止自动化占用的录屏资源，统一处理状态与选区恢复。
async function stopAutomationRecording(run) {
  if (!run.recording) return;
  stopRecordingMonitor();
  run.recording = false;
  try {
    run.lastSavedPath = await invoke("stop_recording");
  } finally {
    setRecordingActive(false);
    await restoreIndicatorAfterRecording();
    if (automationRecordingRun === run) setAutomationRecordingRun(null);
    updateRecUI();
  }
}

export async function runAutomation(script) {
  if (automationRuns.has(script.id)) return;
  const countInput = automationHomeControls.get(script.id)?.countInput;
  if (script.runMode === "count" && countInput) {
    if (!countInput.reportValidity() ||
        !saveAutomationRunSettings(script.id, script.runMode, Number(countInput.value))) return;
  }
  script = cloneAutomation(script);
  if (!script.steps.length) {
    setStatus("自动化失败：脚本没有配置步骤", "err");
    return;
  }
  if (script.runMode === "count" &&
      (!Number.isSafeInteger(script.runCount) || script.runCount < 1)) {
    setStatus("自动化失败：执行次数必须为大于 0 的整数", "err");
    return;
  }
  const run = { cancelled: false, recording: false, completedRuns: 0 };
  run.runId = `${script.id}:${Date.now()}:${++automationRunSequence}`;
  // 注册完成前的取消由启动路径检查；原生任务已开始时通知后端停止后续工作。
  run.requestCancel = () => {
    run.cancelled = true;
    void refreshAutomationDesktopMenus();
    if (run.nativeReady) {
      void invoke("cancel_automation_operation", { runId: run.runId }).catch(() => {});
    }
  };
  let finishRun;
  run.finished = new Promise((resolve) => { finishRun = resolve; });
  automationRuns.set(script.id, run);
  void refreshAutomationDesktopMenus();
  setStatus(`正在执行：${script.name}`, "ok");
  try {
    updateAutomationRunUI(script.id);
    if (!(await prepareAutomationSafety(script))) return;
    if (run.cancelled) return;
    await invoke("begin_automation_operation", { runId: run.runId });
    run.nativeReady = true;
    if (run.cancelled) run.requestCancel();
    const totalRuns =
      script.runMode === "loop"
        ? Number.POSITIVE_INFINITY
        : script.runMode === "count"
          ? script.runCount
          : 1;
    let completedRuns = 0;
    while (!run.cancelled && completedRuns < totalRuns) {
      for (const step of script.steps) {
        if (run.cancelled) break;
        await runStep(step, run);
      }
      if (run.cancelled) break;
      completedRuns += 1;
      run.completedRuns = completedRuns;
      updateAutomationRunUI(script.id);
      if (script.runMode !== "once") {
        setStatus(
          script.runMode === "loop"
            ? `正在循环执行：${script.name}（第 ${completedRuns} 次）`
            : `正在执行：${script.name}（${completedRuns}/${totalRuns}）`,
          "ok"
        );
      }
      // 每轮让出事件循环，零等待节点也能响应停止指令。
      if (completedRuns < totalRuns) await cancellableAutomationWait(50, run);
    }
    if (run.cancelled) {
      setStatus(`已停止自动化：${script.name}`, "");
    } else {
      setStatus(`自动化完成：${script.name}`, "ok");
      try {
        if (run.lastSavedPath) {
          await notifySavedFile("自动化完成", run.lastSavedPath, `${script.name}，点击查看最后保存的文件`);
        } else {
          sendNotification({ title: "自动化完成", body: script.name });
        }
      } catch {
        /* 忽略通知权限 */
      }
    }
  } catch (e) {
    if (run.recording) {
      try {
        await stopAutomationRecording(run);
      } catch {
        /* 忽略停止录制错误 */
      }
    }
    setStatus(`自动化失败：${e}`, "err");
  } finally {
    if (run.recording) {
      try {
        await stopAutomationRecording(run);
      } catch {
        /* 忽略清理录制错误 */
      }
    }
    if (automationRecordingRun === run) {
      await restoreIndicatorAfterRecording();
      setAutomationRecordingRun(null);
      updateRecUI();
    }
    automationRuns.delete(script.id);
    void refreshAutomationDesktopMenus();
    try {
      if (run.nativeReady) {
        await invoke("end_automation_operation", { runId: run.runId }).catch(() => {});
      }
      await releaseAutomationSafety();
    } finally {
      finishRun();
      updateAutomationRunUI(script.id);
    }
  }
}

// 执行单个步骤，录制类步骤负责自己的资源回收。
async function runStep(step, run) {
  if (step.type === "click") {
    await invoke("simulate_click", { x: Number(step.x) || 0, y: Number(step.y) || 0, runId: run.runId });
  } else if (step.type === "keys") {
    const keys = (step.keys || []).map((key) => ({
      keycode: Number(key.keycode) || 0,
      flags: Number(key.flags) || 0,
    }));
    if (keys.length) await invoke("simulate_keys", { keys, runId: run.runId });
  } else if (step.type === "wait") {
    await cancellableAutomationWait(step.ms, run);
  } else if (step.type === "capture") {
    run.lastSavedPath = await doCapture({ notify: false, throwOnError: true, runId: run.runId });
  } else if (step.type === "record") {
    const { x, y, width, height } = regionPayload();
    const dir = $("dir").value.trim();
    if (!dir) throw new Error("请先在设置里选择保存目录");
    if (recordingActive || recordingBusy || automationRecordingRun) throw new Error("当前已有录屏正在进行");
    setAutomationRecordingRun(run);
    await hideIndicatorForRecording();
    if (run.cancelled) return;
    try {
      await invoke("start_recording", {
        audioEnabled: getAudioEnabled(),
        audioSourceId: getAudioSourceId(),
        x,
        y,
        width,
        height,
        dir,
        prefix: $("prefix").value || "recording",
        runId: run.runId,
      });
    } catch (error) {
      await restoreIndicatorAfterRecording();
      throw error;
    }
    run.recording = true;
    setAutomationRecordingRun(run);
    setRecordingActive(true);
    startRecordingMonitor();
    updateRecUI();
    try {
      await cancellableAutomationWait(
        Math.max(0, Number(step.duration) || 0) * 1000,
        run
      );
    } finally {
      await stopAutomationRecording(run);
    }
  }
}

// 由执行循环统一停止录屏，避免两个停止请求竞争。
export async function stopAutomation(id) {
  const run = automationRuns.get(id);
  if (!run) return;
  run.requestCancel();
  updateAutomationRunUI(id);
  await run.finished;
}

// 首页按钮和快捷键共用启停入口。
export async function toggleAutomation(id) {
  if (automationRuns.has(id)) {
    await stopAutomation(id);
  } else {
    const script = automationScripts.find((item) => item.id === id);
    if (script) await runAutomation(script);
  }
}
