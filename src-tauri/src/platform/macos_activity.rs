//! 自动化运行期间的 App Nap 与空闲系统休眠保护。
use objc2::{
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
};
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

pub struct AutomationActivity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

// NSProcessInfo 活动允许跨线程结束；token 仅由注册表独占，不跨线程并发访问。
unsafe impl Send for AutomationActivity {}

impl AutomationActivity {
    /// 从首个步骤前持有用户发起的活动，直到整段脚本结束。
    pub fn begin() -> Self {
        Self(
            NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiated,
                &NSString::from_str("正在执行自动化脚本"),
            ),
        )
    }
}

impl Drop for AutomationActivity {
    /// 正常完成、取消清理或应用退出时，成对释放当前运行的活动。
    fn drop(&mut self) {
        // token 只能由 beginActivity 创建，符合 endActivity 的类型要求。
        unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
    }
}
