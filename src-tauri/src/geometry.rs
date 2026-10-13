/// 逻辑坐标转换为捕获 API 的坐标，裁剪屏幕边界并拒绝空区域。
pub fn capture_rect(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    screen: (u32, u32),
    scale: f64,
) -> Result<(u32, u32, u32, u32), String> {
    if !scale.is_finite() || scale <= 0.0 || width == 0 || height == 0 {
        return Err("截图区域宽高必须大于 0，屏幕缩放必须有效".into());
    }
    let left = (x as f64 * scale).round() as u32;
    let top = (y as f64 * scale).round() as u32;
    if left >= screen.0 || top >= screen.1 {
        return Err("区域起点超出主屏范围".into());
    }
    let right = ((x as f64 + width as f64) * scale)
        .round()
        .min(screen.0 as f64) as u32;
    let bottom = ((y as f64 + height as f64) * scale)
        .round()
        .min(screen.1 as f64) as u32;
    if right <= left || bottom <= top {
        return Err("截图区域为空".into());
    }
    Ok((left, top, right - left, bottom - top))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpi_conversion_clips_edges_without_overflow() {
        assert_eq!(
            capture_rect(100, 100, 800, 600, (1920, 1080), 1.5).unwrap(),
            (150, 150, 1200, 900)
        );
        assert_eq!(
            capture_rect(0, 0, 1536, 864, (1920, 1080), 1.25).unwrap(),
            (0, 0, 1920, 1080)
        );
        assert_eq!(
            capture_rect(100, 100, u32::MAX, u32::MAX, (1920, 1080), 1.0).unwrap(),
            (100, 100, 1820, 980)
        );
        assert!(capture_rect(1920, 0, 10, 10, (1920, 1080), 1.0).is_err());
        assert!(capture_rect(0, 0, 0, 10, (1920, 1080), 1.0).is_err());
    }
}
