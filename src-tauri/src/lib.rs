use std::path::{Path, PathBuf};
use std::sync::Mutex;
use xcap::Monitor;

#[cfg(target_os = "macos")]
mod dock_menu;
mod geometry;
mod key_mapping;
#[cfg(target_os = "windows")]
mod windows_input;
#[cfg(target_os = "windows")]
mod windows_recording;

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    fn CGEventCreateMouseEvent(
        source: *const std::ffi::c_void,
        event_type: u32,
        point: CGPoint,
        mouse_button: u32,
    ) -> *mut std::ffi::c_void;
    fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
    fn CGEventCreateKeyboardEvent(
        source: *const std::ffi::c_void,
        keycode: u16,
        key_down: bool,
    ) -> *mut std::ffi::c_void;
    fn CGEventSetFlags(event: *mut std::ffi::c_void, flags: u64);
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const std::ffi::c_void;
    static kCFTypeDictionaryKeyCallBacks: std::ffi::c_void;
    static kCFTypeDictionaryValueCallBacks: std::ffi::c_void;
    fn CFDictionaryCreate(
        allocator: *const std::ffi::c_void,
        keys: *const *const std::ffi::c_void,
        values: *const *const std::ffi::c_void,
        num_values: isize,
        key_callbacks: *const std::ffi::c_void,
        value_callbacks: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
}

/// 权限检查结果：屏幕录制与辅助功能（设备控制）。
#[derive(serde::Serialize)]
struct PermissionStatus {
    screen: bool,
    accessibility: bool,
}

/// 单个模拟按键：平台相关键码、修饰键标志位和物理键位。
#[derive(serde::Deserialize)]
struct KeyStroke {
    keycode: u16,
    #[serde(default)]
    flags: u64,
}

enum RecordingProcess {
    #[cfg(target_os = "macos")]
    Mac(std::process::Child, String),
    #[cfg(target_os = "windows")]
    Windows(windows_recording::Recording, String),
}

/// 录屏进程状态：保存平台录屏任务与输出路径。
struct RecState(Mutex<Option<RecordingProcess>>);

impl Drop for RecState {
    fn drop(&mut self) {
        let Ok(mut guard) = self.0.lock() else {
            return;
        };
        let Some(process) = guard.take() else {
            return;
        };
        let _ = stop_recording_process(process);
    }
}

fn stop_recording_process(process: RecordingProcess) -> Result<String, String> {
    match process {
        #[cfg(target_os = "macos")]
        RecordingProcess::Mac(mut child, path) => {
            let signal = std::process::Command::new("/bin/kill")
                .arg("-INT")
                .arg(child.id().to_string())
                .status();
            if !matches!(signal, Ok(status) if status.success()) {
                let _ = child.kill();
            }
            child.wait().map_err(|e| format!("等待录屏保存失败：{e}"))?;
            if !Path::new(&path).is_file() {
                return Err("录屏没有生成文件，请检查屏幕录制权限".into());
            }
            Ok(path)
        }
        #[cfg(target_os = "windows")]
        RecordingProcess::Windows(recording, path) => {
            recording.stop()?;
            Ok(path)
        }
    }
}

