use std::cell::RefCell;

use muda::{ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use objc2::{
    ffi::class_addMethod,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSMenu};
use tauri::{Emitter, Manager};

thread_local! {
    // AppKit 在主线程查询菜单；持续持有菜单，保证返回的原生指针有效。
    static DOCK_MENU: RefCell<Option<Menu>> = const { RefCell::new(None) };
}

/// 返回 Dock 所需的原生菜单，不转移所有权。
unsafe extern "C-unwind" fn application_dock_menu(
    _: &AnyObject,
    _: Sel,
    _: &NSApplication,
) -> *mut NSMenu {
    DOCK_MENU.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(std::ptr::null_mut(), |menu| menu.ns_menu().cast())
    })
}

/// 补充 Tao delegate 的 Dock 菜单入口，保留其原有生命周期处理。
pub fn install() -> Result<(), Box<dyn std::error::Error>> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| std::io::Error::other("Dock 菜单必须在主线程初始化"))?;
    let app = NSApplication::sharedApplication(mtm);
    let delegate = app
        .delegate()
        .ok_or_else(|| std::io::Error::other("未找到应用 delegate"))?;
    let object: &AnyObject = (*delegate).as_ref();
    let class = object.class();
    let selector = sel!(applicationDockMenu:);
    if class.instance_method(selector).is_some() {
        return Err(std::io::Error::other("应用已经注册 Dock 菜单，无法重复安装").into());
    }

    let menu = Menu::new();
    for (id, text) in [
        ("dock.capture", "立即截图"),
        ("dock.pick", "框选区域"),
        ("dock.record", "开始/停止录屏"),
        ("dock.toggle", "显示/隐藏选区框"),
    ] {
        menu.append(&MenuItem::with_id(id, text, true, None))?;
    }
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id(
        "dock.settings",
        "打开主窗口",
        true,
        None,
    ))?;
    // Dock 自带“退出”项，无需重复添加。

    // SAFETY: 回调签名与 applicationDockMenu: 的 id(id, SEL, id) ABI 一致；
    // 仅补充尚未实现的 selector，不替换 Tao delegate 或它已有的方法。
    let added = unsafe {
        let imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSApplication) -> *mut NSMenu,
            Imp,
        >(application_dock_menu);
        class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            imp,
            c"@@:@".as_ptr(),
        )
        .as_bool()
    };
    if !added {
        return Err(std::io::Error::other("注册 Dock 菜单失败").into());
    }
    DOCK_MENU.with(|slot| *slot.borrow_mut() = Some(menu));
    // Tao 在 setup 前已设置 delegate；重新绑定同一对象，刷新 AppKit 的可选方法缓存。
    app.setDelegate(None);
    app.setDelegate(Some(&delegate));
    Ok(())
}

/// 将 Dock 点击交给主窗口已有的截图、录屏等操作。
pub fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if let Some(action) = event.id().as_ref().strip_prefix("dock.") {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.emit("desktop-menu-action", action) {
                eprintln!("发送 Dock 菜单操作失败：{error}");
            }
        }
    }
}

/// 点击 Dock 图标时恢复隐藏或最小化的主窗口。
pub fn reopen(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
