import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { harness } from "./harness.js";

// 沿用项目 vm harness，补充滚动尺寸、观察器和可控计时。
function scrollbarHarness() {
  const h = harness();
  h.evaluate(`
    globalThis.timers = new Map();
    globalThis.frames = new Map();
    globalThis.sequence = 0;
    setTimeout = (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    };
    clearTimeout = (id) => timers.delete(id);
    globalThis.flushTimers = () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(({ callback }) => callback());
    };
    globalThis.flushFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    };
    globalThis.makeElement = () => ({
      style: {}, children: [], attributes: new Map(), listeners: new Map(),
      classList: {
        values: new Set(),
        add(value) { this.values.add(value); },
        remove(value) { this.values.delete(value); },
        contains(value) { return this.values.has(value); },
      },
      append(...children) { this.children.push(...children); },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      hasAttribute(name) { return this.attributes.has(name); },
      focus(options) { this.focusOptions = options; },
      setPointerCapture(id) { this.captured = id; },
      hasPointerCapture(id) { return this.captured === id; },
      releasePointerCapture() { this.captured = null; },
    });
    globalThis.content = makeElement();
    Object.assign(content, {
      clientHeight: 200, scrollHeight: 1000, scrollTop: 0, clientTop: 0,
      rect: { top: 0, right: 800, width: 640 },
      getBoundingClientRect() { return this.rect; },
    });
    content.children = [makeElement(), makeElement()];
    document.body = makeElement();
    document.listeners = new Map();
    document.addEventListener = (name, callback, options) => document.listeners.set(name, { callback, options });
    document.querySelectorAll = () => [content];
    document.createElement = makeElement;
    window.listeners = new Map();
    window.addEventListener = (name, callback) => window.listeners.set(name, callback);
    window.requestAnimationFrame = (callback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    };
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; globalThis.resizeObserver = this; }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets = new Set(); }
    };
    globalThis.MutationObserver = class {
      constructor(callback) { this.callback = callback; globalThis.mutationObserver = this; }
      observe(target, options) { this.target = target; this.options = options; }
    };
    setupAutoHideScrollbars();
    globalThis.track = document.body.children[0];
    globalThis.thumb = track.children[0];
    flushFrames();
    globalThis.fire = (element, name, options = {}) => {
      const event = { button: 0, pointerId: 1, target: element, clientY: 0,
        preventDefault() { this.prevented = true; }, ...options };
      element.listeners.get(name)(event);
      return event;
    };
    globalThis.scroll = (target = content) => document.listeners.get('scroll').callback({ target });
  `);
  return h;
}

test("content overlay uses fixed-edge geometry, native scrolling and existing 700ms auto-hide", () => {
  const h = scrollbarHarness();
  assert.equal(h.evaluate("track.style.left"), "790px");
  assert.equal(h.evaluate("track.style.height"), "200px");
  assert.equal(h.evaluate("thumb.style.height"), "40px");
  assert.equal(h.evaluate("content.attributes.get('tabindex')"), "0");
  assert.equal(h.evaluate("content.classList.contains('has-overlay-scrollbar')"), true);
  assert.equal(h.evaluate("[...timers.values()][0].delay"), 700);
  h.evaluate("flushTimers(); content.scrollTop = 400; scroll(); fire(content, 'scroll'); flushFrames()");
  assert.equal(h.evaluate("thumb.style.transform"), "translateY(80px)");
  assert.equal(h.evaluate("track.classList.contains('is-scrolling')"), true);
  h.evaluate("scroll(); scroll()");
  assert.equal(h.evaluate("timers.size"), 1);
  h.evaluate("flushTimers()");
  assert.equal(h.evaluate("track.classList.contains('is-scrolling')"), false);
  assert.equal(h.evaluate("content.classList.contains('is-scrolling')"), false);
  assert.equal(h.evaluate("document.listeners.get('scroll').options"), true);
});

test("thumb dragging captures pointer, clamps limits and ends on cancellation or blur", () => {
  const h = scrollbarHarness();
  h.evaluate("fire(track, 'pointerdown', { target: thumb, clientY: 20 })");
  assert.equal(h.evaluate("track.captured"), 1);
  assert.equal(h.evaluate("content.focusOptions.preventScroll"), true);
  h.evaluate("fire(track, 'pointermove', { clientY: 100, pointerId: 2 })");
  assert.equal(h.evaluate("content.scrollTop"), 0);
  h.evaluate("fire(track, 'pointermove', { clientY: 100 }); flushTimers()");
  assert.equal(h.evaluate("content.scrollTop"), 400);
  assert.equal(h.evaluate("track.classList.contains('is-dragging')"), true);
  h.evaluate("fire(track, 'pointermove', { clientY: 9999 })");
  assert.equal(h.evaluate("content.scrollTop"), 800);
  h.evaluate("fire(track, 'pointermove', { clientY: -9999 })");
  assert.equal(h.evaluate("content.scrollTop"), 0);
  h.evaluate("fire(track, 'pointercancel')");
  assert.equal(h.evaluate("track.captured"), null);
  assert.equal(h.evaluate("track.classList.contains('is-dragging')"), false);
  for (const end of ["pointerup", "lostpointercapture", "blur"]) {
    h.evaluate("fire(track, 'pointerdown', { target: thumb })");
    h.evaluate(end === "blur" ? "window.listeners.get('blur')({})" : `fire(track, '${end}')`);
    assert.equal(h.evaluate("track.classList.contains('is-dragging')"), false);
  }
});

