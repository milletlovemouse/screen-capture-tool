use std::{
    path::Path,
    time::{Duration, Instant},
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
        VideoSettingsSubType,
    },
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

type CaptureError = Box<dyn std::error::Error + Send + Sync>;
type Control = CaptureControl<Recorder, CaptureError>;

pub struct Recording {
    control: Option<Control>,
}

pub struct Config {
    rect: (u32, u32, u32, u32),
    path: String,
}

pub struct Recorder {
    encoder: Option<VideoEncoder>,
    rect: (u32, u32, u32, u32),
    pixels: Vec<u8>,
    started: Instant,
    last_frame: Option<Instant>,
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = Config;
    type Error = CaptureError;

    fn new(ctx: Context<Config>) -> Result<Self, Self::Error> {
        let (_, _, w, h) = ctx.flags.rect;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(w, h)
                .sub_type(VideoSettingsSubType::H264)
                .frame_rate(30),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &ctx.flags.path,
        )?;
        Ok(Self {
            encoder: Some(encoder),
            rect: ctx.flags.rect,
            pixels: vec![0; (w * h * 4) as usize],
            started: Instant::now(),
            last_frame: None,
        })
    }

    // 限制捕获写入频率；复用裁剪缓冲，并转换 Windows 编码器要求的倒序 BGRA 行。
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self
            .last_frame
            .is_some_and(|last| last.elapsed() < Duration::from_millis(33))
        {
            return Ok(());
        }
        let (x, y, w, h) = self.rect;
        if x + w > frame.width() || y + h > frame.height() {
            return Err("录屏期间显示器尺寸已改变，请重新开始录制".into());
        }
        let mut buffer = frame.buffer_crop(x, y, x + w, y + h)?;
        let stride = buffer.row_pitch() as usize;
        let raw = buffer.as_raw_buffer();
        let row_len = w as usize * 4;
        for row in 0..h as usize {
            let target = (h as usize - 1 - row) * row_len;
            self.pixels[target..target + row_len]
                .copy_from_slice(&raw[row * stride..row * stride + row_len]);
        }
        let timestamp = (self.started.elapsed().as_nanos() / 100) as i64;
        self.encoder
            .as_mut()
            .ok_or("录制已停止")?
            .send_frame_buffer(&self.pixels, timestamp)?;
        self.last_frame = Some(Instant::now());
        Ok(())
    }
}

impl Recorder {
    // 补写最后一帧，使静止画面也保留到用户停止的时间，然后写入 MP4 索引。
    fn finish(&mut self) -> Result<(), String> {
        let Some(mut encoder) = self.encoder.take() else {
            return Ok(());
        };
        let has_frame = self.last_frame.is_some();
        let result = if has_frame {
            encoder
                .send_frame_buffer(
                    &self.pixels,
                    (self.started.elapsed().as_nanos() / 100) as i64,
                )
                .map_err(|e| format!("写入最后一帧失败：{e}"))
        } else {
            Err("未捕获到录屏画面，请检查显示器或系统捕获设置".into())
        };
        let finished = encoder.finish().map_err(|e| format!("保存 MP4 失败：{e}"));
        result.and(finished)
    }
}

impl Recording {
    /// 录制主屏的物理像素区域；H.264 奇数宽高向内裁去最多一像素。
    pub fn start(path: &Path, rect: (u32, u32, u32, u32)) -> Result<Self, String> {
        let (x, y, w, h) = rect;
        let rect = (x, y, w & !1, h & !1);
        if rect.2 < 2 || rect.3 < 2 {
            return Err("录屏区域至少需要 2 × 2 像素".into());
        }
        let monitor = Monitor::primary().map_err(|e| format!("读取主显示器失败：{e}"))?;
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            Config {
                rect,
                path: path.to_string_lossy().into_owned(),
            },
        );
        let control = Recorder::start_free_threaded(settings)
            .map_err(|e| format!("启动 Windows 录屏失败：{e}"))?;
        Ok(Self {
            control: Some(control),
        })
    }

    pub fn is_finished(&self) -> bool {
        self.control.as_ref().is_none_or(Control::is_finished)
    }

    /// 先停止捕获线程，再在已初始化 WinRT 的线程完成编码。
    pub fn stop(mut self) -> Result<(), String> {
        self.finish()
    }

    fn finish(&mut self) -> Result<(), String> {
        let Some(control) = self.control.take() else {
            return Ok(());
        };
        let callback = control.callback();
        let stopped = control.stop().map_err(|e| format!("停止捕获失败：{e}"));
        let saved = std::thread::spawn(move || {
            unsafe {
                windows::Win32::System::WinRT::RoInitialize(
                    windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
                )
            }
            .map_err(|e| format!("初始化编码收尾失败：{e}"))?;
            let result = callback.lock().finish();
            unsafe {
                windows::Win32::System::WinRT::RoUninitialize();
            }
            result
        })
        .join()
        .map_err(|_| "录屏保存线程异常".to_string())?;
        stopped.and(saved)
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
