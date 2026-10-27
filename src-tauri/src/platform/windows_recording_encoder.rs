//! 可选择硬件加速的 BGRA → H.264 路径，支持关闭加速以兼容虚拟机。
use super::super::windows_audio::timeline::{ALIGN, BITS, CHANNELS, RATE};
use std::sync::{mpsc, Arc, Mutex};
use windows::{
    core::{Error, Interface, Result, HSTRING},
    Foundation::{TimeSpan, TypedEventHandler},
    Media::{
        Core::{
            AudioStreamDescriptor, MediaStreamSample, MediaStreamSource,
            MediaStreamSourceSampleRequestedEventArgs, MediaStreamSourceStartingEventArgs,
            VideoStreamDescriptor,
        },
        MediaProperties::{
            AudioEncodingProperties, ContainerEncodingProperties, MediaEncodingProfile,
            MediaEncodingSubtypes, VideoEncodingProperties,
        },
        Transcoding::MediaTranscoder,
    },
    Security::Cryptography::CryptographicBuffer,
    Storage::{FileAccessMode, StorageFile},
    System::Threading::{ThreadPool, WorkItemHandler, WorkItemOptions, WorkItemPriority},
};

type Sample = Option<(Vec<u8>, i64)>;

pub(in super::super) struct VideoEncoder {
    source: MediaStreamSource,
    starting: i64,
    requested: i64,
    video: Option<mpsc::Sender<Sample>>,
    audio: Option<mpsc::Sender<Sample>>,
    transcode: Option<std::thread::JoinHandle<Result<()>>>,
    frame_bytes: usize,
    audio_enabled: bool,
    audio_frames: u64,
}

