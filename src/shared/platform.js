// WebView 的系统标识只用于展示；原生能力由后端编译平台决定。
export const IS_MAC = typeof navigator === "undefined"
  || /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || "");

export function shortcutText(value, isMac = IS_MAC) {
  const symbols = {
    CommandOrControl: isMac ? "⌘" : "Ctrl", CmdOrCtrl: isMac ? "⌘" : "Ctrl",
    Command: isMac ? "⌘" : "Win", Cmd: isMac ? "⌘" : "Win", Super: isMac ? "⌘" : "Win",
    Control: isMac ? "⌃" : "Ctrl", Ctrl: isMac ? "⌃" : "Ctrl",
    Alt: isMac ? "⌥" : "Alt", Option: isMac ? "⌥" : "Alt", Shift: isMac ? "⇧" : "Shift",
    Up: "↑", Down: "↓", Left: "←", Right: "→",
    Enter: isMac ? "↩" : "Enter", Tab: isMac ? "⇥" : "Tab",
    Backspace: isMac ? "⌫" : "Backspace", Delete: isMac ? "⌦" : "Del", Space: "空格",
  };
  return value.split("+").map((part) => symbols[part] || part).join(isMac ? " " : "+");
}
