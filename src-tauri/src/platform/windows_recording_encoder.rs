//! 可选择硬件加速的 NV12 → H.264 路径，颜色转换由程序统一完成。
use super::super::windows_audio::timeline::{ALIGN, BITS, CHANNELS, RATE};
use super::output::{RecordingOutput, VIDEO_DURATION};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use windows::{
    core::{AgileReference, Error, Interface, Result, HSTRING},
    Foundation::{PropertyValue, TimeSpan, TypedEventHandler},
    Media::{
        Core::{
            AudioStreamDescriptor, MediaStreamSample, MediaStreamSource,
            MediaStreamSourceErrorStatus, MediaStreamSourceSampleRequestedEventArgs,
            MediaStreamSourceStartingEventArgs, VideoStreamDescriptor,
        },
        MediaProperties::{
            AudioEncodingProperties, ContainerEncodingProperties, MediaEncodingProfile,
            MediaEncodingSubtypes, VideoEncodingProperties,
        },
        Transcoding::MediaTranscoder,
    },
    Security::Cryptography::CryptographicBuffer,
    Storage::{FileAccessMode, StorageFile, Streams::IRandomAccessStream},
    System::Threading::{ThreadPool, WorkItemHandler, WorkItemOptions, WorkItemPriority},
    Win32::Media::MediaFoundation::{
        MFNominalRange_16_235, MFVideoPrimaries_BT709, MFVideoTransFunc_sRGB,
        MFVideoTransferMatrix_BT709, MF_MT_DEFAULT_STRIDE, MF_MT_TRANSFER_FUNCTION,
        MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX,
    },
};

type Sample = Option<(Vec<u8>, i64)>;

struct InitializingStream(Option<IRandomAccessStream>);

impl Drop for InitializingStream {
    /// 构造中途失败时显式关闭输出，不能仅依赖 COM 引用释放。
    fn drop(&mut self) {
        if let Some(stream) = self.0.take() {
            let _ = stream.Close();
        }
    }
}

pub(in super::super) struct VideoEncoder {
    source: MediaStreamSource,
    starting: i64,
    requested: i64,
    video: Option<mpsc::SyncSender<Sample>>,
    audio: Option<mpsc::Sender<Sample>>,
    transcode: Option<std::thread::JoinHandle<Result<()>>>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
    delivered: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<Error>>>,
    frame_bytes: usize,
    audio_enabled: bool,
    audio_frames: u64,
    stream: AgileReference<IRandomAccessStream>,
    output: Option<RecordingOutput>,
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
        set_color_properties(&output)?;
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

