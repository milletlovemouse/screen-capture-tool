use std::{
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    core::{Interface, HSTRING},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::Audio::{
            eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
            IMMEndpoint, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
            AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, DEVICE_STATE_ACTIVE, WAVEFORMATEX,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
                CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
            },
            Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
        },
    },
};
use windows_capture::encoder::VideoEncoder;

use crate::commands::audio::AudioSource;

pub(super) type SharedEncoder = Arc<Mutex<Option<VideoEncoder>>>;
const RATE: u64 = 48_000;
const ALIGN: usize = 4;

struct ComApartment;

impl ComApartment {
    /// 在线程内初始化 COM，并与析构配对。
    fn new() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| format!("初始化音频 COM 失败：{e}"))?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    /// 在释放所有音频接口后退出 COM。
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// 在独立 COM 线程枚举稳定的 WASAPI 输入端点 ID 和友好名称。
pub fn list_sources() -> Result<Vec<AudioSource>, String> {
    thread::spawn(|| {
        let _com = ComApartment::new()?;
        let mut sources = vec![AudioSource {
            id: "system".into(),
            name: "系统声音".into(),
            kind: "system".into(),
        }];
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| format!("创建音频设备枚举器失败：{e}"))?;
            let devices = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("枚举麦克风失败：{e}"))?;
            for index in 0..devices.GetCount().map_err(|e| e.to_string())? {
                let device = devices.Item(index).map_err(|e| e.to_string())?;
                let id_ptr = device.GetId().map_err(|e| e.to_string())?;
                let id = id_ptr.to_string().map_err(|e| e.to_string());
                CoTaskMemFree(Some(id_ptr.0.cast()));
                let id = id?;
                let store = device
                    .OpenPropertyStore(STGM_READ)
                    .map_err(|e| e.to_string())?;
                let mut value = store
                    .GetValue(&PKEY_Device_FriendlyName)
                    .map_err(|e| e.to_string())?;
                let name = PropVariantToStringAlloc(&value).map_err(|e| e.to_string());
                let cleared = PropVariantClear(&mut value).map_err(|e| e.to_string());
                let name_ptr = name?;
                let name = name_ptr.to_string().map_err(|e| e.to_string());
                CoTaskMemFree(Some(name_ptr.0.cast()));
                cleared?;
                sources.push(AudioSource {
                    id,
                    name: name?,
                    kind: "microphone".into(),
                });
            }
        }
        Ok(sources)
    })
    .join()
    .map_err(|_| "枚举音频设备线程异常".to_string())?
}

#[derive(Clone)]
pub(super) struct Clock {
    origin: Arc<OnceLock<i64>>,
    frequency: i64,
}

impl Clock {
    /// 准备共享时钟，首视频帧到达前不设置时间基准。
    pub(super) fn new() -> Result<Self, String> {
        let mut frequency = 0;
        unsafe {
            QueryPerformanceFrequency(&mut frequency).map_err(|e| e.to_string())?;
        }
        if frequency <= 0 {
            return Err("系统性能计时器频率无效".into());
        }
        Ok(Self {
            origin: Arc::new(OnceLock::new()),
            frequency,
        })
    }

    /// 读取与 WASAPI 包 QPC 一致的绝对 100ns 时间。
    fn now(&self) -> Result<i64, String> {
        let mut counter = 0;
        unsafe { QueryPerformanceCounter(&mut counter).map_err(|e| e.to_string())? };
        Ok((counter as i128 * 10_000_000 / self.frequency as i128) as i64)
    }

    /// 首视频帧固定共享基准并返回精确的零，避免编码器再次平移时间轴。
    pub(super) fn set_anchor(&self) -> Result<i64, String> {
        let now = self.now()?;
        let origin = self.origin.get_or_init(|| now);
        Ok((now - origin).max(0))
    }

    /// 读取首视频帧之后经过的 100ns 数，未建立基准时拒绝计时。
    pub(super) fn elapsed(&self) -> Result<i64, String> {
        let origin = self.origin.get().ok_or("首视频帧尚未到达")?;
        Ok((self.now()? - origin).max(0))
    }
}

pub(super) struct AudioCapture {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<Result<(), String>>>,
}

impl AudioCapture {
    /// 等待 WASAPI 启动成功后返回，初始化失败立即传递给调用方。
    pub(super) fn start(
        source: String,
        encoder: SharedEncoder,
        clock: Clock,
    ) -> Result<Self, String> {
        let (stop, stopped) = mpsc::channel();
        let (ready, initialized) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let result = capture(&source, encoder, clock, stopped, &ready);
            if let Err(error) = &result {
                let _ = ready.try_send(Err(error.clone()));
            }
            result
        });
        match initialized.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                worker: Some(worker),
            }),
            result => {
                let _ = stop.send(());
                let _ = worker.join();
                Err(match result {
                    Ok(Err(error)) => error,
                    Err(error) => format!("音频采集线程启动失败：{error}"),
                    Ok(Ok(())) => unreachable!(),
                })
            }
        }
    }

    /// 检测音频线程是否因设备断开或编码错误提前退出。
    pub(super) fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// 通知停止并回收线程，同时返回采集和编码错误。
    pub(super) fn stop(&mut self) -> Result<(), String> {
        let _ = self.stop.send(());
        self.worker.take().map_or(Ok(()), |worker| {
            worker.join().map_err(|_| "音频采集线程异常".to_string())?
        })
    }
}

