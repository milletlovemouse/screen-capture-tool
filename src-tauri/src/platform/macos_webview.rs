//! 仅在自动化运行期间覆盖 WKWebView 的后台调度策略。
use std::cell::RefCell;

use objc2::{msg_send, rc::Retained, runtime::AnyObject, sel, MainThreadMarker};

// WebKit 的 WKInactiveSchedulingPolicyNone；与 NSInteger 的 ABI 保持一致。
const SCHEDULING_NONE: isize = 2;

#[derive(Default)]
struct BackgroundPolicy {
    original: Option<(usize, isize)>,
}

impl BackgroundPolicy {
    /// 首次活动保存原策略；重复活动不覆盖，空闲时恢复对应 WebView 的策略。
    fn update(&mut self, view: usize, active: bool, current: isize) -> Option<isize> {
        if active {
            if self.original.is_none_or(|(id, _)| id != view) {
                self.original = Some((view, current));
            }
            Some(SCHEDULING_NONE)
        } else {
            self.original
                .take()
                .filter(|(id, _)| *id == view)
                .map(|(_, policy)| policy)
        }
    }
}

thread_local! {
    static BACKGROUND_POLICY: RefCell<BackgroundPolicy> = RefCell::default();
}

/// 由 Tauri 的 with_webview 在主线程调用；旧系统不支持该属性时保留系统行为。
pub fn set_background_task_active(
    webview: &tauri::webview::PlatformWebview,
    active: bool,
) -> Result<(), String> {
    let _main_thread = MainThreadMarker::new().ok_or("后台策略必须在主线程更新")?;
    let view_ptr = webview.inner();
    // PlatformWebview 在回调期间持有有效 WKWebView，所有消息均在主线程发送。
    unsafe {
        let view = view_ptr
            .cast::<AnyObject>()
            .as_ref()
            .ok_or("主 WebView 已释放")?;
        // configuration 虽为副本，其 WKPreferences 仍与页面共享；只更新偏好属性。
        let configuration: Retained<AnyObject> = msg_send![view, configuration];
        let preferences: Retained<AnyObject> = msg_send![&*configuration, preferences];
        let getter: bool =
            msg_send![&*preferences, respondsToSelector: sel!(inactiveSchedulingPolicy)];
        let setter: bool =
            msg_send![&*preferences, respondsToSelector: sel!(setInactiveSchedulingPolicy:)];
        if !getter || !setter {
            return Ok(());
        }
        let current: isize = msg_send![&*preferences, inactiveSchedulingPolicy];
        let policy = BACKGROUND_POLICY.with(|state| {
            state
                .borrow_mut()
                .update(view_ptr as usize, active, current)
        });
        if let Some(policy) = policy {
            let _: () = msg_send![&*preferences, setInactiveSchedulingPolicy: policy];
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// 重复任务同步不能把已禁用策略当成原策略，最后一次结束恢复最初值。
    fn concurrent_runs_restore_original_policy() {
        let mut policy = BackgroundPolicy::default();
        assert_eq!(policy.update(1, false, 0), None);
        assert_eq!(policy.update(1, true, 1), Some(SCHEDULING_NONE));
        assert_eq!(
            policy.update(1, true, SCHEDULING_NONE),
            Some(SCHEDULING_NONE)
        );
        assert_eq!(policy.update(1, false, SCHEDULING_NONE), Some(1));
        assert_eq!(policy.update(1, false, 1), None);
    }

    #[test]
    /// WebView 重建后重新记录默认值，旧窗口的快照不会覆盖新窗口策略。
    fn recreated_view_keeps_its_own_default() {
        let mut policy = BackgroundPolicy::default();
        policy.update(1, true, 1);
        policy.update(2, true, 0);
        assert_eq!(policy.update(2, false, SCHEDULING_NONE), Some(0));
    }
}
