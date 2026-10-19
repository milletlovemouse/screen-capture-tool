//! 截图命令：区域截图与放大镜取样。
use std::io::Cursor;
use std::path::{Path, PathBuf};

use crate::commands::automation_cancel::{AutomationState, Operation};
use crate::commands::files::{sanitize_file_stem, write_unique_file};
use crate::screen::{capture_coordinates, logical_size, pick_monitor};

/// 按预设区域截图并保存为 PNG，返回保存路径。
/// 命名规则：优先用 `前缀.png`；若已存在同名文件，则从 `前缀1.png` 开始自增，直到找到未占用的名字。
#[allow(clippy::too_many_arguments)] // 保留既有 IPC 平铺参数，state 由 Tauri 注入。
#[tauri::command(async)]
pub fn capture_region(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    dir: String,
    prefix: String,
    run_id: Option<String>,
    state: tauri::State<'_, AutomationState>,
) -> Result<String, String> {
    let operation = state.operation(run_id.as_deref())?;
    operation.check()?;
    if width == 0 || height == 0 {
        return Err("截图区域宽高必须大于 0".into());
    }
    let monitor = pick_monitor()?;
    let (x, y, w, h) = capture_coordinates(&monitor, x, y, width, height)?;

    operation.check()?;
    let image = monitor
        .capture_region(x, y, w, h)
        .map_err(|e| format!("截屏失败: {e}"))?;

    // 系统截图不可强杀；返回后先检查，取消时不创建目录或占位文件。
    operation.check()?;
    save_capture(&image, &PathBuf::from(dir), &prefix, &operation)
        .map(|path| path.to_string_lossy().into_owned())
}

/// 先在内存编码 PNG，再将检查取消、原子占位与落盘作为一个提交阶段。
fn save_capture(
    image: &image::RgbaImage,
    dir: &Path,
    prefix: &str,
    operation: &Operation,
) -> Result<PathBuf, String> {
    operation.check()?;
    let base = if prefix.trim().is_empty() {
        "screenshot".to_string()
    } else {
        sanitize_file_stem(prefix)
    };
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    operation.with_active(|| {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
        write_unique_file(dir, &base, "png", png.get_ref()).map_err(|e| format!("保存失败: {e}"))
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::automation_cancel::CANCELLED;
    use std::sync::{Arc, Barrier};

    struct TestDir(PathBuf);

    impl TestDir {
        /// 原子创建测试独占目录，不复用或删除其他测试的目录。
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            loop {
                let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let path =
                    std::env::temp_dir().join(format!("capture-test-{}-{id}", std::process::id()));
                match std::fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("创建测试目录失败: {error}"),
                }
            }
        }
    }

    impl Drop for TestDir {
        /// 仅清理本测试原子创建的目录。
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    /// 同名前缀并发写入产生不同且可解码的 PNG，既有文件字节不变。
    #[test]
    fn concurrent_png_saves_never_overwrite() {
        let dir = TestDir::new();
        let existing = dir.0.join("shot.png");
        std::fs::write(&existing, b"existing result").unwrap();
        let barrier = Arc::new(Barrier::new(12));
        let workers: Vec<_> = (0..12_u8)
            .map(|index| {
                let path = dir.0.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let pixel = image::Rgba([index, 20, 30, 255]);
                    let image = image::RgbaImage::from_pixel(2, 2, pixel);
                    barrier.wait();
                    let saved = save_capture(&image, &path, "shot", &Operation::default()).unwrap();
                    let decoded = image::open(&saved).unwrap().to_rgba8();
                    assert_eq!(decoded, image);
                    saved
                })
            })
            .collect();
        let paths: std::collections::HashSet<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(paths.len(), 12);
        for index in 1..=12 {
            assert!(paths.contains(&dir.0.join(format!("shot{index}.png"))));
        }
        assert_eq!(std::fs::read(existing).unwrap(), b"existing result");
    }

    /// 系统截图晚于 cancel 返回时不保存、不建目录，且不删除早先结果。
    #[test]
    fn cancellation_after_capture_keeps_existing_results() {
        let dir = TestDir::new();
        let state = AutomationState::default();
        state.begin("capture".into()).unwrap();
        let operation = state.operation(Some("capture")).unwrap();
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([1, 2, 3, 255]));
        let existing = save_capture(&image, &dir.0, "shot", &operation).unwrap();
        let bytes = std::fs::read(&existing).unwrap();
        // 模拟不可中止的系统截图已返回，只有保存阶段尚未开始。
        state.cancel("capture").unwrap();
        assert_eq!(
            save_capture(&image, &dir.0, "shot", &operation).unwrap_err(),
            CANCELLED
        );
        let absent = dir.0.join("not-created");
        assert_eq!(
            save_capture(&image, &absent, "shot", &operation).unwrap_err(),
            CANCELLED
        );
        assert!(!absent.exists());
        assert!(!dir.0.join("shot1.png").exists());
        assert_eq!(std::fs::read(existing).unwrap(), bytes);
    }

    /// 原子占位遇到目录也跳过，其他 IO 错误直接上报而不无限换名。
    #[test]
    fn reservation_handles_collisions_and_io_errors() {
        let dir = TestDir::new();
        std::fs::create_dir(dir.0.join("shot.png")).unwrap();
        let saved = write_unique_file(&dir.0, "shot", "png", b"bytes").unwrap();
        assert_eq!(saved, dir.0.join("shot1.png"));
        assert!(dir.0.join("shot.png").is_dir());
        let error = write_unique_file(&dir.0.join("missing"), "shot", "png", b"bytes").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}