        // 输入已经完成 RGB → YUV，避免两种编码模式继续依赖系统 BGRA 转换器。
        let input = VideoEncodingProperties::CreateUncompressed(
            &MediaEncodingSubtypes::Nv12()?,
            width,
            height,
        )?;
        input.FrameRate()?.SetNumerator(30)?;
        input.FrameRate()?.SetDenominator(1)?;
        input.PixelAspectRatio()?.SetNumerator(1)?;
        input.PixelAspectRatio()?.SetDenominator(1)?;
        set_color_properties(&input)?;
        input
            .Properties()?
            .Insert(MF_MT_DEFAULT_STRIDE, &PropertyValue::CreateUInt32(width)?)?;
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
        // 桌面可能长时间静止，不能等待后续画面填满预缓冲。
        source.SetBufferTime(TimeSpan { Duration: 0 })?;
        let starting = source.Starting(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceStartingEventArgs,
        >::new(|_, args| {
            args.as_ref()
                .ok_or_else(Error::empty)?
                .Request()?
                .SetActualStartPosition(TimeSpan { Duration: 0 })
        }))?;
        // 编码落后时最多保留两帧，避免无界积压放大延迟和内存占用。
        let (video, video_rx) = mpsc::sync_channel::<Sample>(2);
        let (audio, audio_rx) = mpsc::channel::<Sample>();
        let video_rx = Arc::new(Mutex::new(video_rx));
        let audio_rx = Arc::new(Mutex::new(audio_rx));
        let delivered = Arc::new(AtomicBool::new(false));
        let first_delivered = delivered.clone();
        let failure = Arc::new(Mutex::new(None));
        let sample_failure = failure.clone();
        let requested = source.SampleRequested(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceSampleRequestedEventArgs,
        >::new(move |sender, args| {
            let source = sender.as_ref().ok_or_else(Error::empty)?.clone();
            let event_result = (|| {
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
                let completion = deferral.clone();
                let delivered = first_delivered.clone();
                let failure = sample_failure.clone();
                let worker_source = source.clone();
                // 等待样本不能阻塞 MSS 事件线程，EOS 后必须完成 deferral。
                let scheduled = ThreadPool::RunWithPriorityAndOptionsAsync(
                    &WorkItemHandler::new(move |_| {
                        let mut video_sample = false;
                        let result = (|| {
                            let receiver = receiver.lock().map_err(|_| Error::empty())?;
                            let sample = loop {
                                match receiver.recv_timeout(std::time::Duration::from_millis(500)) {
                                    Err(mpsc::RecvTimeoutError::Timeout) => {
                                        request.ReportSampleProgress(0)?;
                                    }
                                    result => break result,
                                }
                            };
                            match sample {
                                Ok(Some((bytes, timestamp))) => {
                                    let buffer = CryptographicBuffer::CreateFromByteArray(&bytes)?;
                                    let sample = MediaStreamSample::CreateFromBuffer(
                                        &buffer,
                                        TimeSpan {
                                            Duration: timestamp,
                                        },
                                    )?;
                                    sample.SetDuration(TimeSpan {
                                        Duration: if is_audio {
                                            (bytes.len() / ALIGN) as i64 * 10_000_000 / RATE as i64
                                        } else {
                                            VIDEO_DURATION
                                        },
                                    })?;
                                    request.SetSample(&sample)?;
                                    video_sample = !is_audio;
                                    Ok(())
                                }
                                _ => request.SetSample(None),
                            }
                        })();
                        let completed = deferral.Complete();
                        let result = result.and(completed);
                        // Processed 表示管线释放样本，编码器可能保留它直到收到更多帧。
                        // 只在真实视频样本交付和 deferral 完成均成功后确认启动。
                        if result.is_ok() && video_sample {
                            delivered.store(true, Ordering::Release);
                        }
                        if let Err(error) = &result {
                            if let Ok(mut failure) = failure.lock() {
                                failure.get_or_insert_with(|| error.clone());
                            }
                            let _ = worker_source.NotifyError(MediaStreamSourceErrorStatus::Other);
                        }
                        result
                    }),
                    WorkItemPriority::Normal,
                    WorkItemOptions::None,
                );
                if let Err(error) = scheduled {
                    let _ = completion.Complete();
                    return Err(error);
                }
                Ok(())
            })();
            if let Err(error) = &event_result {
                if let Ok(mut failure) = sample_failure.lock() {
                    failure.get_or_insert_with(|| error.clone());
                }
                let _ = source.NotifyError(MediaStreamSourceErrorStatus::Other);
            }
            event_result
        }))?;

