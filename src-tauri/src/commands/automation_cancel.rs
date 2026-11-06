//! 自动化运行生命周期与协作取消，不依赖系统输入或截图 API。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const CANCELLED: &str = "自动化操作已取消";

/// 每个应用持有独立注册表；已取得的 token 在 end 后仍保持取消状态。
#[derive(Default)]
pub struct AutomationState(Mutex<HashMap<String, AutomationRun>>);

/// 运行条目持有后台活动，结束某个脚本不会释放其他脚本的保护。
struct AutomationRun {
    operation: Operation,
    #[cfg(target_os = "macos")]
    _activity: crate::platform::macos_activity::AutomationActivity,
}

/// None 表示旧调用不参与取消；互斥锁使取消与单次副作用具有明确顺序。
#[derive(Clone, Default)]
pub struct Operation(Option<Arc<Token>>);

#[derive(Default)]
struct Token {
    cancelled: AtomicBool,
    effect: Mutex<()>,
}

impl Operation {
    /// 按原生单调时钟等待，最多每 50ms 检查取消，不依赖 WebView 定时器。
    fn wait(&self, duration_ms: u64) -> Result<(), String> {
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(duration_ms))
            .ok_or("自动化等待时间超出支持范围")?;
        loop {
            self.check()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            std::thread::sleep(remaining.min(Duration::from_millis(50)));
        }
    }

    /// 测试无需系统 API 即可观察取消请求，且不等待当前 stroke 释放。
    #[cfg(test)]
    pub(super) fn is_cancelled(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|token| token.cancelled.load(Ordering::SeqCst))
    }

    /// 检查是否取消，不在系统截图或 PNG 编码期间持锁。
    pub fn check(&self) -> Result<(), String> {
        self.with_active(|| Ok(()))
    }

    /// 检查后获准的副作用不可拆分；取消请求不会中断已获准的按下/释放或写入。
    pub fn with_active<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let guard = self
            .0
            .as_ref()
            .map(|token| {
                token
                    .effect
                    .lock()
                    .map_err(|_| "自动化取消锁不可用".to_string())
            })
            .transpose()?;
        if self
            .0
            .as_ref()
            .is_some_and(|token| token.cancelled.load(Ordering::SeqCst))
        {
            return Err(CANCELLED.into());
        }
        let result = action();
        // 在副作用完成（尤其 key-up）之前，cancel 不得确认完成。
        drop(guard);
        result
    }

    /// 先标记取消阻止后续按键争锁，再等待当前副作用完成释放。
    fn cancel(&self) -> Result<(), String> {
        if let Some(token) = &self.0 {
            token.cancelled.store(true, Ordering::SeqCst);
            drop(token.effect.lock().map_err(|_| "自动化取消锁不可用")?);
        }
        Ok(())
    }
}

impl AutomationState {
    /// 查询注册表的实际运行状态，包含正在取消但尚未完成清理的脚本。
    #[cfg(any(target_os = "macos", test))]
    fn has_runs(&self) -> Result<bool, String> {
        Ok(!self.0.lock().map_err(|_| "自动化注册表不可用")?.is_empty())
    }

    /// 创建全新运行，拒绝重复 begin，防止意外复活已取消的 token。
    pub(super) fn begin(&self, run_id: String) -> Result<(), String> {
        if run_id.trim().is_empty() {
            return Err("runId 不能为空".into());
        }
        let mut runs = self.0.lock().map_err(|_| "自动化注册表不可用")?;
        if runs.contains_key(&run_id) {
            return Err("自动化 runId 已存在，请先 end 或使用新的 ID".into());
        }
        runs.insert(
            run_id,
            AutomationRun {
                operation: Operation(Some(Arc::new(Token::default()))),
                #[cfg(target_os = "macos")]
                _activity: crate::platform::macos_activity::AutomationActivity::begin(),
            },
        );
        Ok(())
    }

