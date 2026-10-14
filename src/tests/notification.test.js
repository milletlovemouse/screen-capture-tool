import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

test("save notifications register once and retain their own file paths", async () => {
  const h = harness();
  await h.evaluate(`Promise.all([
    notifySavedFile("截图成功", "/tmp/旧目录/图片 1.png"),
    notifySavedFile("录屏完成", "/tmp/新目录/录像.mov")
  ])`);
  assert.equal(h.notificationListeners.length, 1);
  assert.equal(h.actionTypes.length, 1);
  assert.equal(h.notifications.length, 2);
  h.evaluate('$("dir").value = "/tmp/another"');
  for (const notification of h.notifications) {
    await h.notificationListeners[0]({ actionId: "tap", notification });
  }
  assert.deepEqual(h.calls.map(({ command, args }) => [command, args.path]), [
    ["reveal_saved_file", "/tmp/旧目录/图片 1.png"],
    ["reveal_saved_file", "/tmp/新目录/录像.mov"],
  ]);
});

test("notification dismissal and notifications without saved files do nothing", async () => {
  const h = harness();
  await h.evaluate(`handleNotificationAction({
    actionId: "dismiss", notification: { extra: { savedPath: "/tmp/file.png" } }
  })`);
  await h.evaluate('handleNotificationAction({ actionId: "tap", notification: null })');
  await h.evaluate('handleNotificationAction({ actionId: "tap", notification: { extra: {} } })');
  assert.equal(h.calls.length, 0);
});

test("manual capture and recording notifications contain backend output paths", async () => {
  const h = harness();
  await h.evaluate("doCapture()");
  await h.evaluate("toggleRecording()");
  await h.evaluate("toggleRecording()");
  assert.deepEqual(h.notifications.map((n) => [n.title, n.extra.savedPath]), [
    ["截图成功", "/tmp/result"], ["录屏完成", "/tmp/result"],
  ]);
});

test("automation completion links its last output and plain scripts have no file link", async () => {
  const h = harness();
  h.evaluate(`const originalInvoke = invoke;
    invoke = async (command, args) => command === "stop_recording"
      ? "/tmp/last.mov" : originalInvoke(command, args)`);
  await h.run({ runMode: "once", steps: [
    { type: "capture" }, { type: "record", duration: 0 },
  ] });
  assert.equal(h.notifications[0].extra.savedPath, "/tmp/last.mov");
  await h.run({ runMode: "once", steps: [{ type: "wait", ms: 0 }] });
  assert.equal(h.notifications[1].extra, undefined);
});

test("notification open errors are swallowed without an unhandled rejection", async () => {
  const h = harness();
  h.evaluate('invoke = async () => { throw new Error("目录不存在"); }');
  await h.evaluate(`handleNotificationAction({
    actionId: "tap", notification: { extra: { savedPath: "/tmp/gone.png" } }
  })`);
  assert.equal(h.elements.get("status").textContent, "");
});

test("the registered notification action opens the same file as a body click", async () => {
  const h = harness();
  await h.evaluate('notifySavedFile("截图成功", "/tmp/图片.png")');
  const action = h.actionTypes[0].actions[0];
  assert.equal(action.title, "打开保存位置");
  for (const actionId of ["tap", action.id]) {
    await h.notificationListeners[0]({ actionId, notification: h.notifications[0] });
  }
  assert.deepEqual(h.calls.map(({ command, args }) => [command, args.path]), [
    ["reveal_saved_file", "/tmp/图片.png"], ["reveal_saved_file", "/tmp/图片.png"],
  ]);
});

test("notification registration failures can retry without duplicate listeners", async () => {
  const h = harness();
  h.evaluate(`const originalRegisterActions = registerActionTypes;
    registerActionTypes = async () => { throw new Error("注册失败"); }`);
  await assert.rejects(h.evaluate('notifySavedFile("截图", "/tmp/a.png")'), /注册失败/);
  assert.equal(h.notificationListeners.length, 0);
  assert.equal(h.notifications.length, 0);
  h.evaluate("registerActionTypes = originalRegisterActions");
  await h.evaluate('notifySavedFile("截图", "/tmp/a.png")');
  assert.equal(h.notificationListeners.length, 1);
  assert.equal(h.notifications.length, 1);
});

test("native notification send failures propagate to the caller", async () => {
  const h = harness();
  h.evaluate('invoke = async () => { throw new Error("发送失败"); }');
  await assert.rejects(h.evaluate('notifySavedFile("截图", "/tmp/a.png")'), /发送失败/);
});
