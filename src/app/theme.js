import { getStoredTheme, saveSettings, setStoredTheme } from "../core/settings.js";

// 三种主题模式：跟随系统、浅色、深色。
export const THEMES = ["system", "light", "dark"];

let currentTheme = "system";
let media = null;

// 跟随系统时根据系统偏好解析出实际使用的浅色/深色。
function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return media && media.matches ? "dark" : "light";
}

// 把解析后的主题写到根节点，供 CSS 变量和原生控件配色使用。
function applyResolvedTheme(theme) {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved;
}

// 系统偏好变化时，仅在“跟随系统”下实时更新界面。
function onSystemChange() {
  if (currentTheme === "system") applyResolvedTheme("system");
}

export function getTheme() {
  return currentTheme;
}

// 选中态只反映在卡片高亮上，输入框负责语义与无障碍。
function syncThemeOptions() {
  document.querySelectorAll?.(".theme-option").forEach((option) => {
    const selected = option.dataset.themeValue === currentTheme;
    option.classList.toggle("is-active", selected);
    const input = option.querySelector("input");
    if (input) input.checked = selected;
  });
}

// 设置并持久化主题，立即生效。
export function setTheme(theme, { persist = true } = {}) {
  currentTheme = THEMES.includes(theme) ? theme : "system";
  setStoredTheme(currentTheme);
  syncThemeOptions();
  applyResolvedTheme(currentTheme);
  if (persist) saveSettings();
}

// 初始化主题：绑定系统偏好监听与主题卡片，并应用已加载的设置值。
export function setupTheme() {
  currentTheme = getStoredTheme();
  if (!media && typeof window !== "undefined" && window.matchMedia) {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", onSystemChange);
  }
  document.querySelectorAll?.(".theme-option input").forEach((input) => {
    input.addEventListener("change", () => setTheme(input.value));
  });
  syncThemeOptions();
  applyResolvedTheme(currentTheme);
}
