//! 录屏状态与命令：平台录屏任务的启动、停止与清理。
use std::path::PathBuf;
use std::sync::Mutex;

use crate::commands::files::{sanitize_file_stem, unique_path};
#[cfg(target_os = "macos")]
use crate::platform::macos_ffi::CGPreflightScreenCaptureAccess;
#[cfg(target_os = "windows")]
use crate::platform::windows_recording;
use crate::screen::{capture_coordinates, pick_monitor};

pub enum RecordingProcess {
    #[cfg(target_os = "macos")]
    Mac(std::process::Child, String),
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

pub fn stop_recording_process(process: RecordingProcess) -> Result<String, String> {
    match process {
        #[cfg(target_os = "macos")]
        RecordingProcess::Mac(mut child, path) => {
            let signal = std::process::Command::new("/bin/kill")
                .arg("-INT")
                .arg(child.id().to_string())
                .status();
            if !matches!(signal, Ok(status) if status.success()) {
                let _ = child.kill();
            }
            child.wait().map_err(|e| format!("等待录屏保存失败：{e}"))?;
            if !std::path::Path::new(&path).is_file() {
                return Err("录屏没有生成文件，请检查屏幕录制权限".into());
            }
            Ok(path)
        }
        #[cfg(target_os = "windows")]
        RecordingProcess::Windows(recording, path) => {
            recording.stop()?;
            Ok(path)
        }
    }
}

pub fn clear_finished_recording(guard: &mut Option<RecordingProcess>) {
    #[cfg(target_os = "macos")]
    if let Some(RecordingProcess::Mac(child, _)) = guard.as_mut() {
        if child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(false)
        {
            guard.take();
        }
    }
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
#[tauri::command(async)]
pub fn start_recording(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    dir: String,
    prefix: String,
    state: tauri::State<RecState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "录制状态异常".to_string())?;
    clear_finished_recording(&mut guard);
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
        let (x, y, width, height) = rect;
        let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
        cmd.arg("-v")
            .arg("-x")
            .arg(format!("-R{x},{y},{width},{height}"))
            .arg(&path);
        let child = cmd.spawn().map_err(|e| format!("启动录屏失败: {e}"))?;
        let path_str = path.to_string_lossy().into_owned();
        *guard = Some(RecordingProcess::Mac(child, path_str.clone()));
        Ok(path_str)
    }
    #[cfg(target_os = "windows")]
    {
        let path = unique_path(&dir_path, &base, "mp4");
        let recording = windows_recording::Recording::start(&path, rect)?;
        let path_str = path.to_string_lossy().into_owned();
        *guard = Some(RecordingProcess::Windows(recording, path_str.clone()));
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
    guard.is_some()
}
