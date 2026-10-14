//! 截图命令：区域截图与放大镜取样。
use std::path::PathBuf;

use crate::commands::files::{sanitize_file_stem, unique_path};
use crate::screen::{capture_coordinates, logical_size, pick_monitor};

/// 按预设区域截图并保存为 PNG，返回保存路径。
/// 命名规则：优先用 `前缀.png`；若已存在同名文件，则从 `前缀1.png` 开始自增，直到找到未占用的名字。
#[tauri::command(async)]
pub fn capture_region(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    dir: String,
    prefix: String,
) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("截图区域宽高必须大于 0".into());
    }
    let monitor = pick_monitor()?;
    let (x, y, w, h) = capture_coordinates(&monitor, x, y, width, height)?;

    let image = monitor
        .capture_region(x, y, w, h)
        .map_err(|e| format!("截屏失败: {e}"))?;

    let dir_path = PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("创建目录失败: {e}"))?;

    let base = if prefix.trim().is_empty() {
        "screenshot".to_string()
    } else {
        sanitize_file_stem(&prefix)
    };
    let path = unique_path(&dir_path, &base, "png");

    image.save(&path).map_err(|e| format!("保存失败: {e}"))?;

    Ok(path.to_string_lossy().into_owned())
}

/// 截取指针周围的一小块区域并返回原始 RGBA，供放大镜实时取样。
/// 只截小块、按帧刷新，既能反映桌面内容变化，又避免整屏截取带来的高占用与发热。
/// 返回格式：origin_x, origin_y(逻辑坐标)、width, height(物理像素) 各 4 字节 u32 LE，后接 RGBA。
#[tauri::command]
pub fn capture_around(cx: i32, cy: i32, span: u32) -> Result<tauri::ipc::Response, String> {
    let monitor = pick_monitor()?;
    let (mw, mh) = logical_size(&monitor)?;
    let (mw, mh) = (mw as i32, mh as i32);
    if mw < 1 || mh < 1 {
        return Err("显示器尺寸无效".into());
    }
    let span_i = span.clamp(1, 256).min(mw.min(mh) as u32) as i32;
    let half = span_i / 2;
    // 以指针为中心取框，并把原点夹在屏幕内，保证区域始终完整
    let ox = (cx - half).clamp(0, mw - span_i);
    let oy = (cy - half).clamp(0, mh - span_i);

    let (px, py, pw, ph) =
        capture_coordinates(&monitor, ox as u32, oy as u32, span_i as u32, span_i as u32)?;
    let image = monitor
        .capture_region(px, py, pw, ph)
        .map_err(|e| format!("截屏失败: {e}"))?;
    let (w, h) = (image.width(), image.height());
    let mut buf = Vec::with_capacity(16 + image.as_raw().len());
    buf.extend_from_slice(&(ox as u32).to_le_bytes());
    buf.extend_from_slice(&(oy as u32).to_le_bytes());
    buf.extend_from_slice(&w.to_le_bytes());
    buf.extend_from_slice(&h.to_le_bytes());
    buf.extend_from_slice(image.as_raw());
    Ok(tauri::ipc::Response::new(buf))
}
