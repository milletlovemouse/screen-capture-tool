//! 平台相关实现：系统框架声明、macOS 集成与 Windows 原生输入/录屏。
pub mod key_mapping;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub mod macos_ffi;
#[cfg(target_os = "windows")]
pub mod windows_input;
#[cfg(target_os = "windows")]
pub mod windows_recording;
