import { invoke } from "@tauri-apps/api/core";
import { $ } from "../core/dom.js";
import { getAudioEnabled, setAudioEnabled, getAudioSourceId, setAudioSourceId } from "../core/settings.js";

let audioSourcesGeneration = 0;

// 将真实音频设备渲染为名称、类型两列，整行用于选择来源。
function renderAudioSources(sources) {
  const body = $("audio-sources-body");
  if (!body) return;
  const selected = getAudioSourceId();
  const devices = [...sources];
  if (!devices.some((source) => source.id === selected)) {
    devices.push({ id: selected, name: "已选设备（未连接）", kind: "麦克风", unavailable: true });
  }
  body.replaceChildren();
  for (const source of devices) {
    const row = document.createElement("tr");
    const unavailable = Boolean(source.unavailable);
    row.tabIndex = unavailable ? -1 : 0;
    row.setAttribute("role", "radio");
    row.setAttribute("aria-checked", selected === source.id ? "true" : "false");
    const selectSource = () => {
      if (unavailable) return;
      setAudioSourceId(source.id);
      for (const sibling of body.children) {
        sibling.setAttribute("aria-checked", sibling === row ? "true" : "false");
      }
    };
    row.addEventListener("click", selectSource);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSource();
      }
    });
    const name = document.createElement("td");
    name.textContent = source.name;
    const kind = document.createElement("td");
    kind.textContent = ({ system: "内置", microphone: "麦克风" })[source.kind] || source.kind;
    row.append(name, kind);
    body.append(row);
  }
}

// 刷新热插拔设备；查询失败保留已显示列表，仅在 title 中提供错误详情。
export async function refreshAudioSources() {
  const generation = ++audioSourcesGeneration;
  const table = $("audio-sources-table");
  const button = $("refresh-audio-sources");
  if (button) button.disabled = true;
  try {
    const sources = await invoke("list_audio_sources");
    if (generation !== audioSourcesGeneration) return;
    if (!Array.isArray(sources)) throw new Error("音频设备列表不可用");
    renderAudioSources(sources);
    if (table) table.removeAttribute("title");
  } catch (error) {
    if (generation === audioSourcesGeneration && table) table.title = String(error);
  } finally {
    if (generation === audioSourcesGeneration && button) button.disabled = false;
  }
}

// 先显示默认系统来源，再在后台加载真实设备。
export function setupAudioSources() {
  const toggle = $("audio-enabled");
  if (toggle) {
    toggle.checked = getAudioEnabled();
    toggle.addEventListener("change", () => setAudioEnabled(toggle.checked));
  }
  renderAudioSources([{ id: "system", name: "系统声音", kind: "内置" }]);
  $("refresh-audio-sources")?.addEventListener("click", refreshAudioSources);
  void refreshAudioSources();
}
