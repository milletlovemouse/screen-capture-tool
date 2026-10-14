//! 系统权限：状态查询、授权请求与系统设置跳转。
#[cfg(target_os = "macos")]
use crate::platform::macos_ffi::*;

/// 权限检查结果：屏幕录制与辅助功能（设备控制）。
#[derive(serde::Serialize)]
pub struct PermissionStatus {
    screen: bool,
    accessibility: bool,
}
/// 检查屏幕录制与辅助功能权限的当前状态（非 macOS 视为已具备）。
#[tauri::command]
pub fn check_permissions() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        PermissionStatus {
            screen: CGPreflightScreenCaptureAccess(),
            accessibility: AXIsProcessTrusted(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus {
            screen: true,
            accessibility: true,
        }
    }
}

/// 请求屏幕录制权限，触发系统授权弹窗，返回当前是否已授权。
#[tauri::command]
pub fn request_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGRequestScreenCaptureAccess()
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 请求辅助功能（设备控制）权限，触发系统授权弹窗，返回当前是否已授权。
#[tauri::command]
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        let trusted = AXIsProcessTrustedWithOptions(options);
        if !options.is_null() {
            CFRelease(options);
        }
        trusted
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 打开系统设置中对应的隐私面板（section: screen / accessibility / notification）。
#[tauri::command]
pub fn open_privacy_settings(section: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match section.as_str() {
            "screen" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
                    .to_string()
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                    .to_string()
            }
            "notification" => {
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension".to_string()
            }
            _ => return Err("未知的权限面板".into()),
        };
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("打开系统设置失败: {e}"))?;
        if !status.success() {
            return Err("系统设置未能打开".into());
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let uri = match section.as_str() {
            "notification" => "ms-settings:notifications",
            "screen" => "ms-settings:privacy-graphicsCaptureProgrammatic",
            "accessibility" => "ms-settings:easeofaccess",
            _ => return Err("未知的权限面板".into()),
        };
        std::process::Command::new("explorer.exe")
            .arg(uri)
            .spawn()
            .map_err(|e| format!("打开系统设置失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = section;
        Err("当前平台无需额外授权".into())
    }
}
