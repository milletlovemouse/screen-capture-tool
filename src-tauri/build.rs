/// 编译并静态链接 macOS 原生采集桥接及 Swift 运行库。
fn build_macos_bridge() {
    use std::{env, path::PathBuf, process::Command};
    let source = "src/platform/macos_recording.swift";
    println!("cargo:rerun-if-changed={source}");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("macos_recording.o");
    let archive = out.join("libsct_recording.a");
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("不支持的 macOS 架构：{other:?}"),
    };
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    // Intel 与应用最低版本一致；Apple Silicon 最早从 macOS 11 提供支持。
    let minimum = if arch == "arm64" { (11, 0) } else { (10, 15) };
    let configured = env::var("MACOSX_DEPLOYMENT_TARGET")
        .unwrap_or_else(|_| format!("{}.{}", minimum.0, minimum.1));
    let version: Vec<u32> = configured
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    let requested = (
        version.first().copied().unwrap_or(0),
        version.get(1).copied().unwrap_or(0),
    );
    let deployment = if requested < minimum {
        format!("{}.{}", minimum.0, minimum.1)
    } else {
        configured
    };
    let target = format!("{arch}-apple-macosx{deployment}");
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-swift-version",
            "5",
            "-parse-as-library",
            "-O",
            "-emit-object",
            "-target",
            &target,
            source,
            "-o",
        ])
        .arg(&object)
        .status()
        .expect("需要 Xcode Command Line Tools 和 Swift 编译器");
    assert!(status.success(), "Swift 录屏桥接编译失败");
    assert!(
        Command::new("xcrun")
            .args(["ar", "crs"])
            .arg(&archive)
            .arg(&object)
            .status()
            .expect("ar")
            .success(),
        "Swift 静态库打包失败"
    );
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=sct_recording");
    let info = Command::new("xcrun")
        .args(["swiftc", "-print-target-info", "-target", &target])
        .output()
        .expect("Swift target info");
    assert!(info.status.success(), "无法读取 Swift 运行库路径");
    let info: serde_json::Value = serde_json::from_slice(&info.stdout).expect("Swift target JSON");
    for path in info["paths"]["runtimeLibraryPaths"]
        .as_array()
        .expect("Swift runtime paths")
    {
        println!(
            "cargo:rustc-link-search=native={}",
            path.as_str().expect("runtime path")
        );
    }
    // Mach-O 对象的 LC_LINKER_OPTION 会自动链接其余 Swift 模块。
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    // 旧系统仍可使用麦克风路径，避免启动时强制加载新框架。
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    for framework in [
        "AVFoundation",
        "CoreMedia",
        "CoreVideo",
        "CoreGraphics",
        "Foundation",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}

/// 在目标为 macOS 时构建原生桥接，再生成 Tauri 资源。
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_macos_bridge();
    }
    tauri_build::build()
}
