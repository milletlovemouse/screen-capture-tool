/// 去掉 D3D 行 padding，翻成 CPU BGRA 输入的倒序行，并忽略捕获纹理的 alpha。
pub(super) fn pack_bgra(
    raw: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    output: &mut [u8],
) -> Result<(), &'static str> {
    let row_len = width.checked_mul(4).ok_or("录屏行宽溢出")?;
    let size = row_len.checked_mul(height).ok_or("录屏帧大小溢出")?;
    let required = height
        .checked_sub(1)
        .and_then(|rows| rows.checked_mul(stride))
        .and_then(|offset| offset.checked_add(row_len))
        .ok_or("录屏缓冲尺寸无效")?;
    if width == 0 || stride < row_len || raw.len() < required || output.len() != size {
        return Err("录屏 BGRA 缓冲与行距不匹配");
    }
    for row in 0..height {
        let target = (height - 1 - row) * row_len;
        let dest = &mut output[target..target + row_len];
        dest.copy_from_slice(&raw[row * stride..row * stride + row_len]);
        for pixel in dest.as_chunks_mut::<4>().0 {
            pixel[3] = 255;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::pack_bgra;

    /// 蓝/红及白/黑色块同时验证通道、行方向、padding 和未定义 alpha。
    #[test]
    fn preserves_colors_and_flips_padded_rows() {
        let raw = [
            255, 0, 0, 0, 0, 0, 255, 17, 99, 99, 99, 99, 255, 255, 255, 128, 0, 0, 0, 255,
        ];
        let mut output = [0; 16];
        pack_bgra(&raw, 12, 2, 2, &mut output).unwrap();
        assert_eq!(
            output,
            [255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,]
        );
    }

    /// 错误行距、截断帧和尺寸溢出应返回错误而非越界。
    #[test]
    fn rejects_invalid_layouts() {
        assert!(pack_bgra(&[0; 16], 7, 2, 2, &mut [0; 16]).is_err());
        assert!(pack_bgra(&[0; 15], 8, 2, 2, &mut [0; 16]).is_err());
        assert!(pack_bgra(&[0; 16], 8, 2, 2, &mut [0; 15]).is_err());
        assert!(pack_bgra(&[], 0, 0, 0, &mut []).is_err());
        assert!(pack_bgra(&[], 8, usize::MAX, 2, &mut []).is_err());
    }
}