    /// 获取运行 token；显式但未知的 ID 必须失败，不能退化成不受控执行。
    pub fn operation(&self, run_id: Option<&str>) -> Result<Operation, String> {
        match run_id {
            None => Ok(Operation::default()),
            Some(id) => self
                .0
                .lock()
                .map_err(|_| "自动化注册表不可用")?
                .get(id)
                .map(|run| run.operation.clone())
                .ok_or_else(|| "自动化运行不存在或已结束".into()),
        }
    }

    /// 幂等取消；不持注册表锁等待正在进行的单个副作用。
    pub(super) fn cancel(&self, run_id: &str) -> Result<(), String> {
        let operation = self
            .0
            .lock()
            .map_err(|_| "自动化注册表不可用")?
            .get(run_id)
            .map(|run| run.operation.clone());
        if let Some(operation) = operation {
            operation.cancel()?;
        }
        Ok(())
    }

    /// 移除运行并取消仍在执行的旧 token；后续同名 begin 不影响旧任务。
    pub(super) fn end(&self, run_id: &str) -> Result<(), String> {
        let run = {
            let mut runs = self.0.lock().map_err(|_| "自动化注册表不可用")?;
            let run = runs.remove(run_id);
            // 从注册表消失前发布取消，避免其他调用看到不存在时旧任务仍可开始。
            if let Some(token) = run.as_ref().and_then(|run| run.operation.0.as_ref()) {
                token.cancelled.store(true, Ordering::SeqCst);
            }
            run
        };
        if let Some(run) = run {
            run.operation.cancel()?;
        }
        Ok(())
    }
}

