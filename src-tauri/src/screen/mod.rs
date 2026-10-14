//! 显示器与坐标换算：主屏选择、缩放和截图区域映射。
use xcap::Monitor;

pub mod geometry;

/// 获取主显示器；找不到标记为主屏的则退回第一个
pub fn pick_monitor() -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("获取显示器失败: {e}"))?;
    if let Some(m) = monitors.iter().find(|m| m.is_primary().unwrap_or(false)) {
        return Ok(m.clone());
    }
    monitors
        .into_iter()
        .next()
        .ok_or_else(|| "未找到可用显示器".to_string())
}

/// 返回主显示器的逻辑尺寸（points），用于“使用全屏”
#[tauri::command]
pub fn primary_size() -> Result<(u32, u32), String> {
    let m = pick_monitor()?;
    logical_size(&m)
}

/// xcap 在 Windows 使用物理像素，在 macOS 使用屏幕逻辑坐标。
pub fn capture_scale(monitor: &Monitor) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let scale = monitor
            .scale_factor()
            .map_err(|e| format!("读取缩放失败：{e}"))? as f64;
        if !scale.is_finite() || scale <= 0.0 {
            return Err("屏幕缩放无效".into());
        }
        Ok(scale)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = monitor;
        Ok(1.0)
    }
}

pub fn logical_size(m: &Monitor) -> Result<(u32, u32), String> {
    let w = m.width().map_err(|e| format!("读取屏幕宽度失败: {e}"))?;
    let h = m.height().map_err(|e| format!("读取屏幕高度失败: {e}"))?;
    let scale = capture_scale(m)?;
    Ok((
        (w as f64 / scale).floor() as u32,
        (h as f64 / scale).floor() as u32,
    ))
}

pub fn capture_coordinates(
    m: &Monitor,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(u32, u32, u32, u32), String> {
    let screen = (
        m.width().map_err(|e| e.to_string())?,
        m.height().map_err(|e| e.to_string())?,
    );
    geometry::capture_rect(x, y, w, h, screen, capture_scale(m)?)
}
