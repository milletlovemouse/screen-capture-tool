use std::cell::RefCell;

use muda::{ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use objc2::{msg_send, runtime::NSObjectProtocol, sel, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage, NSMenuItem};
use objc2_foundation::{NSProcessInfo, NSSize, NSString};
use tauri::menu::{MenuBuilder as AppMenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

use crate::commands::TrayAutomationMenuItem;

const MENU_ICON_SIZE: f64 = 16.0;

/// 设置进程显示名，供开发 Bundle 和系统进程信息使用。
pub fn set_process_display_name() {
    NSProcessInfo::processInfo().setProcessName(&NSString::from_str("截图工具"));
}

/// 在 AppKit 完成启动后固定顶部应用菜单标题，避免启动流程再次覆盖。
pub fn set_application_menu_title() {
    if let Some(mtm) = MainThreadMarker::new() {
        if let Some(main_menu) = NSApplication::sharedApplication(mtm).mainMenu() {
            if let Some(item) = main_menu.itemAtIndex(0) {
                item.setTitle(&NSString::from_str("截图工具"));
            }
        }
    }
}

/// 构建符合 macOS 使用习惯的应用菜单，业务操作继续交给前端现有入口。
pub fn install_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "截图工具")
        .text("app.about", "关于截图工具")
        .text("app.settings", "设置…")
        .text("app.check-updates", "检查更新…")
        .separator()
        .services_with_text("服务")
        .separator()
        .hide_with_text("隐藏截图工具")
        .hide_others_with_text("隐藏其他")
        .show_all_with_text("全部显示")
        .separator()
        .quit_with_text("退出截图工具")
        .build()?;
    let menu = AppMenuBuilder::new(app).item(&app_menu).build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// 将应用菜单中的自定义业务操作转发给主窗口。
pub fn handle_app_menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) -> bool {
    let action = event.id().as_ref();
    if !action.starts_with("app.") {
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.emit("app-menu-action", action) {
            eprintln!("发送应用菜单操作失败：{error}");
        }
    }
    true
}

thread_local! {
    static PENDING_TRAY_MENU: RefCell<Option<Menu>> = const { RefCell::new(None) };
}

/// macOS 27 默认隐藏菜单图片；支持新属性时显式要求显示。
fn force_menu_item_image_visible(item: &NSMenuItem) {
    let selector = sel!(setPreferredImageVisibility:);
    if item.image().is_none() || !item.respondsToSelector(selector) {
        return;
    }
    // SAFETY: selector 存在时参数类型为 NSInteger，Visible 的 SDK 枚举值为 1。
    unsafe {
        let _: () = msg_send![item, setPreferredImageVisibility: 1_isize];
    }
}

/// 为菜单项设置 SF Symbol，并按模板图标适配系统主题。
fn set_menu_item_system_symbol(item: &NSMenuItem, symbol: &str) {
    let name = NSString::from_str(symbol);
    let Some(symbol_image) =
        NSImage::imageWithSystemSymbolName_accessibilityDescription(&name, None)
    else {
        return;
    };
    let source_size = symbol_image.size();
    if source_size.width <= 0.0 || source_size.height <= 0.0 {
        return;
    }
    let scale = (MENU_ICON_SIZE / source_size.width).min(MENU_ICON_SIZE / source_size.height);
    let image = symbol_image
        .TIFFRepresentation()
        .and_then(|data| NSImage::initWithData(NSImage::alloc(), &data))
        .unwrap_or(symbol_image);
    image.setSize(NSSize::new(
        source_size.width * scale,
        source_size.height * scale,
    ));
    image.setTemplate(true);
    item.setImage(Some(&image));
    force_menu_item_image_visible(item);
}

/// 为刚追加的菜单项设置系统图标。
fn set_last_system_symbol(menu: &Menu, symbol: &str) {
    let native_menu = unsafe { &*menu.ns_menu().cast::<objc2_app_kit::NSMenu>() };
    let count = native_menu.numberOfItems();
    if count == 0 {
        return;
    }
    if let Some(item) = native_menu.itemAtIndex(count - 1) {
        set_menu_item_system_symbol(&item, symbol);
    }
}

/// 构建带原生图标的完整状态栏菜单。
fn build_tray_menu(
    items: &[TrayAutomationMenuItem],
    recording_active: bool,
    recording_busy: bool,
    indicator_visible: bool,
) -> Result<Menu, Box<dyn std::error::Error>> {
    let menu = Menu::new();
    for (id, text, symbol) in [
        ("capture", "立即截图", "camera"),
        ("pick", "框选区域", "viewfinder"),
    ] {
        menu.append(&MenuItem::with_id(id, text, true, None))?;
        set_last_system_symbol(&menu, symbol);
    }
    let recording_text = if recording_busy {
        if recording_active {
            "正在停止录屏"
        } else {
            "正在开始录屏"
        }
    } else if recording_active {
        "停止录屏"
    } else {
        "开始录屏"
    };
    menu.append(&MenuItem::with_id(
        "record",
        recording_text,
        !recording_busy,
        None,
    ))?;
    set_last_system_symbol(
        &menu,
        if recording_busy {
            "hourglass"
        } else if recording_active {
            "stop.circle"
        } else {
            "record.circle"
        },
    );
    menu.append(&MenuItem::with_id(
        "toggle",
        if indicator_visible {
            "隐藏选区"
        } else {
            "显示选区"
        },
        true,
        None,
    ))?;
    set_last_system_symbol(
        &menu,
        if indicator_visible {
            "eye.slash"
        } else {
            "eye"
        },
    );
    if !items.is_empty() {
        menu.append(&PredefinedMenuItem::separator())?;
        for item in items {
            menu.append(&MenuItem::with_id(
                format!("automation:{}", item.id),
                &item.name,
                !item.stopping,
                None,
            ))?;
            set_last_system_symbol(
                &menu,
                if item.stopping {
                    "hourglass"
                } else if item.running {
                    "bolt.circle"
                } else {
                    "play.circle"
                },
            );
        }
        menu.append(&PredefinedMenuItem::separator())?;
    }
    menu.append(&MenuItem::with_id("settings", "设置", true, None))?;
    set_last_system_symbol(&menu, "gearshape");
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id("quit", "退出", true, None))?;
    set_last_system_symbol(&menu, "power");
    Ok(menu)
}

/// 替换状态栏托盘持有的原生菜单。
pub fn update_tray_menu(
    app: &tauri::AppHandle,
    items: &[TrayAutomationMenuItem],
    recording_active: bool,
    recording_busy: bool,
    indicator_visible: bool,
) -> Result<(), String> {
    let menu = build_tray_menu(items, recording_active, recording_busy, indicator_visible)
        .map_err(|error| error.to_string())?;
    let tray = app.tray_by_id("main").ok_or("未找到状态栏图标")?;
    PENDING_TRAY_MENU.with(|slot| *slot.borrow_mut() = Some(menu));
    let result = tray
        .with_inner_tray_icon(|tray| {
            PENDING_TRAY_MENU.with(|slot| {
                let menu = slot.borrow_mut().take().ok_or("状态栏菜单尚未就绪")?;
                tray.set_menu(Some(Box::new(menu)));
                Ok::<(), String>(())
            })
        })
        .map_err(|error| error.to_string())?;
    if result.is_err() {
        PENDING_TRAY_MENU.with(|slot| {
            slot.borrow_mut().take();
        });
    }
    result
}

/// 点击 Dock 应用图标时恢复隐藏或最小化的主窗口。
pub fn reopen(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
