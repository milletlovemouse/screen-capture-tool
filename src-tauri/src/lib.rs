//! 应用入口：声明模块并组装 Tauri Builder。
use std::sync::Mutex;

mod commands;
mod platform;
mod screen;

use commands::recording::{stop_recording_process, RecState};
// windows_input 以 crate::KeyStroke / crate::key_mapping 引用这两项，
// 同时供 checks/windows 检查工程复用同一路径。
pub use commands::input::KeyStroke;
pub use platform::key_mapping;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::automation_cancel::AutomationState::default())
        .manage(RecState(Mutex::new(None)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|_app, _event| {
            #[cfg(target_os = "macos")]
            platform::macos::handle_tray_menu_event(_app, _event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::update_tray_menu,
            commands::automation_cancel::begin_automation_operation,
            commands::automation_cancel::cancel_automation_operation,
            commands::automation_cancel::end_automation_operation,
            commands::capture::capture_region,
            commands::capture::capture_around,
            commands::input::cursor_position,
            commands::input::simulate_click,
            commands::input::simulate_keys,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::is_recording,
            commands::window_level::raise_capture_auxiliary_window,
            commands::files::reveal_saved_file,
            commands::files::open_external_url,
            commands::permissions::check_permissions,
            commands::permissions::request_screen_permission,
            commands::permissions::request_accessibility_permission,
            commands::permissions::open_privacy_settings,
            screen::primary_size
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                platform::macos::reopen(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Ok(mut state) = app.state::<RecState>().0.lock() {
                    if let Some(recording) = state.take() {
                        let _ = stop_recording_process(recording);
                    }
                }
            }
        });
}