/// 在 WebView 线程读取最新任务状态，避免并行 begin/end 的旧结果覆盖新策略。
#[cfg(target_os = "macos")]
fn sync_background_policy(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("主窗口不存在，无法更新后台策略")?;
    let policy_app = app.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = policy_app
                .state::<AutomationState>()
                .has_runs()
                .and_then(|active| {
                    crate::platform::macos_webview::set_background_task_active(&webview, active)
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("更新后台运行策略失败：{error}"))?
}

/// 注册一次自动化运行，调用方应使用每次运行唯一的 runId。
#[tauri::command(async)]
pub fn begin_automation_operation(
    run_id: String,
    state: tauri::State<'_, AutomationState>,
    #[allow(unused_variables)] app: tauri::AppHandle,
) -> Result<(), String> {
    state.begin(run_id.clone())?;
    #[cfg(target_os = "macos")]
    if let Err(error) = sync_background_policy(&app) {
        // 开始失败时前端尚未取得运行所有权，必须在这里回收并恢复策略。
        let _ = state.end(&run_id);
        let _ = sync_background_policy(&app);
        return Err(error);
    }
    Ok(())
}

/// 协作取消运行；不会强杀系统截图或删除已完成的结果。
#[tauri::command(async)]
pub fn cancel_automation_operation(
    run_id: String,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    state.cancel(&run_id)
}

/// Windows 步骤和轮次等待使用阻塞任务池，前端通过 IPC 完成通知继续执行。
#[tauri::command]
pub async fn wait_automation_operation(
    run_id: String,
    duration_ms: u64,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    let operation = state.operation(Some(&run_id))?;
    tauri::async_runtime::spawn_blocking(move || operation.wait(duration_ms))
        .await
        .map_err(|error| format!("自动化等待任务异常：{error}"))?
}

/// 幂等结束运行并释放注册表条目，旧任务仍保持取消。
#[tauri::command(async)]
pub fn end_automation_operation(
    run_id: String,
    state: tauri::State<'_, AutomationState>,
    #[allow(unused_variables)] app: tauri::AppHandle,
) -> Result<(), String> {
    let result = state.end(&run_id);
    #[cfg(target_os = "macos")]
    {
        // 即使取消清理返回错误，也要按剩余任务状态尝试恢复后台策略。
        let policy_result = sync_background_policy(&app);
        result.and(policy_result)
    }
    #[cfg(not(target_os = "macos"))]
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 等待可被其他线程及时取消，不必等原始截止时间。
    #[test]
    fn native_wait_responds_to_cancellation() {
        let state = AutomationState::default();
        state.begin("wait".into()).unwrap();
        let operation = state.operation(Some("wait")).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender.send(operation.wait(60_000)).unwrap();
        });
        state.cancel("wait").unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(CANCELLED.into())
        );
        worker.join().unwrap();
        state.end("wait").unwrap();
    }

    /// 零等待仍检查运行权限，已结束的 token 不能继续执行。
    #[test]
    fn native_wait_checks_active_token() {
        let state = AutomationState::default();
        state.begin("wait".into()).unwrap();
        let operation = state.operation(Some("wait")).unwrap();
        operation.wait(0).unwrap();
        state.end("wait").unwrap();
        assert_eq!(operation.wait(0).unwrap_err(), CANCELLED);
    }

    /// 取消和重复结束不能提前恢复默认策略；最后一个注册任务结束才变为空闲。
    #[test]
    fn background_policy_tracks_all_registered_runs() {
        let state = AutomationState::default();
        assert!(!state.has_runs().unwrap());
        state.begin("a".into()).unwrap();
        state.begin("b".into()).unwrap();
        state.cancel("a").unwrap();
        assert!(state.has_runs().unwrap());
        state.end("a").unwrap();
        state.end("a").unwrap();
        assert!(state.has_runs().unwrap());
        assert!(state.begin("b".into()).is_err());
        assert!(state.has_runs().unwrap());
        state.end("b").unwrap();
        assert!(!state.has_runs().unwrap());
    }

    /// 覆盖旧调用、未知 ID、重复 begin、取消幂等与不同运行隔离。
    #[test]
    fn lifecycle_is_isolated_and_fail_closed() {
        let state = AutomationState::default();
        assert!(state.begin(" ".into()).is_err());
        assert!(state.operation(Some("missing")).is_err());
        state.begin("a".into()).unwrap();
        state.begin("b".into()).unwrap();
        let a = state.operation(Some("a")).unwrap();
        state.cancel("a").unwrap();
        state.cancel("a").unwrap();
        assert_eq!(a.check().unwrap_err(), CANCELLED);
        assert!(state.begin("a".into()).is_err());
        state.operation(Some("b")).unwrap().check().unwrap();
        state.operation(None).unwrap().check().unwrap();
        state.end("a").unwrap();
        state.end("a").unwrap();
        assert!(state.operation(Some("a")).is_err());
        state.begin("a".into()).unwrap();
        state.operation(Some("a")).unwrap().check().unwrap();
        assert_eq!(a.check().unwrap_err(), CANCELLED);
        state.cancel("missing").unwrap();
    }

    /// end 必须取消已经被命令取得的 token，而不只是删除 map 条目。
    #[test]
    fn end_cancels_in_flight_operation() {
        let state = AutomationState::default();
        state.begin("run".into()).unwrap();
        let operation = state.operation(Some("run")).unwrap();
        state.end("run").unwrap();
        assert_eq!(operation.check().unwrap_err(), CANCELLED);
    }

    /// 取消必须等待已开始的副作用完成，且返回后不得再开始副作用。
    #[test]
    fn cancellation_serializes_with_side_effects() {
        let state = Arc::new(AutomationState::default());
        state.begin("run".into()).unwrap();
        let operation = state.operation(Some("run")).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker_operation = operation.clone();
        let worker = std::thread::spawn(move || {
            worker_operation.with_active(|| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        started_rx.recv().unwrap();
        assert!(operation.0.as_ref().unwrap().effect.try_lock().is_err());
        let cancel = std::thread::spawn(move || state.cancel("run"));
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        cancel.join().unwrap().unwrap();
        assert_eq!(
            operation
                .with_active::<()>(|| panic!("取消后不得执行"))
                .unwrap_err(),
            CANCELLED
        );
    }
}