impl VideoEncoder {
    /// 保持现有 30 fps / 15 Mbps / AAC 参数，按用户选择配置硬件转码。
    pub(in super::super) fn new(
        width: u32,
        height: u32,
        audio_enabled: bool,
        hardware_encoding: bool,
        path: &str,
    ) -> Result<Self> {
        let profile = MediaEncodingProfile::new()?;
        let output = VideoEncodingProperties::new()?;
        output.SetSubtype(&MediaEncodingSubtypes::H264()?)?;
        output.SetWidth(width)?;
        output.SetHeight(height)?;
        output.SetBitrate(15_000_000)?;
        output.FrameRate()?.SetNumerator(30)?;
        output.FrameRate()?.SetDenominator(1)?;
        output.PixelAspectRatio()?.SetNumerator(1)?;
        output.PixelAspectRatio()?.SetDenominator(1)?;
        profile.SetVideo(&output)?;
        let container = ContainerEncodingProperties::new()?;
        container.SetSubtype(&MediaEncodingSubtypes::Mpeg4()?)?;
        profile.SetContainer(&container)?;
        if audio_enabled {
            let audio = AudioEncodingProperties::new()?;
            audio.SetSubtype(&MediaEncodingSubtypes::Aac()?)?;
            audio.SetSampleRate(RATE as u32)?;
            audio.SetChannelCount(CHANNELS as u32)?;
            audio.SetBitsPerSample(BITS as u32)?;
            audio.SetBitrate(192_000)?;
            profile.SetAudio(&audio)?;
        } else {
            profile.SetAudio(None)?;
        }

        // 与 windows-capture 2.0.1 相同的输入契约：紧密排列、倒序行的 BGRA8。
        let input = VideoEncodingProperties::CreateUncompressed(
            &MediaEncodingSubtypes::Bgra8()?,
            width,
            height,
        )?;
        input.FrameRate()?.SetNumerator(30)?;
        input.FrameRate()?.SetDenominator(1)?;
        let video_desc = VideoStreamDescriptor::Create(&input)?;
        let source = if audio_enabled {
            let pcm =
                AudioEncodingProperties::CreatePcm(RATE as u32, CHANNELS as u32, BITS as u32)?;
            MediaStreamSource::CreateFromDescriptors(
                &video_desc,
                &AudioStreamDescriptor::Create(&pcm)?,
            )?
        } else {
            MediaStreamSource::CreateFromDescriptor(&video_desc)?
        };
        source.SetBufferTime(TimeSpan { Duration: 300_000 })?;
        let starting = source.Starting(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceStartingEventArgs,
        >::new(|_, args| {
            args.as_ref()
                .ok_or_else(Error::empty)?
                .Request()?
                .SetActualStartPosition(TimeSpan { Duration: 0 })
        }))?;
        let (video, video_rx) = mpsc::channel::<Sample>();
        let (audio, audio_rx) = mpsc::channel::<Sample>();
        let video_rx = Arc::new(Mutex::new(video_rx));
        let audio_rx = Arc::new(Mutex::new(audio_rx));
        let requested = source.SampleRequested(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceSampleRequestedEventArgs,
        >::new(move |_, args| {
            let request = args.as_ref().ok_or_else(Error::empty)?.Request()?;
            let is_audio = request
                .StreamDescriptor()?
                .cast::<AudioStreamDescriptor>()
                .is_ok();
            let receiver = if is_audio {
                audio_rx.clone()
            } else {
                video_rx.clone()
            };
            let deferral = request.GetDeferral()?;
            // 等待样本不能阻塞 MSS 事件线程，EOS 后必须完成 deferral。
            ThreadPool::RunWithPriorityAndOptionsAsync(
                &WorkItemHandler::new(move |_| {
                    let result = (|| {
                        let sample = receiver.lock().map_err(|_| Error::empty())?.recv();
                        match sample {
                            Ok(Some((bytes, timestamp))) => {
                                let buffer = CryptographicBuffer::CreateFromByteArray(&bytes)?;
                                let sample = MediaStreamSample::CreateFromBuffer(
                                    &buffer,
                                    TimeSpan {
                                        Duration: timestamp,
                                    },
                                )?;
                                if is_audio {
                                    sample.SetDuration(TimeSpan {
                                        Duration: (bytes.len() / ALIGN) as i64 * 10_000_000
                                            / RATE as i64,
                                    })?;
                                }
                                request.SetSample(&sample)
                            }
                            _ => request.SetSample(None),
                        }
                    })();
                    let completed = deferral.Complete();
                    result.and(completed)
                }),
                WorkItemPriority::Normal,
                WorkItemOptions::None,
            )?;
            Ok(())
        }))?;

        let transcoder = MediaTranscoder::new()?;
        transcoder.SetHardwareAccelerationEnabled(hardware_encoding)?;
        std::fs::File::create(path).map_err(|e| {
            Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                format!("创建录屏文件失败：{e}"),
            )
        })?;
        let full_path = std::fs::canonicalize(path).map_err(|e| {
            Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                format!("解析录屏文件路径失败：{e}"),
            )
        })?;
        let full_path = full_path.to_string_lossy();
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(
            full_path.strip_prefix(r"\\?\").unwrap_or(&full_path),
        ))?
        .join()?;
        let stream = file.OpenAsync(FileAccessMode::ReadWrite)?.join()?;
        let prepared = transcoder
            .PrepareMediaStreamSourceTranscodeAsync(&source, &stream, &profile)?
            .join()?;
        if !prepared.CanTranscode()? {
            return Err(Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                format!("H.264 转码不可用：{:?}", prepared.FailureReason()?),
            ));
        }
        let transcode = prepared.TranscodeAsync()?;
        let transcode = std::thread::spawn(move || {
            let result = transcode.join();
            drop(transcoder);
            result
        });
        Ok(Self {
            source,
            starting,
            requested,
            video: Some(video),
            audio: Some(audio),
            transcode: Some(transcode),
            frame_bytes: width as usize * height as usize * 4,
            audio_enabled,
            audio_frames: 0,
        })
    }

    /// 提交自有 BGRA 副本，沿用共享时钟的 100 ns 时间戳。
    pub(in super::super) fn send_frame_buffer(
        &mut self,
        bytes: &[u8],
        timestamp: i64,
    ) -> Result<()> {
        if bytes.len() != self.frame_bytes {
            return Err(Error::new(
                windows::core::HRESULT(0x80070057u32 as i32),
                "BGRA 帧长度与编码尺寸不一致",
            ));
        }
        self.check_status()?;
        self.video
            .as_ref()
            .ok_or_else(Error::empty)?
            .send(Some((bytes.to_vec(), timestamp)))
            .map_err(|_| Error::empty())
    }

    /// 与原编码器一致，用累计 PCM 帧数生成连续音频时间戳。
    pub(in super::super) fn send_audio_buffer(&mut self, bytes: &[u8], _: i64) -> Result<()> {
        if !self.audio_enabled || !bytes.len().is_multiple_of(ALIGN) {
            return Err(Error::empty());
        }
        self.check_status()?;
        let timestamp = (self.audio_frames as i128 * 10_000_000 / RATE as i128) as i64;
        self.audio
            .as_ref()
            .ok_or_else(Error::empty)?
            .send(Some((bytes.to_vec(), timestamp)))
            .map_err(|_| Error::empty())?;
        self.audio_frames += (bytes.len() / ALIGN) as u64;
        Ok(())
    }

    /// 在写入阶段就传播异步转码失败，避免错误后继续积压帧。
    fn check_status(&mut self) -> Result<()> {
        if self.transcode.as_ref().is_none_or(|t| t.is_finished()) {
            self.wait()?;
            return Err(Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                "转码已提前结束",
            ));
        }
        Ok(())
    }

    /// 发送双流 EOS，等待 MP4 索引写完；Drop 负责事件清理。
    pub(in super::super) fn finish(mut self) -> Result<()> {
        self.close_streams();
        self.wait()
    }

    /// EOS 后关闭所有发送端，使并发样本请求也能结束等待。
    fn close_streams(&mut self) {
        if let Some(video) = self.video.take() {
            let _ = video.send(None);
        }
        if let Some(audio) = self.audio.take() {
            let _ = audio.send(None);
        }
    }

    /// 取回转码线程结果，确保只等待一次。
    fn wait(&mut self) -> Result<()> {
        self.transcode
            .take()
            .map_or(Ok(()), |t| t.join().map_err(|_| Error::empty())?)
    }
}

impl Drop for VideoEncoder {
    /// 初始化后提前退出也唤醒样本请求，再释放 MSS 事件。
    fn drop(&mut self) {
        self.close_streams();
        let _ = self.wait();
        let _ = self.source.RemoveStarting(self.starting);
        let _ = self.source.RemoveSampleRequested(self.requested);
    }
}
