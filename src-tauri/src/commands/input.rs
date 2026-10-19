//! 模拟输入：鼠标位置、点击与键盘序列。
use crate::commands::automation_cancel::AutomationState;
#[cfg(any(target_os = "macos", test))]
use crate::commands::automation_cancel::Operation;
#[cfg(target_os = "macos")]
use crate::platform::macos_ffi::*;
#[cfg(target_os = "windows")]
use crate::platform::windows_input;
#[cfg(target_os = "windows")]
use crate::screen::{capture_scale, pick_monitor};

/// 单个模拟按键：平台相关键码、修饰键标志位和物理键位。
#[derive(serde::Deserialize)]
pub struct KeyStroke {
    pub keycode: u16,
    #[serde(default)]
    pub flags: u64,
}

/// 逐键检查取消，单个 stroke 内不得提前返回取消而遗漏 key-up。
#[cfg(any(target_os = "macos", test))]
fn for_each_stroke(
    keys: &[KeyStroke],
    operation: &Operation,
    mut emit: impl FnMut(&KeyStroke) -> Result<(), String>,
) -> Result<(), String> {
    for key in keys {
        operation.with_active(|| emit(key))?;
    }
    operation.check()
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
#[tauri::command(async)]
pub fn simulate_click(
    x: i32,
    y: i32,
    run_id: Option<String>,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    let operation = state.operation(run_id.as_deref())?;
    operation.check()?;
    #[cfg(target_os = "macos")]
    return operation.with_active(|| unsafe {
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
    });

    #[cfg(target_os = "windows")]
    {
        let scale = capture_scale(&pick_monitor()?)?;
        operation.with_active(|| windows_input::click(x, y, scale))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (x, y);
        Err("当前平台暂不支持模拟鼠标点击".into())
    }
}

/// 依次模拟一组键盘按键（含修饰键），用于自动化脚本的键盘输入节点。
#[tauri::command(async)]
pub fn simulate_keys(
    keys: Vec<KeyStroke>,
    run_id: Option<String>,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    let operation = state.operation(run_id.as_deref())?;
    operation.check()?;
    #[cfg(target_os = "macos")]
    unsafe {
        if !AXIsProcessTrusted() {
            return Err("请先在设置中授予辅助功能权限".into());
        }
        const HID_EVENT_TAP: u32 = 0;
        for_each_stroke(&keys, &operation, |key| {
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
            Ok(())
        })
    }

    #[cfg(target_os = "windows")]
    {
        windows_input::keys_with_guard(&keys, |stroke| operation.with_active(stroke))?;
        operation.check()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = keys;
        Err("当前平台暂不支持模拟键盘输入".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::automation_cancel::CANCELLED;

    /// 已取消的运行不能注入第一键，模拟器的任何副作用都不会执行。
    #[test]
    fn cancelled_run_emits_no_strokes() {
        let state = AutomationState::default();
        state.begin("cancelled".into()).unwrap();
        state.cancel("cancelled").unwrap();
        let keys = [KeyStroke {
            keycode: 0,
            flags: 0,
        }];
        let operation = state.operation(Some("cancelled")).unwrap();
        assert_eq!(
            for_each_stroke(&keys, &operation, |_| panic!("不得注入按键")).unwrap_err(),
            CANCELLED
        );
    }

    /// 用双向握手在第一键按下期间请求取消，验证释放完成且后续键不执行。
    #[test]
    fn cancellation_between_strokes_preserves_release() {
        let state = std::sync::Arc::new(AutomationState::default());
        state.begin("keys".into()).unwrap();
        let operation = state.operation(Some("keys")).unwrap();
        let (down_tx, down_rx) = std::sync::mpsc::channel();
        let (up_tx, up_rx) = std::sync::mpsc::channel();
        let cancelling_state = state.clone();
        let cancel = std::thread::spawn(move || {
            down_rx.recv().unwrap();
            // 在另一个线程等待 release，避免在持 token 锁的闭包中取消导致死锁。
            let waiter = std::thread::spawn(move || cancelling_state.cancel("keys"));
            // check 会等待当前 stroke，因此用测试专用的原子观察建立确定的顺序。
            while !operation.is_cancelled() {
                std::thread::yield_now();
            }
            up_tx.send(()).unwrap();
            waiter.join().unwrap().unwrap();
        });
        let keys = vec![
            KeyStroke {
                keycode: 0,
                flags: 0,
            },
            KeyStroke {
                keycode: 1,
                flags: 0,
            },
        ];
        let mut events = Vec::new();
        let result = for_each_stroke(&keys, &state.operation(Some("keys")).unwrap(), |key| {
            events.push((key.keycode, "down"));
            down_tx.send(()).unwrap();
            up_rx.recv().unwrap();
            events.push((key.keycode, "up"));
            Ok(())
        });
        cancel.join().unwrap();
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert_eq!(events, vec![(0, "down"), (0, "up")]);
    }

    /// 未提供 runId 时仍按原顺序执行全部键。
    #[test]
    fn legacy_strokes_are_unchanged() {
        let keys = vec![
            KeyStroke {
                keycode: 0,
                flags: 0,
            },
            KeyStroke {
                keycode: 1,
                flags: 0,
            },
        ];
        let mut seen = Vec::new();
        for_each_stroke(&keys, &Operation::default(), |key| {
            seen.push(key.keycode);
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, vec![0, 1]);
    }
}
