use super::windows_audio::{AudioCapture, Clock, SharedEncoder};
#[path = "windows_recording_encoder.rs"]
pub(super) mod encoder;
#[path = "windows_recording_pixels.rs"]
mod pixels;
use encoder::VideoEncoder;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
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
    audio_source: String,
    audio_enabled: bool,
    hardware_encoding: bool,
}

pub struct Recorder {
    encoder: SharedEncoder,
    audio: Option<AudioCapture>,
    rect: (u32, u32, u32, u32),
    pixels: Vec<u8>,
    clock: Clock,
    last_frame: Option<Instant>,
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = Config;
    type Error = CaptureError;

    /// 创建共享编码器；仅在启用音频时创建音轨并启动 WASAPI。
    fn new(ctx: Context<Config>) -> Result<Self, Self::Error> {
        let (_, _, w, h) = ctx.flags.rect;
        let encoder = VideoEncoder::new(
            w,
            h,
            ctx.flags.audio_enabled,
            ctx.flags.hardware_encoding,
            &ctx.flags.path,
        )?;
        let encoder = Arc::new(Mutex::new(Some(encoder)));
        let clock = Clock::new()?;
        let audio = if ctx.flags.audio_enabled {
            Some(AudioCapture::start(
                ctx.flags.audio_source,
                encoder.clone(),
                clock.clone(),
            )?)
        } else {
            None
        };
        Ok(Self {
            encoder,
            audio,
            rect: ctx.flags.rect,
            pixels: vec![0; w as usize * h as usize * 3 / 2],
            clock,
            last_frame: None,
        })
    }

    // 限制捕获写入频率；复用裁剪缓冲，明确转换为顶向下的 NV12。
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.audio.as_ref().is_some_and(AudioCapture::is_finished) {
            let mut audio = self.audio.take().ok_or("音频采集已停止")?;
            audio.stop()?;
            return Err("音频采集意外停止".into());
        }
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
        let timestamp = if self.last_frame.is_none() {
            self.clock.set_anchor()?
        } else {
            self.clock.elapsed()?
        };
        let mut buffer = frame.buffer_crop(x, y, x + w, y + h)?;
        let stride = buffer.row_pitch() as usize;
        let raw = buffer.as_raw_buffer();
        pixels::pack_nv12(raw, stride, w as usize, h as usize, &mut self.pixels)?;
        self.encoder
            .lock()
            .map_err(|_| "录屏编码器锁异常")?
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
        let audio_result = self.audio.take().map_or(Ok(()), |mut audio| audio.stop());
        let Some(mut encoder) = self
            .encoder
            .lock()
            .map_err(|_| "录屏编码器锁异常".to_string())?
            .take()
        else {
            return audio_result;
        };
        let has_frame = self.last_frame.is_some();
        let result = if has_frame {
            encoder
                .send_frame_buffer(&self.pixels, self.clock.elapsed()?)
                .map_err(|e| format!("写入最后一帧失败：{e}"))
        } else {
            Err("未捕获到录屏画面，请检查显示器或系统捕获设置".into())
        };
        let finished = encoder.finish().map_err(|e| format!("保存 MP4 失败：{e}"));
        audio_result.and(result).and(finished)
    }
}

impl Drop for Recorder {
    /// 捕获初始化失败或回调提前释放时，先回收音频线程。
    fn drop(&mut self) {
        if let Some(mut audio) = self.audio.take() {
            let _ = audio.stop();
        }
    }
}

impl Recording {
    /// 录制主屏的物理像素区域；H.264 奇数宽高向内裁去最多一像素。
    pub fn start(
        path: &Path,
        rect: (u32, u32, u32, u32),
        audio_source: &str,
        audio_enabled: bool,
        hardware_encoding: bool,
    ) -> Result<Self, String> {
        if audio_enabled && audio_source.is_empty() {
            return Err("请选择录屏音频源".into());
        }
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
                audio_source: audio_source.into(),
                audio_enabled,
                hardware_encoding,
            },
        );
        let control = Recorder::start_free_threaded(settings)
            .map_err(|e| format!("启动 Windows 录屏失败：{e}"))?;
        Ok(Self {
            control: Some(control),
        })
    }

    /// 视频或音频线程停止后通知调用方收尾并获取错误。
    pub fn is_finished(&self) -> bool {
        self.control.as_ref().is_none_or(|control| {
            control.is_finished()
                || control
                    .callback()
                    .lock()
                    .audio
                    .as_ref()
                    .is_some_and(AudioCapture::is_finished)
        })
    }

    /// 先停止捕获线程，再在已初始化 WinRT 的线程完成编码。
    pub fn stop(mut self) -> Result<(), String> {
        self.finish()
    }

    /// 停止视频捕获，回收音频线程，再完成 MP4 封装。
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
    /// 释放录制对象时执行与显式停止相同的收尾。
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
