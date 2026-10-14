#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    pub fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    pub fn CGEventCreateMouseEvent(
        source: *const std::ffi::c_void,
        event_type: u32,
        point: CGPoint,
        mouse_button: u32,
    ) -> *mut std::ffi::c_void;
    pub fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
    pub fn CGEventCreateKeyboardEvent(
        source: *const std::ffi::c_void,
        keycode: u16,
        key_down: bool,
    ) -> *mut std::ffi::c_void;
    pub fn CGEventSetFlags(event: *mut std::ffi::c_void, flags: u64);
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGRequestScreenCaptureAccess() -> bool;
    pub fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXIsProcessTrusted() -> bool;
    pub fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    pub static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub static kCFBooleanTrue: *const std::ffi::c_void;
    pub static kCFTypeDictionaryKeyCallBacks: std::ffi::c_void;
    pub static kCFTypeDictionaryValueCallBacks: std::ffi::c_void;
    pub fn CFDictionaryCreate(
        allocator: *const std::ffi::c_void,
        keys: *const *const std::ffi::c_void,
        values: *const *const std::ffi::c_void,
        num_values: isize,
        key_callbacks: *const std::ffi::c_void,
        value_callbacks: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
}
