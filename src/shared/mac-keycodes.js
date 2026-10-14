// 浏览器 KeyboardEvent.code 到 macOS 虚拟键码（CGKeyCode）的映射。
// 以物理键位（event.code）为准，避免输入法/布局带来的字符差异。
export const MAC_KEYCODES = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
  BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44,
  KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119,
  PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124,
  ArrowDown: 125, ArrowUp: 126, F1: 122, F2: 120, F3: 99, F4: 118,
  F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

// CGEventFlags 修饰键掩码。
export const FLAG = {
  shift: 1 << 17,
  control: 1 << 18,
  alternate: 1 << 19,
  command: 1 << 20,
};

// 展示用的按键名称（未列出的回退为 code 去前缀）。
const KEY_DISPLAY = {
  Enter: "↩", Tab: "⇥", Space: "Space", Backspace: "⌫", Delete: "⌦",
  Escape: "Esc", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑",
  ArrowDown: "↓", Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
};

function displayName(code) {
  if (KEY_DISPLAY[code]) return KEY_DISPLAY[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return code;
}

// 把一次按键事件（含修饰键）转换为可模拟的按键。
// 仅按下修饰键（无主键）时返回 null，等待主键。
export function buildKeyStroke(event, isMac = true) {
  const keycode = MAC_KEYCODES[event.code];
  if (keycode === undefined) return null;
  let flags = 0;
  if (event.metaKey) flags += FLAG.command;
  if (event.ctrlKey) flags += FLAG.control;
  if (event.altKey) flags += FLAG.alternate;
  if (event.shiftKey) flags += FLAG.shift;
  const parts = [];
  if (event.metaKey) parts.push(isMac ? "⌘" : "Win");
  if (event.ctrlKey) parts.push(isMac ? "⌃" : "Ctrl");
  if (event.altKey) parts.push(isMac ? "⌥" : "Alt");
  if (event.shiftKey) parts.push(isMac ? "⇧" : "Shift");
  parts.push(isMac ? displayName(event.code) : event.code.replace(/^Key|^Digit/, ""));
  return { keycode, flags, label: parts.join(isMac ? "" : "+") };
}
