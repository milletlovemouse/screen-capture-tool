//! 平台相关实现：系统框架声明、原生菜单与 Windows 原生输入/录屏。
#[cfg(target_os = "macos")]
pub mod dock_menu;
pub mod key_mapping;
#[cfg(target_os = "macos")]
pub mod macos_ffi;
#[cfg(target_os = "windows")]
pub mod windows_input;
#[cfg(target_os = "windows")]
pub mod windows_recording;
