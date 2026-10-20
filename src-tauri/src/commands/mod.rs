//! 前端可调用的 Tauri 命令，按领域分文件。
pub mod automation_cancel;
pub mod capture;
pub mod files;
pub mod input;
pub mod permissions;
pub mod recording;
pub mod window_level;

/// 前端同步的 Dock 自动化脚本及运行状态。
// 跨平台保留相同 IPC 参数结构，字段仅由 macOS Dock 实现读取。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(serde::Deserialize)]
pub struct DockAutomationMenuItem {
    pub id: String,
    pub name: String,
    pub running: bool,
    pub stopping: bool,
}

/// 等待主线程更新 Dock 自动化菜单；其他平台保留可调用的空实现。
#[tauri::command]
pub async fn update_dock_automation_menu(
    app: tauri::AppHandle,
    items: Vec<DockAutomationMenuItem>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel::<Result<(), String>>();
        app.run_on_main_thread(move || {
            // 在主线程将原生菜单错误转为 String，避免跨线程传递非 Send 错误。
            let result = crate::platform::dock_menu::update_automation_menu(&items);
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, items);
        Ok(())
    }
}
