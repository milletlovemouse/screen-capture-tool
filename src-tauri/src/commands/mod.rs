//! 前端可调用的 Tauri 命令，按领域分文件。
pub mod audio;
pub mod automation_cancel;
pub mod capture;
pub mod files;
pub mod input;
pub mod permissions;
pub mod recording;
pub mod window_level;

/// 前端同步的托盘自动化脚本及运行状态。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(serde::Deserialize)]
pub struct TrayAutomationMenuItem {
    pub id: String,
    pub name: String,
    pub running: bool,
    pub stopping: bool,
}

/// 等待主线程更新 macOS 状态栏菜单；其他平台保留可调用的空实现。
#[tauri::command]
pub async fn update_tray_menu(
    app: tauri::AppHandle,
    items: Vec<TrayAutomationMenuItem>,
    recording_active: bool,
    recording_busy: bool,
    indicator_visible: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel::<Result<(), String>>();
        let menu_app = app.clone();
        app.run_on_main_thread(move || {
            // 在主线程将原生菜单错误转为 String，避免跨线程传递非 Send 错误。
            let result = crate::platform::macos::update_tray_menu(
                &menu_app,
                &items,
                recording_active,
                recording_busy,
                indicator_visible,
            );
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            items,
            recording_active,
            recording_busy,
            indicator_visible,
        );
        Ok(())
    }
}