test("track click centers thumb and wheel over overlay forwards pixel, line and page deltas", () => {
  const h = scrollbarHarness();
  h.evaluate("fire(track, 'pointerdown', { clientY: 100 })");
  assert.equal(h.evaluate("content.scrollTop"), 400);
  assert.equal(h.evaluate("track.captured"), undefined);
  h.evaluate("fire(track, 'pointerdown', { clientY: 20, button: 2 })");
  assert.equal(h.evaluate("content.scrollTop"), 400);
  assert.equal(h.evaluate("fire(track, 'wheel', { deltaY: 10, deltaMode: 0 }).prevented"), true);
  assert.equal(h.evaluate("content.scrollTop"), 410);
  h.evaluate("fire(track, 'wheel', { deltaY: 2, deltaMode: 1 })");
  assert.equal(h.evaluate("content.scrollTop"), 442);
  h.evaluate("fire(track, 'wheel', { deltaY: 1, deltaMode: 2 })");
  assert.equal(h.evaluate("content.scrollTop"), 642);
});

test("observers and window resize update page heights and hide overlay without overflow", () => {
  const h = scrollbarHarness();
  assert.equal(h.evaluate("resizeObserver.targets.size"), 3);
  h.evaluate(`
    flushTimers();
    content.scrollHeight = 200;
    mutationObserver.callback([{ type: 'attributes' }]);
    resizeObserver.callback();
    window.listeners.get('resize')();
  `);
  assert.equal(h.evaluate("frames.size"), 1);
  h.evaluate("flushFrames()");
  assert.equal(h.evaluate("track.hidden"), true);
  h.evaluate(`
    content.children.push(makeElement());
    content.scrollHeight = 2000;
    mutationObserver.callback([{ type: 'childList' }]);
    flushFrames();
  `);
  assert.equal(h.evaluate("resizeObserver.targets.size"), 4);
  assert.equal(h.evaluate("track.hidden"), false);
  assert.equal(h.evaluate("thumb.style.height"), "24px");
  assert.equal(h.evaluate("track.classList.contains('is-scrolling')"), true);
  h.evaluate(`
    content.rect = { top: 10, right: 1000, width: 840 };
    content.clientHeight = 400;
    window.listeners.get('resize')();
    flushFrames();
  `);
  assert.equal(h.evaluate("track.style.left"), "990px");
  assert.equal(h.evaluate("track.style.top"), "10px");
  assert.equal(h.evaluate("thumb.style.height"), "80px");
  h.evaluate("content.scrollTop = -100; fire(content, 'scroll'); flushFrames()");
  assert.equal(h.evaluate("thumb.style.transform"), "translateY(0px)");
  h.evaluate("content.clientHeight = 0; content.scrollHeight = 0; resizeObserver.callback(); flushFrames()");
  assert.equal(h.evaluate("track.hidden"), true);
  assert.equal(h.evaluate("thumb.style.height"), "0px");
});

test("other scrolling areas keep their existing auto-hide without overlay and preserve tabindex", () => {
  const h = scrollbarHarness();
  h.evaluate("globalThis.other = makeElement(); scroll(other)");
  assert.equal(h.evaluate("other.classList.contains('is-scrolling')"), true);
  assert.equal(h.evaluate("other.classList.contains('has-overlay-scrollbar')"), false);
  h.evaluate("flushTimers()");
  assert.equal(h.evaluate("other.classList.contains('is-scrolling')"), false);
  h.evaluate("setupAutoHideScrollbars()");
  assert.equal(h.evaluate("document.body.children.length"), 1);
  h.evaluate("globalThis.content = Object.assign(makeElement(), content); content.attributes = new Map([['tabindex', '-1']]); setupAutoHideScrollbars()");
  assert.equal(h.evaluate("content.attributes.get('tabindex')"), "-1");
});

test("CSS hides only initialized content native bars and overlays without changing existing padding", async () => {
  const css = await readFile(new URL("../styles/layout.css", import.meta.url), "utf8");
  assert.match(css, /\.content\s*\{[^}]*overflow-y: auto;[^}]*padding: 18px 20px;/);
  assert.match(css, /\.content\.has-overlay-scrollbar\s*\{[^}]*scrollbar-gutter: auto;[^}]*scrollbar-width: none;/);
  assert.match(css, /\.content\.has-overlay-scrollbar::-webkit-scrollbar\s*\{[^}]*display: none;[^}]*width: 0;/);
  assert.match(css, /\.content-scrollbar\s*\{[^}]*position: fixed;[^}]*width: 10px;/);
  assert.match(css, /\.content-scrollbar\[hidden\]\s*\{\s*display: none;/);
  assert.match(css, /\.content-scrollbar\.is-dragging\s*\{\s*opacity: 1;/);
  assert.match(css, /forced-colors: active/);
});
