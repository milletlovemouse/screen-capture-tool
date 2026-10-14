//! 文件名与路径处理，以及在系统中打开文件、链接。
use std::path::{Path, PathBuf};

pub fn sanitize_file_stem(value: &str) -> String {
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
pub fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
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
/// 在系统文件管理器中选中文件；文件已删除时尝试打开原目录。
#[tauri::command]
pub fn reveal_saved_file(path: String) -> Result<(), String> {
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

/// 用系统默认浏览器打开 http/https 链接；webview 内的 target=_blank 不会自行跳转。
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    // 限定协议并拒绝空白字符，避免把参数拼进系统命令。
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持打开 http/https 链接".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("链接包含非法字符".into());
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .status()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        if !status.success() {
            return Err("系统无法打开该链接".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // start 的第一个引号参数会被当作窗口标题，必须留空占位。
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = url;
        Err("当前平台暂不支持打开链接".into())
    }
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
