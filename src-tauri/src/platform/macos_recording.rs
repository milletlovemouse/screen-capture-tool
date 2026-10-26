//! 编译期链接的 Swift 录屏桥接；所有权由 Recording 管理。
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;

use crate::commands::audio::AudioSource;

extern "C" {
    fn sct_audio_sources() -> *mut c_char;
    fn sct_record_start(
        path: *const c_char,
        source: *const c_char,
        audio_enabled: bool,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        error: *mut *mut c_char,
    ) -> *mut c_void;
    fn sct_record_stop(handle: *mut c_void) -> *mut c_char;
    fn sct_record_finished(handle: *mut c_void) -> bool;
    fn sct_string_free(value: *mut c_char);
}

/// 复制并释放 Swift 返回的 UTF-8 字符串。
fn take_string(value: *mut c_char) -> String {
    if value.is_null() {
        return String::new();
    }
    unsafe {
        let result = CStr::from_ptr(value).to_string_lossy().into_owned();
        sct_string_free(value);
        result
    }
}

/// 读取系统音频源和稳定的麦克风 uniqueID。
pub fn list_sources() -> Result<Vec<AudioSource>, String> {
    let json = take_string(unsafe { sct_audio_sources() });
    let devices: Vec<serde_json::Value> =
        serde_json::from_str(&json).map_err(|e| format!("读取音频设备失败：{e}"))?;
    devices
        .into_iter()
        .map(|device| {
            let field = |key| {
                device[key]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "原生音频设备信息不完整".to_string())
            };
            Ok(AudioSource {
                id: field("id")?,
                name: field("name")?,
                kind: field("kind")?,
            })
        })
        .collect()
}

pub struct Recording(*mut c_void);

// Swift 对录制状态的所有访问均在专用串行队列上执行。
unsafe impl Send for Recording {}

impl Recording {
    /// 启动主屏指定逻辑区域，仅在启用音频时采集所选来源。
    pub fn start(
        path: &Path,
        rect: (u32, u32, u32, u32),
        source: &str,
        audio_enabled: bool,
    ) -> Result<Self, String> {
        let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let source = CString::new(source).map_err(|e| e.to_string())?;
        let mut error = std::ptr::null_mut();
        let handle = unsafe {
            sct_record_start(
                path.as_ptr(),
                source.as_ptr(),
                audio_enabled,
                rect.0,
                rect.1,
                rect.2,
                rect.3,
                &mut error,
            )
        };
        if handle.is_null() {
            return Err(take_string(error));
        }
        Ok(Self(handle))
    }

    /// 查询原生采集是否发生异步错误。
    pub fn is_finished(&self) -> bool {
        unsafe { sct_record_finished(self.0) }
    }

    /// 停止采集并等待音视频封装完成。
    pub fn stop(mut self) -> Result<(), String> {
        let handle = std::mem::replace(&mut self.0, std::ptr::null_mut());
        let error = take_string(unsafe { sct_record_stop(handle) });
        if error.is_empty() {
            Ok(())
        } else {
            Err(error)
        }
    }
}

impl Drop for Recording {
    /// 异常退出作用域时仍释放原生采集设备。
    fn drop(&mut self) {
        if !self.0.is_null() {
            let _ = take_string(unsafe { sct_record_stop(self.0) });
        }
    }
}
