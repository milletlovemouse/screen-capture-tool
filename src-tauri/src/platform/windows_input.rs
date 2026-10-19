use std::mem::size_of;
use windows_sys::Win32::{
    Foundation::POINT,
    UI::{
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::{GetCursorPos, SetCursorPos},
    },
};

/// 读取物理鼠标坐标，返回主屏逻辑坐标。
pub fn cursor(scale: f64) -> Result<(i32, i32), String> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err("读取鼠标位置失败".into());
    }
    Ok((
        (point.x as f64 / scale).round() as i32,
        (point.y as f64 / scale).round() as i32,
    ))
}

/// 注入完整的一组输入；失败时由调用者释放已按下的按键。
fn send(inputs: &[INPUT]) -> Result<(), String> {
    if unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    } != inputs.len() as u32
    {
        return Err("Windows 拒绝模拟输入；目标窗口若以管理员身份运行，工具需具有相同权限".into());
    }
    Ok(())
}

/// 将逻辑坐标换算为物理像素后点击。
pub fn click(x: i32, y: i32, scale: f64) -> Result<(), String> {
    if unsafe {
        SetCursorPos(
            (x as f64 * scale).round() as i32,
            (y as f64 * scale).round() as i32,
        )
    } == 0
    {
        return Err("移动鼠标失败".into());
    }
    let event = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let result = send(&[event(MOUSEEVENTF_LEFTDOWN), event(MOUSEEVENTF_LEFTUP)]);
    if result.is_err() {
        let _ = send(&[event(MOUSEEVENTF_LEFTUP)]);
    }
    result
}

/// 使用扫描码保留物理键位；高字节 0xe0 表示扩展键。
fn key(scan: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wScan: scan & 0xff,
                dwFlags: KEYEVENTF_SCANCODE
                    | if scan > 0xff {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        0
                    }
                    | if up { KEYEVENTF_KEYUP } else { 0 },
                ..Default::default()
            },
        },
    }
}

/// 每 stroke 经调用方取消门控；回调内包含完整释放，不依赖应用状态类型。
pub fn keys_with_guard(
    keys: &[crate::KeyStroke],
    mut with_active: impl FnMut(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<(), String> {
    let scans: Vec<_> = keys
        .iter()
        .map(|stroke| {
            crate::key_mapping::windows_scan(stroke.keycode)
                .ok_or_else(|| format!("不支持的键码：{}", stroke.keycode))
        })
        .collect::<Result<_, _>>()?;
    for (stroke, scan) in keys.iter().zip(scans) {
        let modifiers: Vec<u16> = [
            (1 << 17, 0x2a),
            (1 << 18, 0x1d),
            (1 << 19, 0x38),
            (1 << 20, 0xe05b),
        ]
        .into_iter()
        .filter(|(flag, _)| stroke.flags & flag != 0)
        .map(|(_, code)| code)
        .collect();
        let mut inputs: Vec<_> = modifiers.iter().map(|scan| key(*scan, false)).collect();
        inputs.extend([key(scan, false), key(scan, true)]);
        inputs.extend(modifiers.iter().rev().map(|scan| key(*scan, true)));
        with_active(&mut || {
            if let Err(error) = send(&inputs) {
                let mut release = vec![key(scan, true)];
                release.extend(modifiers.iter().rev().map(|scan| key(*scan, true)));
                let _ = send(&release);
                return Err(error);
            }
            Ok(())
        })?;
    }
    Ok(())
}
