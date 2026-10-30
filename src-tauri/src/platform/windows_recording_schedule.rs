use std::time::Instant;

/// 按固定 30 fps 时间槽选择捕获回调，处理耗时不会额外延长下一帧间隔。
#[derive(Default)]
pub(super) struct FrameSchedule {
    origin: Option<Instant>,
    next_slot: u128,
}

impl FrameSchedule {
    pub(super) fn accept(&mut self, now: Instant) -> bool {
        let origin = *self.origin.get_or_insert(now);
        let slot = now.duration_since(origin).as_nanos() * 30 / 1_000_000_000;
        if slot < self.next_slot {
            return false;
        }
        // 处理落后时直接跳过错过的时间槽，不突发补发旧帧。
        self.next_slot = slot + 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn samples_thirty_frames_on_common_refresh_rates() {
        for refresh in [60u64, 120, 144, 165] {
            let origin = Instant::now();
            let mut schedule = FrameSchedule::default();
            let frames = (0..refresh)
                .filter(|index| {
                    schedule.accept(origin + Duration::from_nanos(index * 1_000_000_000 / refresh))
                })
                .count();
            assert_eq!(frames, 30, "refresh={refresh}");
        }
    }

    #[test]
    fn slow_processing_does_not_add_another_frame_interval() {
        let origin = Instant::now();
        let mut schedule = FrameSchedule::default();
        assert!(schedule.accept(origin));
        assert!(schedule.accept(origin + Duration::from_millis(40)));
        assert!(!schedule.accept(origin + Duration::from_millis(41)));
        assert!(schedule.accept(origin + Duration::from_millis(67)));
        assert!(schedule.accept(origin + Duration::from_secs(2)));
        assert!(!schedule.accept(origin + Duration::from_secs(2)));
    }
}
