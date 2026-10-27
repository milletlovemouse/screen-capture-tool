//! 录屏状态与命令：平台录屏任务的启动、停止与清理。
use std::path::PathBuf;
use std::sync::Mutex;

use crate::commands::automation_cancel::AutomationState;
use crate::commands::files::{sanitize_file_stem, unique_path};
#[cfg(target_os = "macos")]
use crate::platform::macos_ffi::CGPreflightScreenCaptureAccess;
#[cfg(target_os = "macos")]
use crate::platform::macos_recording;
#[cfg(target_os = "windows")]
use crate::platform::windows_recording;
use crate::screen::{capture_coordinates, pick_monitor};

pub enum RecordingProcess {
    #[cfg(target_os = "macos")]
    Mac(macos_recording::Recording, String),
    #[cfg(target_os = "windows")]
    Windows(windows_recording::Recording, String),
}

/// 录屏进程状态：保存平台录屏任务与输出路径。
pub struct RecState(pub Mutex<Option<RecordingProcess>>);

impl Drop for RecState {
    fn drop(&mut self) {
        let Ok(mut guard) = self.0.lock() else {
            return;
        };
        let Some(process) = guard.take() else {
            return;
        };
        let _ = stop_recording_process(process);
    }
}

/// 停止平台任务并将原生采集或封装错误传给调用方。
pub fn stop_recording_process(process: RecordingProcess) -> Result<String, String> {
    match process {
        #[cfg(target_os = "macos")]
        RecordingProcess::Mac(recording, path) => {
            recording.stop()?;
            Ok(path)
        }
        #[cfg(target_os = "windows")]
        RecordingProcess::Windows(recording, path) => {
            recording.stop()?;
            Ok(path)
        }
    }
}

/// 清理 Windows 已结束任务；macOS 保留错误至停止或再次启动时返回。
pub fn clear_finished_recording(guard: &mut Option<RecordingProcess>) {
    #[cfg(target_os = "macos")]
    // 保留失败任务，供 stop 返回原生错误，而不是丢失失败原因。
    let _ = &guard;
    #[cfg(target_os = "windows")]
    if let Some(RecordingProcess::Windows(recording, _)) = guard.as_ref() {
        if recording.is_finished() {
            if let Some(process) = guard.take() {
                let _ = stop_recording_process(process);
            }
        }
    }
}
/// 录制预设区域或主屏：macOS 保存 MOV，Windows 原生编码为 MP4。
// 保留既有平铺 IPC 参数；两个 State 参数由 Tauri 注入，不改变调用格式。
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn start_recording(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    dir: String,
    prefix: String,
    audio_source_id: Option<String>,
    audio_enabled: Option<bool>,
    hardware_encoding: Option<bool>,
    state: tauri::State<RecState>,
    run_id: Option<String>,
    automation_state: tauri::State<AutomationState>,
) -> Result<String, String> {
    let operation = automation_state.operation(run_id.as_deref())?;
    operation.check()?;
    let audio_source_id = audio_source_id.as_deref().unwrap_or("system");
    let audio_enabled = audio_enabled.unwrap_or(false);
    // 编码策略仅供 Windows 使用；旧调用未传值时默认允许硬件加速。
    #[cfg(target_os = "macos")]
    let _ = hardware_encoding;
    let mut guard = state.0.lock().map_err(|_| "录制状态异常".to_string())?;
    clear_finished_recording(&mut guard);
    #[cfg(target_os = "macos")]
    if matches!(guard.as_ref(), Some(RecordingProcess::Mac(recording, _)) if recording.is_finished())
    {
        if let Some(process) = guard.take() {
            stop_recording_process(process)?;
        }
    }
    if guard.is_some() {
        return Err("已在录制中".into());
    }
    let dir_path = PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("创建目录失败: {e}"))?;
    let dir_path = dir_path
        .canonicalize()
        .map_err(|e| format!("读取保存目录失败：{e}"))?;
    let base = if prefix.trim().is_empty() {
        "recording".to_string()
    } else {
        sanitize_file_stem(&prefix)
    };
    let monitor = pick_monitor()?;
    let rect = if width > 0 && height > 0 {
        capture_coordinates(&monitor, x, y, width, height)?
    } else {
        (
            0,
            0,
            monitor.width().map_err(|e| e.to_string())?,
            monitor.height().map_err(|e| e.to_string())?,
        )
    };
    #[cfg(target_os = "macos")]
    {
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err("请先授予屏幕录制权限并重启应用".into());
        }
        let path = unique_path(&dir_path, &base, "mov");
        operation.check()?;
        let recording =
            macos_recording::Recording::start(&path, rect, audio_source_id, audio_enabled)?;
        let path_str = path.to_string_lossy().into_owned();
        let process = RecordingProcess::Mac(recording, path_str.clone());
        if let Err(error) = operation.check() {
            let _ = stop_recording_process(process);
            return Err(error);
        }
        *guard = Some(process);
        Ok(path_str)
    }
    #[cfg(target_os = "windows")]
    {
        let path = unique_path(&dir_path, &base, "mp4");
        operation.check()?;
        let recording = windows_recording::Recording::start(
            &path,
            rect,
            audio_source_id,
            audio_enabled,
            hardware_encoding.unwrap_or(true),
        )?;
        let path_str = path.to_string_lossy().into_owned();
        let process = RecordingProcess::Windows(recording, path_str.clone());
        if let Err(error) = operation.check() {
            let _ = stop_recording_process(process);
            return Err(error);
        }
        *guard = Some(process);
        Ok(path_str)
    }
}

/// 停止对应平台的录屏并等待文件写入完成。
#[tauri::command(async)]
pub fn stop_recording(state: tauri::State<RecState>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "录制状态异常".to_string())?;
    let process = guard.take().ok_or("当前没有在录制".to_string())?;
    stop_recording_process(process)
}

/// 查询当前是否正在录屏
#[tauri::command]
pub fn is_recording(state: tauri::State<RecState>) -> bool {
    let Ok(mut guard) = state.0.lock() else {
        return false;
    };
    clear_finished_recording(&mut guard);
    #[cfg(target_os = "macos")]
    if let Some(RecordingProcess::Mac(recording, _)) = guard.as_ref() {
        return !recording.is_finished();
    }
    guard.is_some()
}
