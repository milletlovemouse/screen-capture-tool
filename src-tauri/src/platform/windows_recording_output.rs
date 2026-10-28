//! 只管理本次独占创建的输出，失败时不触碰用户的目标文件。
use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_OUTPUT: AtomicU64 = AtomicU64::new(0);
pub(super) const VIDEO_DURATION: i64 = 10_000_000 / 30;

pub(super) struct RecordingOutput {
    path: PathBuf,
    destination: PathBuf,
    moved: bool,
}

impl RecordingOutput {
    /// 在目标目录独占创建临时输出，拒绝已有目标，避免截断或误删。
    pub(super) fn new(destination: &Path) -> io::Result<Self> {
        match fs::symlink_metadata(destination) {
            Ok(_) => return Err(io::ErrorKind::AlreadyExists.into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        loop {
            let id = NEXT_OUTPUT.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(".sct-{}-{id}.partial.mp4", std::process::id()));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => {
                    return Ok(Self {
                        path,
                        destination: destination.into(),
                        moved: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }

    /// 返回本次拥有的临时文件，供 WinRT 打开。
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// MP4 完成后发布，目标在录制期间出现时也禁止覆盖。
    pub(super) fn publish(&mut self) -> io::Result<()> {
        if fs::metadata(&self.path)?.len() == 0 {
            return Err(io::Error::other("录屏输出为空"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::{core::PCWSTR, Win32::Storage::FileSystem::MoveFileW};

            let source: Vec<u16> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = self
                .destination
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            // MoveFileW 不替换已有目标，同目录移动也不要求文件系统支持硬链接。
            unsafe { MoveFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr())) }
                .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?;
            self.moved = true;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            fs::hard_link(&self.path, &self.destination)
        }
    }
}

impl Drop for RecordingOutput {
    /// 只删除本次成功独占创建的临时输出。
    fn drop(&mut self) {
        if !self.moved {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 为每个测试独占创建目录，避免并行测试相互干扰。
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sct-output-test-{}-{}",
            std::process::id(),
            NEXT_OUTPUT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    /// 模拟创建后的初始化失败，零字节临时文件随作用域清理。
    #[test]
    fn removes_empty_output_on_initialization_failure() {
        let dir = directory();
        let destination = dir.join("recording.mp4");
        let temporary = {
            let output = RecordingOutput::new(&destination).unwrap();
            output.path().to_path_buf()
        };
        assert!(!temporary.exists());
        assert!(!destination.exists());
        fs::remove_dir(dir).unwrap();
    }

    /// 非空失败输出也应清理，目标位置仍不产生损坏文件。
    #[test]
    fn removes_partial_output_on_failure() {
        let dir = directory();
        let destination = dir.join("recording.mp4");
        let output = RecordingOutput::new(&destination).unwrap();
        fs::write(output.path(), b"partial").unwrap();
        let temporary = output.path().to_path_buf();
        drop(output);
        assert!(!temporary.exists());
        assert!(!destination.exists());
        fs::remove_dir(dir).unwrap();
    }

    /// 目标已存在时保留用户内容，包括原本就是零字节的文件。
    #[test]
    fn preserves_existing_files() {
        let dir = directory();
        let destination = dir.join("recording.mp4");
        for bytes in [b"user data".as_slice(), b"".as_slice()] {
            fs::write(&destination, bytes).unwrap();
            assert!(matches!(
                RecordingOutput::new(&destination),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists
            ));
            assert_eq!(fs::read(&destination).unwrap(), bytes);
        }
        fs::remove_file(destination).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    /// 发布前出现的同名文件必须保留，清理只作用于自己的临时输出。
    #[test]
    fn preserves_destination_created_during_recording() {
        let dir = directory();
        let destination = dir.join("recording.mp4");
        let mut output = RecordingOutput::new(&destination).unwrap();
        fs::write(output.path(), b"video").unwrap();
        fs::write(&destination, b"user data").unwrap();
        assert_eq!(
            output.publish().unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        drop(output);
        assert_eq!(fs::read(&destination).unwrap(), b"user data");
        fs::remove_file(destination).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    /// 只发布非空成功输出，临时路径清理后成品仍可读取。
    #[test]
    fn publishes_only_nonempty_output() {
        let dir = directory();
        let destination = dir.join("recording.mp4");
        let mut output = RecordingOutput::new(&destination).unwrap();
        assert!(output.publish().is_err());
        fs::write(output.path(), b"finished mp4").unwrap();
        output.publish().unwrap();
        let temporary = output.path().to_path_buf();
        drop(output);
        assert!(!temporary.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"finished mp4");
        fs::remove_file(destination).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    /// 视频样本时长与既有 30 fps 配置一致，单位为 100 ns。
    #[test]
    fn video_duration_matches_frame_rate() {
        assert_eq!(VIDEO_DURATION, 333_333);
    }

    /// Unicode 和空格路径应完整保留，Windows 宽字符移动不能损坏文件名。
    #[test]
    fn publishes_unicode_destination() {
        let dir = directory();
        let destination = dir.join("录屏 test.mp4");
        let mut output = RecordingOutput::new(&destination).unwrap();
        fs::write(output.path(), b"video").unwrap();
        output.publish().unwrap();
        drop(output);
        assert_eq!(fs::read(&destination).unwrap(), b"video");
        fs::remove_file(destination).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    /// Windows 移动成功后不再拥有原路径，不能删除后来在原路径创建的文件。
    #[cfg(windows)]
    #[test]
    fn preserves_reused_temporary_path_after_move() {
        let dir = directory();
        let destination = dir.join("recording.mp4");
        let mut output = RecordingOutput::new(&destination).unwrap();
        fs::write(output.path(), b"video").unwrap();
        let temporary = output.path().to_path_buf();
        output.publish().unwrap();
        fs::write(&temporary, b"another file").unwrap();
        drop(output);
        assert_eq!(fs::read(&temporary).unwrap(), b"another file");
        assert_eq!(fs::read(&destination).unwrap(), b"video");
        fs::remove_file(temporary).unwrap();
        fs::remove_file(destination).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
