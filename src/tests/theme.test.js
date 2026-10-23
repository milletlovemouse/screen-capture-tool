import assert from "node:assert/strict";
import test from "node:test";

// 构造最小 DOM/环境替身，隔离验证主题模块的解析、持久化与系统跟随。
function setupEnv({ prefersDark = false, stored = null } = {}) {
  const store = new Map();
  if (stored) store.set("sct-settings", JSON.stringify(stored));
  const root = { attrs: {}, style: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const mediaListeners = [];
  const media = {
    matches: prefersDark,
    addEventListener: (_name, cb) => mediaListeners.push(cb),
  };
  // 模拟三张主题卡片，每张含一个隐藏 radio。
  const options = ["light", "dark", "system"].map((value) => {
    const input = { value, checked: false, listeners: new Map(), addEventListener(name, cb) { this.listeners.set(name, cb); } };
    const option = {
      dataset: { themeValue: value },
      classes: new Set(),
      classList: {
        toggle: (name, on) => { on ? option.classes.add(name) : option.classes.delete(name); },
      },
      querySelector: () => input,
      input,
    };
    return option;
  });
  global.document = {
    documentElement: root,
    getElementById: () => ({ value: "", classList: { contains: () => false, add() {} } }),
    querySelector: () => ({ classList: { contains: () => false, add() {} } }),
    querySelectorAll: (selector) =>
      selector === ".theme-option" ? options : options.map((option) => option.input),
  };
  global.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  global.window = { matchMedia: () => media };
  const pick = (value) => options.find((option) => option.dataset.themeValue === value);
  return { root, options, pick, media, mediaListeners, store };
}

test("跟随系统主题按系统偏好解析明暗，并随系统变化实时更新", async () => {
  const env = setupEnv({ prefersDark: true });
  const { setupTheme } = await import("../app/theme.js");
  const { loadSettings } = await import("../core/settings.js");
  loadSettings();
  setupTheme();
  assert.equal(env.root.attrs["data-theme"], "dark");
  assert.equal(env.root.style.colorScheme, "dark");

  env.media.matches = false;
  env.mediaListeners.forEach((cb) => cb());
  assert.equal(env.root.attrs["data-theme"], "light");
});

test("选择浅色/深色时覆盖系统偏好并写入本地设置", async () => {
  const env = setupEnv({ prefersDark: true });
  const { setupTheme, setTheme, getTheme } = await import("../app/theme.js");
  const { loadSettings } = await import("../core/settings.js");
  loadSettings();
  setupTheme();

  const light = env.pick("light");
  light.input.listeners.get("change")();
  assert.equal(getTheme(), "light");
  assert.equal(env.root.attrs["data-theme"], "light");
  assert.equal(light.classes.has("is-active"), true);
  assert.equal(env.pick("dark").classes.has("is-active"), false);
  assert.match(env.store.get("sct-settings"), /"theme":"light"/);

  setTheme("dark");
  assert.equal(env.root.attrs["data-theme"], "dark");
  assert.equal(env.pick("dark").classes.has("is-active"), true);
  assert.equal(env.pick("dark").input.checked, true);
});

test("已保存的主题在加载后恢复", async () => {
  const env = setupEnv({ prefersDark: false, stored: { theme: "dark" } });
  const { setupTheme, getTheme } = await import("../app/theme.js");
  const { loadSettings } = await import("../core/settings.js");
  loadSettings();
  setupTheme();
  assert.equal(getTheme(), "dark");
  assert.equal(env.root.attrs["data-theme"], "dark");
  assert.equal(env.pick("dark").classes.has("is-active"), true);
});
