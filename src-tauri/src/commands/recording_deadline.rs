//! 独立于 WebView 和录制状态锁的自动录制计时任务。
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub struct DeadlineRecording {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<Result<String, String>>>,
}

impl DeadlineRecording {
    /// 工作线程独占本次录制；到期或提前停止时只执行一次原生收尾。
    pub fn start(
        duration: Duration,
        finish: impl FnOnce() -> Result<String, String> + Send + 'static,
    ) -> Self {
        let deadline = Instant::now() + duration;
        let (stop, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
            finish()
        });
        Self {
            stop,
            worker: Some(worker),
        }
    }

    /// 查询不等待写入队列；成功或失败的结果均保留到显式领取。
    pub fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// 唤醒计时线程，等待正在进行的收尾，返回缓存的保存结果。
    pub fn stop(mut self) -> Result<String, String> {
        self.finish()
    }

    /// 消费线程句柄，避免到期、取消与资源释放重复停止原生采集。
    fn finish(&mut self) -> Result<String, String> {
        let _ = self.stop.send(());
        self.worker
            .take()
            .ok_or_else(|| "录制结果已领取".to_string())?
            .join()
            .map_err(|_| "自动录制线程异常退出".to_string())?
    }
}

impl Drop for DeadlineRecording {
    /// 应用退出或启动取消时，也唤醒并回收独占的录制任务。
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.finish();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// 没有前端停止请求，原生线程仍会到期执行并保留结果。
    fn deadline_stops_without_frontend() {
        let (sender, receiver) = mpsc::channel();
        let recording = DeadlineRecording::start(Duration::from_millis(20), move || {
            sender.send(()).unwrap();
            Ok("saved.mov".into())
        });
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        // finish 发信号时可能尚未返回，stop 负责等待最终结果。
        assert_eq!(recording.stop().unwrap(), "saved.mov");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    /// 提前取消无需等待原截止时间，且错误仍原样交给调用方。
    fn early_stop_preserves_error() {
        let recording =
            DeadlineRecording::start(Duration::from_secs(60), || Err("encoder failed".into()));
        assert_eq!(recording.stop().unwrap_err(), "encoder failed");
    }

    #[test]
    /// 资源释放只结束自己的任务，不留下稍后触发的旧定时器。
    fn drop_stops_owned_recording() {
        let (sender, receiver) = mpsc::channel();
        let recording = DeadlineRecording::start(Duration::from_secs(60), move || {
            sender.send(()).unwrap();
            Ok("saved.mov".into())
        });
        drop(recording);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receiver.try_recv().is_err());
    }
}
