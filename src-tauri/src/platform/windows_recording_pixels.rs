/// 将顶向下的 D3D BGRA 转为 BT.709 有限范围 NV12，避免系统 RGB 转换差异。
pub(super) fn pack_nv12(
    raw: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    output: &mut [u8],
) -> Result<(), &'static str> {
    let row_len = width.checked_mul(4).ok_or("录屏行宽溢出")?;
    let luma_size = width.checked_mul(height).ok_or("录屏帧大小溢出")?;
    let size = luma_size
        .checked_add(luma_size / 2)
        .ok_or("录屏帧大小溢出")?;
    let required = height
        .checked_sub(1)
        .and_then(|rows| rows.checked_mul(stride))
        .and_then(|offset| offset.checked_add(row_len))
        .ok_or("录屏缓冲尺寸无效")?;
    if width == 0
        || !width.is_multiple_of(2)
        || !height.is_multiple_of(2)
        || stride < row_len
        || raw.len() < required
        || output.len() != size
    {
        return Err("录屏 BGRA 缓冲与行距不匹配");
    }
    let (luma, chroma) = output.split_at_mut(luma_size);
    for row in (0..height).step_by(2) {
        for col in (0..width).step_by(2) {
            let mut rgb = [0i32; 3];
            for dy in 0..2 {
                for dx in 0..2 {
                    let offset = (row + dy) * stride + (col + dx) * 4;
                    let b = i32::from(raw[offset]);
                    let g = i32::from(raw[offset + 1]);
                    let r = i32::from(raw[offset + 2]);
                    luma[(row + dy) * width + col + dx] =
                        (((11966 * r + 40254 * g + 4064 * b + 32768) >> 16) + 16).clamp(16, 235)
                            as u8;
                    rgb[0] += r;
                    rgb[1] += g;
                    rgb[2] += b;
                }
            }
            // 先平均 2×2 色度，再舍入；NV12 的色度顺序为 U、V。
            let [r, g, b] = rgb;
            let uv = row / 2 * width + col;
            chroma[uv] =
                (((-6596 * r - 22189 * g + 28785 * b + 131072) >> 18) + 128).clamp(16, 240) as u8;
            chroma[uv + 1] =
                (((28785 * r - 26145 * g - 2640 * b + 131072) >> 18) + 128).clamp(16, 240) as u8;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::pack_nv12;

    /// 标准色块核对 BT.709 有限范围数值及 UV 顺序，忽略源 alpha。
    #[test]
    fn converts_reference_colors() {
        for (bgra, yuv) in [
            ([0, 0, 0, 0], [16, 128, 128]),
            ([255, 255, 255, 17], [235, 128, 128]),
            ([0, 0, 255, 0], [63, 102, 240]),
            ([0, 255, 0, 128], [173, 42, 26]),
            ([255, 0, 0, 255], [32, 240, 118]),
            ([128, 128, 128, 0], [126, 128, 128]),
        ] {
            let raw = bgra.repeat(4);
            let mut output = [0; 6];
            pack_nv12(&raw, 8, 2, 2, &mut output).unwrap();
            assert_eq!(output, [yuv[0], yuv[0], yuv[0], yuv[0], yuv[1], yuv[2]]);
        }
    }

    /// 行 padding 不参与转换，Y 平面保持顶向下，色度来自四个像素的平均值。
    #[test]
    fn preserves_rows_and_averages_chroma() {
        let raw = [
            255, 0, 0, 0, 0, 0, 255, 17, 99, 99, 99, 99, 255, 255, 255, 128, 0, 0, 0, 255,
        ];
        let mut output = [0; 6];
        pack_nv12(&raw, 12, 2, 2, &mut output).unwrap();
        assert_eq!(output, [32, 63, 235, 16, 150, 153]);
    }

    /// 错误行距、截断帧和尺寸溢出应返回错误而非越界。
    #[test]
    fn rejects_invalid_layouts() {
        assert!(pack_nv12(&[0; 16], 7, 2, 2, &mut [0; 6]).is_err());
        assert!(pack_nv12(&[0; 15], 8, 2, 2, &mut [0; 6]).is_err());
        assert!(pack_nv12(&[0; 16], 8, 2, 2, &mut [0; 5]).is_err());
        assert!(pack_nv12(&[], 0, 0, 0, &mut []).is_err());
        assert!(pack_nv12(&[], 8, usize::MAX, 2, &mut []).is_err());
        assert!(pack_nv12(&[0; 16], 8, 1, 2, &mut [0; 3]).is_err());
        assert!(pack_nv12(&[0; 16], 8, 2, 1, &mut [0; 3]).is_err());
    }
}