        let transcoder = MediaTranscoder::new()?;
        transcoder.SetHardwareAccelerationEnabled(hardware_encoding)?;
        let output = RecordingOutput::new(std::path::Path::new(path)).map_err(|e| {
            Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                format!("创建录屏文件失败：{e}"),
            )
        })?;
        let full_path = std::fs::canonicalize(output.path()).map_err(|e| {
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
        // 在所有后续可失败操作之前建立关闭守卫，先关流再清理临时文件。
        let mut initializing_stream = InitializingStream(Some(stream.clone()));
        let stream_reference = AgileReference::new(&stream)?;
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
        let cancellation = transcode.clone();
        let transcode = std::thread::spawn(move || {
            let result = transcode.join();
            drop(transcoder);
            result
        });
        // 编码器接管关闭职责，局部守卫只释放引用。
        initializing_stream.0.take();
        Ok(Self {
            source,
            starting,
            requested,
            video: Some(video),
            audio: Some(audio),
            transcode: Some(transcode),
            cancel: Some(Box::new(move || {
                let _ = cancellation.Cancel();
            })),
            delivered,
            failure,
            frame_bytes: width as usize * height as usize * 3 / 2,
            audio_enabled,
            audio_frames: 0,
            stream: stream_reference,
            output: Some(output),
        })
    }

    /// 提交自有 NV12 副本，沿用共享时钟的 100 ns 时间戳。
    pub(in super::super) fn send_frame_buffer(
        &mut self,
        bytes: &[u8],
        timestamp: i64,
    ) -> Result<()> {
        if bytes.len() != self.frame_bytes {
            return Err(Error::new(
                windows::core::HRESULT(0x80070057u32 as i32),
                "NV12 帧长度与编码尺寸不一致",
            ));
        }
        self.check_status()?;
        match self
            .video
            .as_ref()
            .ok_or_else(Error::empty)?
            .try_send(Some((bytes.to_vec(), timestamp)))
        {
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(_)) => Err(Error::empty()),
        }
    }

    /// 收尾帧不能因队满丢弃，否则静止画面的结束时间会被截短。
    pub(in super::super) fn send_final_frame(
        &mut self,
        bytes: &[u8],
        timestamp: i64,
    ) -> Result<()> {
        // 调用方已回收音频线程；先结束音频，避免管线等音频而不消费视频。
        self.audio.take();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut sample = Some((bytes.to_vec(), timestamp));
        loop {
            self.check_status()?;
            match self
                .video
                .as_ref()
                .ok_or_else(Error::empty)?
                .try_send(sample)
            {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Disconnected(_)) => return Err(Error::empty()),
                Err(mpsc::TrySendError::Full(pending)) => sample = pending,
            }
            if std::time::Instant::now() >= deadline {
                return Err(Error::new(
                    windows::core::HRESULT(0x800705B4u32 as i32),
                    "等待录屏尾帧交付超时",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
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
    pub(super) fn check_status(&mut self) -> Result<()> {
        if let Some(error) = self.failure.lock().map_err(|_| Error::empty())?.clone() {
            return Err(error);
        }
        if self.transcode.as_ref().is_none_or(|t| t.is_finished()) {
            self.wait()?;
            return Err(Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                "转码已提前结束",
            ));
        }
        Ok(())
    }

    /// 真实视频样本交付后检查异步错误，入队成功本身不代表管线已接收。
    pub(super) fn startup_ready(&mut self) -> Result<bool> {
        let delivered = self.delivered.load(Ordering::Acquire);
        self.check_status()?;
        Ok(delivered)
    }

    /// 发送双流 EOS，等待 MP4 索引写完；Drop 负责事件清理。
    pub(in super::super) fn finish(mut self) -> Result<()> {
        self.close_streams();
        self.wait()?;
        if let Some(error) = self.failure.lock().map_err(|_| Error::empty())?.clone() {
            return Err(error);
        }
        self.stream.resolve()?.Close()?;
        // 先释放 MSS 和转码操作持有的文件句柄，再发布成品及清理临时链接。
        let mut output = self.output.take().ok_or_else(Error::empty)?;
        drop(self);
        output.publish().map_err(|e| {
            Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                format!("发布录屏文件失败：{e}"),
            )
        })
    }

    /// EOS 后关闭所有发送端，使并发样本请求也能结束等待。
    fn close_streams(&mut self) {
        // Receiver 会先消费已入队帧，随后由断开连接得到 EOS；关闭时不阻塞有界队列。
        self.video.take();
        if let Some(audio) = self.audio.take() {
            let _ = audio.send(None);
        }
    }

    /// 取回转码线程结果，确保只等待一次。
    fn wait(&mut self) -> Result<()> {
        let result = self.transcode.take().map_or(Ok(()), |t| {
            t.join().unwrap_or_else(|_| {
                Err(Error::new(
                    windows::core::HRESULT(0x80004005u32 as i32),
                    "录屏转码线程异常",
                ))
            })
        });
        self.cancel.take();
        if let Err(error) = &result {
            if let Ok(mut failure) = self.failure.lock() {
                failure.get_or_insert_with(|| error.clone());
            }
        }
        // 样本处理错误发生在 NotifyError 之前，优先保留它而非后续通用转码错误。
        match self.failure.lock().map_err(|_| Error::empty())?.clone() {
            Some(error) => Err(error),
            None => result,
        }
    }
}

/// 与实际像素转换保持一致：BT.709 矩阵、有限范围，保留 SDR 桌面的 sRGB 传递函数。
fn set_color_properties(video: &VideoEncodingProperties) -> Result<()> {
    let properties = video.Properties()?;
    for (key, value) in [
        (MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32),
        (MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_sRGB.0 as u32),
        (MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32),
        (MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32),
    ] {
        properties.Insert(key, &PropertyValue::CreateUInt32(value)?)?;
    }
    Ok(())
}

impl Drop for VideoEncoder {
    /// 初始化后提前退出也唤醒样本请求，再释放 MSS 事件。
    fn drop(&mut self) {
        self.close_streams();
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
        let _ = self.wait();
        let _ = self.source.RemoveStarting(self.starting);
        let _ = self.source.RemoveSampleRequested(self.requested);
        if let Ok(stream) = self.stream.resolve() {
            let _ = stream.Close();
        }
    }
}
