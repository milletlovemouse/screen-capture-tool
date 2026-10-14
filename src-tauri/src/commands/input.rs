//! 模拟输入：鼠标位置、点击与键盘序列。
#[cfg(target_os = "macos")]
use crate::platform::macos_ffi::*;
#[cfg(target_os = "windows")]
use crate::screen::{capture_scale, pick_monitor};
#[cfg(target_os = "windows")]
use crate::platform::windows_input;

/// 单个模拟按键：平台相关键码、修饰键标志位和物理键位。
#[derive(serde::Deserialize)]
pub struct KeyStroke {
    pub keycode: u16,
    #[serde(default)]
    pub flags: u64,
}

/// 读取当前鼠标位置，返回主屏逻辑坐标。
#[tauri::command]
pub fn cursor_position() -> Result<(i32, i32), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return Err("无法读取鼠标位置".into());
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Ok((point.x.round() as i32, point.y.round() as i32))
    }

    #[cfg(target_os = "windows")]
    {
        windows_input::cursor(capture_scale(&pick_monitor()?)?)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("当前平台暂不支持读取系统鼠标位置".into())
    }
}

/// 在指定屏幕坐标模拟一次鼠标左键点击。
#[tauri::command]
pub fn simulate_click(x: i32, y: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        if !AXIsProcessTrusted() {
            return Err("请先在设置中授予辅助功能权限".into());
        }
        const HID_EVENT_TAP: u32 = 0;
        const LEFT_MOUSE_DOWN: u32 = 1;
        const LEFT_MOUSE_UP: u32 = 2;
        const LEFT_BUTTON: u32 = 0;
        let point = CGPoint {
            x: x as f64,
            y: y as f64,
        };
        let down = CGEventCreateMouseEvent(std::ptr::null(), LEFT_MOUSE_DOWN, point, LEFT_BUTTON);
        let up = CGEventCreateMouseEvent(std::ptr::null(), LEFT_MOUSE_UP, point, LEFT_BUTTON);
        if down.is_null() || up.is_null() {
            if !down.is_null() {
                CFRelease(down);
            }
            if !up.is_null() {
                CFRelease(up);
            }
            return Err("无法创建鼠标点击事件，请检查辅助功能权限".into());
        }
        CGEventPost(HID_EVENT_TAP, down);
        CGEventPost(HID_EVENT_TAP, up);
        CFRelease(down);
        CFRelease(up);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        windows_input::click(x, y, capture_scale(&pick_monitor()?)?)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (x, y);
        Err("当前平台暂不支持模拟鼠标点击".into())
    }
}

/// 依次模拟一组键盘按键（含修饰键），用于自动化脚本的键盘输入节点。
#[tauri::command]
pub fn simulate_keys(keys: Vec<KeyStroke>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        if !AXIsProcessTrusted() {
            return Err("请先在设置中授予辅助功能权限".into());
        }
        const HID_EVENT_TAP: u32 = 0;
        for key in &keys {
            let down = CGEventCreateKeyboardEvent(std::ptr::null(), key.keycode, true);
            let up = CGEventCreateKeyboardEvent(std::ptr::null(), key.keycode, false);
            if down.is_null() || up.is_null() {
                if !down.is_null() {
                    CFRelease(down);
                }
                if !up.is_null() {
                    CFRelease(up);
                }
                return Err("无法创建键盘事件，请检查辅助功能权限".into());
            }
            CGEventSetFlags(down, key.flags);
            CGEventSetFlags(up, key.flags);
            CGEventPost(HID_EVENT_TAP, down);
            CGEventPost(HID_EVENT_TAP, up);
            CFRelease(down);
            CFRelease(up);
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        windows_input::keys(&keys)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = keys;
        Err("当前平台暂不支持模拟键盘输入".into())
    }
}