fn clear_finished_recording(guard: &mut Option<RecordingProcess>) {
    #[cfg(target_os = "macos")]
    if let Some(RecordingProcess::Mac(child, _)) = guard.as_mut() {
        if child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(false)
        {
            guard.take();
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(RecordingProcess::Windows(recording, _)) = guard.as_ref() {
        if recording.is_finished() {
            if let Some(process) = guard.take() {
                let _ = stop_recording_process(process);
            }
        }
    }
}

fn sanitize_file_stem(value: &str) -> String {
    let stem: String = value
        .trim()
        .chars()
        .map(|ch| {
            if "/\\:*?\"<>|".contains(ch) || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return "capture".into();
    }
    let first = stem.split('.').next().unwrap_or("").to_uppercase();
    if matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (first.starts_with("COM") || first.starts_with("LPT"))
            && first.len() == 4
            && matches!(first.as_bytes()[3], b'1'..=b'9')
    {
        format!("_{stem}")
    } else {
        stem.into()
    }
}

/// 在目录中找到未占用的文件名：优先 `base.ext`，重名则 `base1.ext`、`base2.ext`…
fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{base}.{ext}"));
    if path.exists() {
        let mut n: u32 = 1;
        loop {
            let candidate = dir.join(format!("{base}{n}.{ext}"));
            if !candidate.exists() {
                path = candidate;
                break;
            }
            n += 1;
        }
    }
    path
}

/// 获取主显示器；找不到标记为主屏的则退回第一个
fn pick_monitor() -> Result<Monitor, String> {
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
fn primary_size() -> Result<(u32, u32), String> {
    let m = pick_monitor()?;
    logical_size(&m)
}

/// xcap 在 Windows 使用物理像素，在 macOS 使用屏幕逻辑坐标。
fn capture_scale(monitor: &Monitor) -> Result<f64, String> {
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

fn logical_size(m: &Monitor) -> Result<(u32, u32), String> {
    let w = m.width().map_err(|e| format!("读取屏幕宽度失败: {e}"))?;
    let h = m.height().map_err(|e| format!("读取屏幕高度失败: {e}"))?;
    let scale = capture_scale(m)?;
    Ok((
        (w as f64 / scale).floor() as u32,
        (h as f64 / scale).floor() as u32,
    ))
}

fn capture_coordinates(
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

/// 读取当前鼠标位置，返回主屏逻辑坐标。
#[tauri::command]
fn cursor_position() -> Result<(i32, i32), String> {
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
#[tauri::command]
fn simulate_click(x: i32, y: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
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
    }

    #[cfg(target_os = "windows")]
    {
        windows_input::click(x, y, capture_scale(&pick_monitor()?)?)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (x, y);
        Err("当前平台暂不支持模拟鼠标点击".into())
    }
}

/// 依次模拟一组键盘按键（含修饰键），用于自动化脚本的键盘输入节点。
#[tauri::command]
fn simulate_keys(keys: Vec<KeyStroke>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        if !AXIsProcessTrusted() {
            return Err("请先在设置中授予辅助功能权限".into());
        }
        const HID_EVENT_TAP: u32 = 0;
        for key in &keys {
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
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        windows_input::keys(&keys)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = keys;
        Err("当前平台暂不支持模拟键盘输入".into())
    }
}

/// 按预设区域截图并保存为 PNG，返回保存路径。
/// 命名规则：优先用 `前缀.png`；若已存在同名文件，则从 `前缀1.png` 开始自增，直到找到未占用的名字。
#[tauri::command(async)]
fn capture_region(
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
fn capture_around(cx: i32, cy: i32, span: u32) -> Result<tauri::ipc::Response, String> {
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

/// 录制预设区域或主屏：macOS 保存 MOV，Windows 原生编码为 MP4。
#[tauri::command(async)]
fn start_recording(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    dir: String,
    prefix: String,
    state: tauri::State<RecState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "录制状态异常".to_string())?;
    clear_finished_recording(&mut guard);
    if guard.is_some() {
        return Err("已在录制中".into());
    }
    let dir_path = PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("创建目录失败: {e}"))?;
    let dir_path = dir_path
        .canonicalize()
        .map_err(|e| format!("读取保存目录失败：{e}"))?;
    let base = if prefix.trim().is_empty() {
        "recording".to_string()
    } else {
        sanitize_file_stem(&prefix)
    };
    let monitor = pick_monitor()?;
    let rect = if width > 0 && height > 0 {
        capture_coordinates(&monitor, x, y, width, height)?
    } else {
        (
            0,
            0,
            monitor.width().map_err(|e| e.to_string())?,
            monitor.height().map_err(|e| e.to_string())?,
        )
    };
    #[cfg(target_os = "macos")]
    {
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err("请先授予屏幕录制权限并重启应用".into());
        }
        let path = unique_path(&dir_path, &base, "mov");
        let (x, y, width, height) = rect;
        let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
        cmd.arg("-v")
            .arg("-x")
            .arg(format!("-R{x},{y},{width},{height}"))
            .arg(&path);
        let child = cmd.spawn().map_err(|e| format!("启动录屏失败: {e}"))?;
        let path_str = path.to_string_lossy().into_owned();
        *guard = Some(RecordingProcess::Mac(child, path_str.clone()));
        Ok(path_str)
    }
    #[cfg(target_os = "windows")]
    {
        let path = unique_path(&dir_path, &base, "mp4");
        let recording = windows_recording::Recording::start(&path, rect)?;
        let path_str = path.to_string_lossy().into_owned();
        *guard = Some(RecordingProcess::Windows(recording, path_str.clone()));
        Ok(path_str)
    }
}

/// 停止对应平台的录屏并等待文件写入完成。
#[tauri::command(async)]
fn stop_recording(state: tauri::State<RecState>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "录制状态异常".to_string())?;
    let process = guard.take().ok_or("当前没有在录制".to_string())?;
    stop_recording_process(process)
}

/// 查询当前是否正在录屏
#[tauri::command]
fn is_recording(state: tauri::State<RecState>) -> bool {
    let Ok(mut guard) = state.0.lock() else {
        return false;
    };
    clear_finished_recording(&mut guard);
    guard.is_some()
}

/// 检查屏幕录制与辅助功能权限的当前状态（非 macOS 视为已具备）。
#[tauri::command]
fn check_permissions() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        PermissionStatus {
            screen: CGPreflightScreenCaptureAccess(),
            accessibility: AXIsProcessTrusted(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus {
            screen: true,
            accessibility: true,
        }
    }
}

/// 请求屏幕录制权限，触发系统授权弹窗，返回当前是否已授权。
#[tauri::command]
fn request_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGRequestScreenCaptureAccess()
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 请求辅助功能（设备控制）权限，触发系统授权弹窗，返回当前是否已授权。
#[tauri::command]
fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        let trusted = AXIsProcessTrustedWithOptions(options);
        if !options.is_null() {
            CFRelease(options);
        }
        trusted
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 打开系统设置中对应的隐私面板（section: screen / accessibility / notification）。
#[tauri::command]
fn open_privacy_settings(section: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match section.as_str() {
            "screen" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
                    .to_string()
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                    .to_string()
            }
            "notification" => {
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension".to_string()
            }
            _ => return Err("未知的权限面板".into()),
        };
        std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("打开系统设置失败: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let uri = match section.as_str() {
            "notification" => "ms-settings:notifications",
            "screen" => "ms-settings:privacy-graphicsCaptureProgrammatic",
            "accessibility" => "ms-settings:easeofaccess",
            _ => return Err("未知的权限面板".into()),
        };
        std::process::Command::new("explorer.exe")
            .arg(uri)
            .spawn()
            .map_err(|e| format!("打开系统设置失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = section;
        Err("当前平台无需额外授权".into())
    }
}

/// 在系统文件管理器中选中文件；文件已删除时尝试打开原目录。
#[tauri::command]
fn reveal_saved_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let file = PathBuf::from(path);
        if !file.is_absolute() {
            return Err("保存路径必须为绝对路径".into());
        }
        let mut command = std::process::Command::new("/usr/bin/open");
        if file.is_file() {
            let target = file
                .canonicalize()
                .map_err(|e| format!("读取文件路径失败: {e}"))?;
            command.arg("-R").arg(target);
        } else {
            let parent = file
                .parent()
                .filter(|dir| dir.is_dir())
                .ok_or("文件和保存目录已不存在")?;
            let target = parent
                .canonicalize()
                .map_err(|e| format!("读取目录失败: {e}"))?;
            command.arg(target);
        }
        let status = command
            .status()
            .map_err(|e| format!("打开 Finder 失败: {e}"))?;
        if !status.success() {
            return Err("Finder 无法打开该保存位置".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let file = PathBuf::from(path);
        if !file.is_absolute() {
            return Err("保存路径必须为绝对路径".into());
        }
        let exists = file.is_file();
        let target = if exists {
            file.as_path()
        } else {
            file.parent()
                .filter(|dir| dir.is_dir())
                .ok_or("文件和保存目录已不存在")?
        };
        // Explorer 不接受 Rust canonicalize 返回的扩展路径前缀。
        let target = target
            .canonicalize()
            .map_err(|e| format!("读取路径失败：{e}"))?;
        let text = target.to_string_lossy();
        let text = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
        };
        let mut command = std::process::Command::new("explorer.exe");
        if exists {
            command.arg(format!("/select,{text}"));
        } else {
            command.arg(text);
        }
        command
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        Err("当前平台暂不支持在 Finder 中查看".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RecState(Mutex::new(None)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|_| {
            #[cfg(target_os = "macos")]
            dock_menu::install()?;
            Ok(())
        })
        .on_menu_event(|_app, _event| {
            #[cfg(target_os = "macos")]
            dock_menu::handle_menu_event(_app, _event);
        })
        .invoke_handler(tauri::generate_handler![
            capture_region,
            primary_size,
            cursor_position,
            simulate_click,
            simulate_keys,
            capture_around,
            start_recording,
            stop_recording,
            is_recording,
            reveal_saved_file,
            check_permissions,
            request_screen_permission,
            request_accessibility_permission,
            open_privacy_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                dock_menu::reopen(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Ok(mut state) = app.state::<RecState>().0.lock() {
                    if let Some(recording) = state.take() {
                        let _ = stop_recording_process(recording);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn filenames_are_valid_on_both_platforms() {
        assert_eq!(super::sanitize_file_stem("a:b/c\\d?*"), "a_b_c_d__");
        assert_eq!(super::sanitize_file_stem("CON"), "_CON");
        assert_eq!(super::sanitize_file_stem("com1.log"), "_com1.log");
        assert_eq!(super::sanitize_file_stem("..."), "capture");
        assert_eq!(super::sanitize_file_stem(" 截图. "), "截图");
    }
}