impl Drop for AudioCapture {
    /// 防止启动失败和异常退出时遗留采集线程。
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct PcmWriter {
    encoder: SharedEncoder,
    frames: u64,
}

impl PcmWriter {
    /// 按累计样本发送交错的 48kHz、双声道、16 位 PCM。
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.encoder
            .lock()
            .map_err(|_| "音频编码器锁异常".to_string())?
            .as_mut()
            .ok_or("音频编码器已停止")?
            .send_audio_buffer(bytes, (self.frames * 10_000_000 / RATE) as i64)
            .map_err(|e| format!("写入录屏音频失败：{e}"))?;
        self.frames += (bytes.len() / ALIGN) as u64;
        Ok(())
    }

    /// 补齐启动延迟、静音区间和设备丢包，适配编码器内部样本时钟。
    fn silence_until(&mut self, frame: u64) -> Result<(), String> {
        let silence = [0u8; 480 * ALIGN];
        while self.frames < frame {
            let count = (frame - self.frames).min(480) as usize;
            self.send(&silence[..count * ALIGN])?;
        }
        Ok(())
    }
}

/// 在同一 COM 线程内创建、轮询及释放 WASAPI，关闭设备后再结束线程。
fn capture(
    source: &str,
    encoder: SharedEncoder,
    clock: Clock,
    stopped: mpsc::Receiver<()>,
    ready: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let _com = ComApartment::new()?;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("创建音频设备枚举器失败：{e}"))?;
        let device = if source == "system" {
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
        } else {
            enumerator.GetDevice(&HSTRING::from(source))
        }
        .map_err(|e| format!("打开音频设备失败：{e}"))?;
        if source != "system" {
            let endpoint: IMMEndpoint = device.cast().map_err(|e| e.to_string())?;
            if endpoint.GetDataFlow().map_err(|e| e.to_string())? != eCapture {
                return Err("所选音频源不是输入设备".into());
            }
        }
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("激活音频设备失败：{e}"))?;
        let format = WAVEFORMATEX {
            wFormatTag: 1,
            nChannels: 2,
            nSamplesPerSec: RATE as u32,
            nAvgBytesPerSec: RATE as u32 * ALIGN as u32,
            nBlockAlign: ALIGN as u16,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
            | if source == "system" {
                AUDCLNT_STREAMFLAGS_LOOPBACK
            } else {
                0
            };
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, &format, None)
            .map_err(|e| format!("初始化 WASAPI PCM 采集失败：{e}"))?;
        let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
        client
            .Start()
            .map_err(|e| format!("启动音频采集失败：{e}"))?;
        let _ = ready.send(Ok(()));
        let mut writer = PcmWriter { encoder, frames: 0 };
        let result = (|| -> Result<(), String> {
            loop {
                let stopping = match stopped.recv_timeout(Duration::from_millis(5)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => true,
                    Err(mpsc::RecvTimeoutError::Timeout) => false,
                };
                let origin = clock.origin.get().copied();
                let end = match origin {
                    Some(origin) => (clock.now()? - origin).max(0) as u64 * RATE / 10_000_000,
                    None => 0,
                };
                while capture
                    .GetNextPacketSize()
                    .map_err(|e| format!("读取音频包失败：{e}"))?
                    > 0
                {
                    let (mut data, mut frames, mut flags, mut qpc) =
                        (std::ptr::null_mut(), 0, 0, 0);
                    capture
                        .GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))
                        .map_err(|e| format!("获取音频 PCM 失败：{e}"))?;
                    // 握手不等视频；首帧前持续释放设备包，既不编码也不补静音。
                    let Some(origin) = clock.origin.get().copied() else {
                        capture.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
                        continue;
                    };
                    // 先复制并释放 WASAPI 缓冲，编码失败也不会遗留设备缓冲锁。
                    let bytes = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        vec![0; frames as usize * ALIGN]
                    } else if data.is_null() {
                        let _ = capture.ReleaseBuffer(frames);
                        return Err("WASAPI 返回了无效 PCM 缓冲".into());
                    } else {
                        std::slice::from_raw_parts(data, frames as usize * ALIGN).to_vec()
                    };
                    capture.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
                    let end = (clock.now()? - origin).max(0) as u64 * RATE / 10_000_000;
                    let start = if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 {
                        end as i64 - frames as i64
                    } else {
                        ((qpc as i128 - origin as i128) * RATE as i128 / 10_000_000) as i64
                    };
                    let first = start.max(0) as u64;
                    writer.silence_until(first.min(end))?;
                    let skip = (writer.frames as i128 - start as i128)
                        .max(0)
                        .min(frames as i128) as usize;
                    let count =
                        (frames as usize - skip).min(end.saturating_sub(writer.frames) as usize);
                    writer.send(&bytes[skip * ALIGN..(skip + count) * ALIGN])?;
                }
                // 给正常到达的设备包保留 100ms；无输出的 loopback 仍持续产生静音。
                if origin.is_some() {
                    writer.silence_until(if stopping {
                        end
                    } else {
                        end.saturating_sub(RATE / 10)
                    })?;
                }
                if stopping {
                    return Ok(());
                }
            }
        })();
        let stopped = client.Stop().map_err(|e| format!("停止音频设备失败：{e}"));
        result.and(stopped)
    }
}
