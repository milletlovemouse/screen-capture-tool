// DOM 与状态栏的通用工具。
export const $ = (id) => document.getElementById(id);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function setStatus(text, type = "") {
  const el = $("status");
  if (!el) return;
  // 只展示操作过程中的交互提示；操作结果与错误反馈不再提示，清空状态栏即可
  if (type) {
    el.textContent = "";
    el.className = "status-text";
    return;
  }
  el.textContent = text;
  el.className = "status-text" + (type ? " " + type : "");
}
