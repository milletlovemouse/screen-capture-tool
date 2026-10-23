//! 跨平台桌面菜单事件转发。
use tauri::{Emitter, Manager};

/// 将托盘菜单点击转发给主窗口已有的操作入口。
pub fn handle_tray_menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    let action = event.id().as_ref();
    let is_tray_action = matches!(
        action,
        "capture" | "pick" | "record" | "toggle" | "settings" | "quit"
    ) || action.starts_with("automation:");
    if !is_tray_action {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.emit("desktop-menu-action", action) {
            eprintln!("发送桌面菜单操作失败：{error}");
        }
    }
}
