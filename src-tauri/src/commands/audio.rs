//! 可录制音频设备的跨平台命令。
#[derive(serde::Serialize)]
pub struct AudioSource {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// 枚举系统声音和原生麦克风设备。
#[tauri::command(async)]
pub fn list_audio_sources() -> Result<Vec<AudioSource>, String> {
    #[cfg(target_os = "macos")]
    return crate::platform::macos_recording::list_sources();
    #[cfg(target_os = "windows")]
    return crate::platform::windows_audio::list_sources();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("当前平台不支持录屏音频".into())
}
