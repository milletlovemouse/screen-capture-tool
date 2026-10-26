import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.js";

test("新设置及旧设置默认关闭音频，并持久化选择的真实设备 ID", () => {
  const h = harness();
  assert.equal(h.evaluate("getAudioEnabled()"), false);
  h.storage.set("sct-settings", JSON.stringify({ theme: "light" }));
  h.evaluate("loadSettings()");
  assert.equal(h.evaluate("getAudioSourceId()"), "system");
  assert.equal(h.evaluate("getAudioEnabled()"), false);
  h.evaluate('setAudioSourceId("device-usb-mic")');
  assert.equal(JSON.parse(h.storage.get("sct-settings")).audioSourceId, "device-usb-mic");
  h.evaluate("loadSettings()");
  assert.equal(h.evaluate("getAudioSourceId()"), "device-usb-mic");
});

test("开关持久化并回填 UI，关闭再启用不清除设备选择", async () => {
  const h = harness();
  h.evaluate('setAudioSourceId("usb-mic"); setAudioEnabled(true); loadSettings(); setupAudioSources()');
  const toggle = h.elements.get("audio-enabled");
  assert.equal(toggle.checked, true);
  assert.equal(h.evaluate("getAudioEnabled()"), true);
  toggle.checked = false;
  toggle.listeners.get("change")();
  let saved = JSON.parse(h.storage.get("sct-settings"));
  assert.equal(saved.audioEnabled, false);
  assert.equal(saved.audioSourceId, "usb-mic");
  h.evaluate("loadSettings()");
  assert.equal(h.evaluate("getAudioEnabled()"), false);
  toggle.checked = true;
  toggle.listeners.get("change")();
  saved = JSON.parse(h.storage.get("sct-settings"));
  assert.equal(saved.audioEnabled, true);
  assert.equal(saved.audioSourceId, "usb-mic");
  await h.evaluate("refreshAudioSources()");
});

test("旧字段缺失或非布尔 true 不能意外启用音频", () => {
  const h = harness();
  for (const value of [undefined, false, null, 1, "true"]) {
    h.evaluate("setAudioEnabled(true)");
    h.storage.set("sct-settings", JSON.stringify({ audioEnabled: value, audioSourceId: "usb-mic" }));
    h.evaluate("loadSettings(); setupAudioSources()");
    assert.equal(h.evaluate("getAudioEnabled()"), false);
    assert.equal(h.elements.get("audio-enabled").checked, false);
    assert.equal(h.evaluate("getAudioSourceId()"), "usb-mic");
  }
});

test("设备渲染为两列表格，断连设备不被静默替换", () => {
  const h = harness();
  h.evaluate('setAudioSourceId("unplugged"); renderAudioSources([{id:"system",name:"系统声音",kind:"内置"}])');
  const rows = h.elements.get("audio-sources-body").children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.length, 2);
  assert.equal(rows[0].role, "radio");
  assert.equal(rows[0]["aria-checked"], "false");
  assert.equal(rows[1].tabIndex, -1);
  assert.equal(rows[1].children[0].textContent, "已选设备（未连接）");
  assert.equal(h.evaluate("getAudioSourceId()"), "unplugged");
});

test("点击音频来源整行即可切换设备，不渲染单选框", () => {
  const h = harness();
  h.evaluate('renderAudioSources([{id:"system",name:"系统声音",kind:"内置"},{id:"mic",name:"麦克风",kind:"麦克风"}])');
  const row = h.elements.get("audio-sources-body").children[1];
  assert.equal(row.children.length, 2);
  assert.equal(row.children[0].children.length, 0);
  row.listeners.get("click")();
  assert.equal(h.evaluate("getAudioSourceId()"), "mic");
  assert.equal(row["aria-checked"], "true");
  assert.equal(h.elements.get("audio-sources-body").children[0]["aria-checked"], "false");
});

test("手动录屏默认显式传 false，启用后传递 true 和所选来源", async () => {
  const h = harness();
  await h.evaluate("toggleRecording()");
  assert.equal(h.calls.find((call) => call.command === "start_recording").args.audioSourceId, "system");
  assert.equal(h.calls.find((call) => call.command === "start_recording").args.audioEnabled, false);
  h.evaluate("stopRecordingMonitor(); setRecordingActive(false); setAudioSourceId('usb-mic'); setAudioEnabled(true)");
  await h.evaluate("toggleRecording()");
  assert.equal(h.calls.filter((call) => call.command === "start_recording").at(-1).args.audioSourceId, "usb-mic");
  assert.equal(h.calls.filter((call) => call.command === "start_recording").at(-1).args.audioEnabled, true);
  h.evaluate("stopRecordingMonitor()");
});

for (const entry of ["manual", "automation"]) {
  for (const source of ["system", "usb-mic"]) {
    test(`${entry} 录屏启用来源 ${source} 后关闭仍保留设备并传 false`, async () => {
      const h = harness();
      h.evaluate(`setAudioSourceId(${JSON.stringify(source)})`);
      for (const enabled of [false, true, false, true]) {
        h.evaluate(`setAudioEnabled(${enabled})`);
        if (entry === "manual") {
          await h.evaluate("toggleRecording()");
          await h.evaluate("toggleRecording()");
        } else {
          await h.run({ steps: [{ type: "record", duration: 0 }], runMode: "once" });
        }
        const args = h.calls.filter((call) => call.command === "start_recording").at(-1).args;
        assert.equal(args.audioEnabled, enabled);
        assert.equal(args.audioSourceId, source);
      }
    });
  }
}

test("设备刷新失败保留已有选择，详情仅保存在 title", async () => {
  const h = harness();
  await h.evaluate("refreshAudioSources()");
  const previous = h.elements.get("audio-sources-body").children;
  await h.evaluate('invoke = async () => { throw new Error("device unavailable"); }; refreshAudioSources()');
  assert.equal(h.elements.get("audio-sources-body").children, previous);
  assert.match(h.elements.get("audio-sources-table").title, /device unavailable/);
  assert.equal(h.elements.get("refresh-audio-sources").disabled, false);
  assert.equal(h.evaluate("getAudioSourceId()"), "system");
});

test("设备刷新乱序返回时，只使用最新设备列表", async () => {
  const h = harness();
  h.evaluate(`
    globalThis.pendingAudioLists = [];
    invoke = () => new Promise((resolve) => pendingAudioLists.push(resolve));
    globalThis.firstAudioRefresh = refreshAudioSources();
    globalThis.secondAudioRefresh = refreshAudioSources();
    pendingAudioLists[1]([{id:"system",name:"最新列表",kind:"内置"}]);
  `);
  await h.evaluate("secondAudioRefresh");
  h.evaluate('pendingAudioLists[0]([{id:"system",name:"旧列表",kind:"内置"}])');
  await h.evaluate("firstAudioRefresh");
  const name = h.elements.get("audio-sources-body").children[0].children[0];
  assert.equal(name.textContent, "最新列表");
});
