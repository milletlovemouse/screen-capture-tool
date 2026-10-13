# 截图工具

Tauri 2 桌面区域截图、录屏和自动化工具。前端使用 Vite、原生 JavaScript 与 pnpm。

## 平台能力

| 能力 | macOS | Windows |
| --- | --- | --- |
| 主屏区域截图、放大镜、选区调整 | xcap / CoreGraphics | xcap，逻辑坐标转物理像素 |
| 鼠标取点与模拟点击 | CoreGraphics | GetCursorPos / SendInput |
| 按键序列 | CGEvent | SendInput 扫描码，含扩展键和修饰键 |
| 录屏 | 系统 screencapture，MOV | Windows Graphics Capture + 系统 H.264 编码，MP4 |
| 保存通知定位文件 | Finder | 资源管理器 |
| 脚本编辑、复制、拖动排序、循环/指定次数 | 支持 | 支持 |
| 全局快捷键、托盘、窗口置顶 | 支持 | 支持；跨虚拟桌面置顶由系统限制 |

Windows 录屏目标为 Windows 10 1903 及以上、Windows 11，需要系统媒体编码组件和支持捕获的显卡驱动；不需要额外安装 FFmpeg。Windows N 版本可能需要系统的 Media Feature Pack。macOS 需要授予屏幕录制、辅助功能权限。窗口前端使用系统 WebView，Windows 安装器会引导安装 WebView2。

保持现有产品范围：框选、截图、录屏针对主显示器，尚未提供显示器选择或跨显示器选区。录屏不采集麦克风/系统音频。H.264 要求偶数尺寸，Windows 录屏会向内裁掉最多一像素。按键存储兼容历史脚本，Windows 将历史键码转换为物理扫描码；Command 修饰键在 Windows 对应 Win 键，Ctrl 保持 Ctrl。

Windows 模拟输入受系统权限隔离约束，普通权限工具不能控制管理员窗口或 UAC 安全桌面。不要为普通使用默认提权。

通知点击只处理应用仍在运行时新发出的通知；Windows 底层通知库不保证通知移入通知中心后的点击回调。开发模式的通知身份与安装版可能不同，最终验证请使用安装包。

## 开发与打包

安装 Node.js 24、pnpm 10 和 Rust stable。Windows 还需 Visual Studio Build Tools 的“使用 C++ 的桌面开发”和 Windows SDK；macOS 需 Xcode Command Line Tools。

```sh
pnpm install --registry https://registry.npmjs.org
pnpm tauri dev
```

在 macOS 上构建应用：

```sh
pnpm tauri build --bundles app
```

应用输出到 `src-tauri/target/release/bundle/macos/ScreenCaptureTool.app`。生成 DMG 可改用 `--bundles dmg`。

在 Windows 上构建安装器：

```sh
pnpm tauri build --bundles nsis
```

安装器输出到 `src-tauri/target/release/bundle/nsis/`。默认使用构建机器的 CPU 架构；跨架构包需要相应 Rust 目标和系统工具链。

## 验证

```sh
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

在 macOS 上检查 Windows 原生模块的类型和 API：

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --manifest-path checks/windows/Cargo.toml --target x86_64-pc-windows-msvc --target-dir src-tauri/target
```

此入口复用实际输入、键码映射和录屏源码，不执行系统输入或捕获，也不等于完整 Windows 应用打包。完整 Windows 构建需要 Windows SDK 资源编译器；`.github/workflows/desktop.yml` 提供两个平台的原生测试、构建和安装包产物任务，不发布 release。

实机验收重点：

- Windows 在 100%、125%、150% 缩放下验证框选、边框调整、截图和自动化点击位置一致。
- 录制主屏/部分区域/奇数尺寸区域；长时间静止后停止，确认文件时长和最后画面正常。
- 手动和自动化同时触发录屏时，确认只启动一个录屏任务；停止、错误和退出均完成清理。
- 在普通应用中回放 Ctrl/Command、Shift、Alt、方向键和标点组合，确认修饰键正常释放。
- 文件名带中文、空格或系统保留字符；点击新通知定位文件，删除文件后定位原目录。
- 在安装版上检查托盘后台运行、快捷键、通知和屏幕捕获权限。
