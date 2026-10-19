//! 自动化运行生命周期与协作取消，不依赖系统输入或截图 API。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const CANCELLED: &str = "自动化操作已取消";

/// 每个应用持有独立注册表；已取得的 token 在 end 后仍保持取消状态。
#[derive(Default)]
pub struct AutomationState(Mutex<HashMap<String, Operation>>);

/// None 表示旧调用不参与取消；互斥锁使取消与单次副作用具有明确顺序。
#[derive(Clone, Default)]
pub struct Operation(Option<Arc<Token>>);

#[derive(Default)]
struct Token {
    cancelled: AtomicBool,
    effect: Mutex<()>,
}

impl Operation {
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
    /// 创建全新运行，拒绝重复 begin，防止意外复活已取消的 token。
    pub(super) fn begin(&self, run_id: String) -> Result<(), String> {
        if run_id.trim().is_empty() {
            return Err("runId 不能为空".into());
        }
        let mut runs = self.0.lock().map_err(|_| "自动化注册表不可用")?;
        if runs.contains_key(&run_id) {
            return Err("自动化 runId 已存在，请先 end 或使用新的 ID".into());
        }
        runs.insert(run_id, Operation(Some(Arc::new(Token::default()))));
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
                .cloned()
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
            .cloned();
        if let Some(operation) = operation {
            operation.cancel()?;
        }
        Ok(())
    }

    /// 移除运行并取消仍在执行的旧 token；后续同名 begin 不影响旧任务。
    pub(super) fn end(&self, run_id: &str) -> Result<(), String> {
        let operation = {
            let mut runs = self.0.lock().map_err(|_| "自动化注册表不可用")?;
            let operation = runs.remove(run_id);
            // 从注册表消失前发布取消，避免其他调用看到不存在时旧任务仍可开始。
            if let Some(Operation(Some(token))) = &operation {
                token.cancelled.store(true, Ordering::SeqCst);
            }
            operation
        };
        if let Some(operation) = operation {
            operation.cancel()?;
        }
        Ok(())
    }
}

/// 注册一次自动化运行，调用方应使用每次运行唯一的 runId。
#[tauri::command]
pub fn begin_automation_operation(
    run_id: String,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    state.begin(run_id)
}

/// 协作取消运行；不会强杀系统截图或删除已完成的结果。
#[tauri::command(async)]
pub fn cancel_automation_operation(
    run_id: String,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    state.cancel(&run_id)
}

/// 幂等结束运行并释放注册表条目，旧任务仍保持取消。
#[tauri::command(async)]
pub fn end_automation_operation(
    run_id: String,
    state: tauri::State<'_, AutomationState>,
) -> Result<(), String> {
    state.end(&run_id)
}

#[cfg(test)]
mod tests {
    use super::*;

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
