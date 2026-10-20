//! 当前桌面内辅助窗口的原生层级控制。
use tauri::Manager;

/// 将选区相关窗口提升到置顶主窗口之上，不修改跨桌面属性。
#[tauri::command]
pub async fn raise_capture_auxiliary_window(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    if !matches!(label.as_str(), "indicator" | "overlay") {
        return Err("仅允许提升选区相关窗口".into());
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };

    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGWindowLevelForKey(key: i32) -> i32;
        }

        let native_window = window.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let result = (|| {
                    let pointer = native_window
                        .ns_window()
                        .map_err(|error| error.to_string())?;
                    // SAFETY: 主线程上刚取得当前存活窗口的 NSWindow 指针。
                    unsafe {
                        let object = &*(pointer as *const objc2::runtime::AnyObject);
                        let level = CGWindowLevelForKey(10) as isize + 1;
                        let _: () = objc2::msg_send![object, setLevel: level];
                        let visible: bool = objc2::msg_send![object, isVisible];
                        if visible {
                            let _: () = objc2::msg_send![object, orderFrontRegardless];
                        }
                    }
                    Ok::<(), String>(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())??;
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // SAFETY: HWND 属于当前存活的 Tauri 窗口；不改变位置、尺寸或激活状态。
        let raised = unsafe {
            SetWindowPos(
                hwnd.0 as _,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
        if raised == 0 {
            return Err(format!(
                "提升选区窗口失败：{}",
                std::io::Error::last_os_error()
            ));
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = window;

    Ok(())
}
