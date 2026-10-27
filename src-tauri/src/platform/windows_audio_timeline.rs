pub(crate) const RATE: u64 = 48_000;
pub(crate) const CHANNELS: u16 = 2;
pub(crate) const BITS: u16 = 16;
pub(crate) const ALIGN: usize = CHANNELS as usize * BITS as usize / 8;
const TICKS_PER_SECOND: i128 = 10_000_000;

#[derive(Default)]
pub(crate) struct Timeline {
    device_anchor: Option<(u64, i64)>,
    next: Option<i64>,
}

impl Timeline {
    /// 用设备帧位置保持连续；时间戳无效时续接上一包，避免把线程等待编码成静音。
    pub(crate) fn packet_start(
        &mut self,
        position: u64,
        qpc: Option<u64>,
        origin: i64,
        now: i64,
        frames: u32,
    ) -> i64 {
        let start = if let Some(qpc) = qpc {
            match self.device_anchor {
                Some((device, start)) if position >= device => {
                    start.saturating_add((position - device).min(i64::MAX as u64) as i64)
                }
                _ => ticks_to_frames(qpc as i128 - origin as i128),
            }
        } else {
            self.next
                .unwrap_or_else(|| ticks_to_frames(now as i128 - origin as i128) - frames as i64)
        };
        // TIMESTAMP_ERROR 同时使设备位置失去可信度，下一有效包重新建立锚点。
        self.device_anchor = qpc.map(|_| (position, start));
        self.next = Some(start.saturating_add(frames as i64));
        start
    }
}

/// 将绝对 QPC 差值（已是 100ns）转换为有符号的 PCM 帧位置。
pub(crate) fn ticks_to_frames(ticks: i128) -> i64 {
    (ticks * RATE as i128 / TICKS_PER_SECOND) as i64
}

/// 校验交错 PCM 必须由完整的双声道采样帧组成。
pub(crate) fn pcm_frames(bytes: &[u8]) -> Result<u64, String> {
    if !bytes.len().is_multiple_of(ALIGN) {
        return Err("PCM 缓冲未按双声道 16 位采样帧对齐".into());
    }
    Ok((bytes.len() / ALIGN) as u64)
}

/// 只裁掉首帧前、已写入和停止点后的采样，正常采集不按读取墙钟截断包尾。
pub(crate) fn packet_range(
    start: i64,
    written: u64,
    frames: u32,
    end: Option<u64>,
) -> (u64, std::ops::Range<usize>) {
    let first = start.max(0) as u64;
    let target = end.map_or(first, |end| first.min(end)).max(written);
    let skip = (target as i128 - start as i128).max(0).min(frames as i128) as usize;
    let count = end.map_or(frames as usize - skip, |end| {
        (frames as usize - skip).min(end.saturating_sub(target) as usize)
    });
    (target, skip * ALIGN..(skip + count) * ALIGN)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 非对称左右声道样本必须保持完整，拒绝编码器会向下取整的残缺帧。
    #[test]
    fn stereo_pcm_preserves_frame_boundaries() {
        let pcm = [0x34, 0x12, 0xcc, 0xed, 0xff, 0x7f, 0x00, 0x80];
        assert_eq!((BITS, CHANNELS, ALIGN), (16, 2, 4));
        assert_eq!(pcm_frames(&pcm), Ok(2));
        assert!(pcm_frames(&pcm[..7]).is_err());
        assert_eq!(pcm_frames(&vec![0; RATE as usize * ALIGN]), Ok(RATE));
    }

    /// WASAPI 已转换的 100ns QPC 不能再次除以硬件计数器频率。
    #[test]
    fn qpc_uses_100ns_and_trims_before_video_origin() {
        let mut timeline = Timeline::default();
        assert_eq!(
            timeline.packet_start(0, Some(9_900_000), 10_000_000, 10_200_000, 480),
            -480
        );
        assert_eq!(
            timeline.packet_start(480, Some(10_000_000), 10_000_000, 10_300_000, 480),
            0
        );
    }

    /// 有效设备位置抵抗 QPC 舍入抖动，并精确保留设备真正丢失的帧数。
    #[test]
    fn device_frames_preserve_continuity_and_real_gaps() {
        let mut timeline = Timeline::default();
        assert_eq!(
            timeline.packet_start(100, Some(10_000_000), 10_000_000, 10_100_000, 480),
            0
        );
        assert_eq!(
            timeline.packet_start(580, Some(10_100_300), 10_000_000, 10_200_000, 480),
            480
        );
        assert_eq!(
            timeline.packet_start(1540, Some(10_300_000), 10_000_000, 10_400_000, 480),
            1440
        );
    }

    /// 编码锁等待 200ms 后批量读取无效时间戳包，不得插入静音或丢弃人声。
    #[test]
    fn delayed_invalid_timestamps_do_not_follow_read_time() {
        let mut timeline = Timeline::default();
        assert_eq!(
            timeline.packet_start(0, Some(10_000_000), 10_000_000, 10_100_000, 480),
            0
        );
        let mut written = 480;
        let mut payload = Vec::new();
        let mut expected = Vec::new();
        for packet in 1..=20 {
            let start = timeline.packet_start(0, None, 10_000_000, 12_100_000, 480);
            assert_eq!(start, packet * 480);
            let bytes = vec![packet as u8; 480 * ALIGN];
            let (target, range) = packet_range(start, written, 480, None);
            assert_eq!(target, written, "线程延迟不应产生补零");
            payload.extend_from_slice(&bytes[range.clone()]);
            expected.extend_from_slice(&bytes);
            written += ((range.end - range.start) / ALIGN) as u64;
        }
        assert_eq!(written, 10080);
        assert_eq!(payload, expected, "所有积压包的 PCM 字节必须完整保留");
        assert_eq!(
            timeline.packet_start(10080, Some(12_100_000), 10_000_000, 12_200_000, 480),
            10080
        );
    }

    /// 用逐帧不同的左右声道字节验证前导裁剪、重叠裁剪及停止裁剪不拆采样帧。
    #[test]
    fn trimming_keeps_exact_pcm_samples() {
        let pcm = [1, 0, 11, 0, 2, 0, 12, 0, 3, 0, 13, 0];
        let (target, range) = packet_range(-1, 0, 3, None);
        assert_eq!(target, 0);
        assert_eq!(&pcm[range], &[2, 0, 12, 0, 3, 0, 13, 0]);
        let (target, range) = packet_range(10, 11, 3, Some(12));
        assert_eq!(target, 11);
        assert_eq!(&pcm[range], &[2, 0, 12, 0]);
        assert_eq!(packet_range(10, 0, 3, None), (10, 0..12));
        assert_eq!(packet_range(10, 0, 3, Some(9)), (9, 0..0));
    }
}
