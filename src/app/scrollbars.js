const scrollbarTimers = new WeakMap();
const scrollbarOverlays = new WeakMap();
const SCROLLBAR_HIDE_DELAY = 700;

// 共用原生和悬浮滚动条的 700ms 自动隐藏计时。
function showScrollbar(target) {
  const overlay = scrollbarOverlays.get(target);
  target.classList.add("is-scrolling");
  overlay?.classList.add("is-scrolling");
  clearTimeout(scrollbarTimers.get(target));
  scrollbarTimers.set(target, setTimeout(() => {
    target.classList.remove("is-scrolling");
    overlay?.classList.remove("is-scrolling");
    scrollbarTimers.delete(target);
  }, SCROLLBAR_HIDE_DELAY));
}

// 仅为主内容创建不占布局宽度的滚动条，保留容器的原生滚动。
function setupContentScrollbar(content) {
  const track = document.createElement("div");
  const thumb = document.createElement("div");
  track.className = "content-scrollbar";
  thumb.className = "content-scrollbar-thumb";
  track.setAttribute("aria-hidden", "true");
  track.hidden = true;
  track.append(thumb);
  document.body.append(track);
  scrollbarOverlays.set(content, track);
  if (!content.hasAttribute("tabindex")) content.setAttribute("tabindex", "0");

  let frame = 0;
  let geometry = "";
  let drag = null;
  let trackTop = 0;
  let travel = 0;
  let thumbHeight = 0;
  let maxScroll = 0;

  // 根据实际视口和内容高度定位轨道，并钳制弹性滚动偏移。
  function update() {
    const rect = content.getBoundingClientRect();
    const height = content.clientHeight;
    maxScroll = Math.max(0, content.scrollHeight - height);
    track.hidden = maxScroll === 0 || height === 0 || rect.width === 0;
    trackTop = rect.top + content.clientTop;
    thumbHeight = Math.min(height, Math.max(24, height * height / Math.max(1, content.scrollHeight)));
    travel = Math.max(0, height - thumbHeight);
    track.style.top = `${trackTop}px`;
    track.style.left = `${rect.right - 10}px`;
    track.style.height = `${height}px`;
    thumb.style.height = `${thumbHeight}px`;
    const offset = maxScroll ? Math.max(0, Math.min(1, content.scrollTop / maxScroll)) * travel : 0;
    thumb.style.transform = `translateY(${offset}px)`;
    const nextGeometry = `${rect.top},${rect.right},${height},${content.scrollHeight}`;
    if (geometry !== nextGeometry && !track.hidden) showScrollbar(content);
    geometry = nextGeometry;
  }

  // 合并内容变更和窗口尺寸变化，避免重复布局计算。
  function scheduleUpdate() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  }

  // 将轨道位置换算成原生 scrollTop，拖动与点击均不接管业务状态。
  function scrollToOffset(offset) {
    content.scrollTop = travel ? Math.max(0, Math.min(travel, offset)) / travel * maxScroll : 0;
    update();
    showScrollbar(content);
  }

  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    update();
    if (track.hidden) return;
    event.preventDefault();
    content.focus({ preventScroll: true });
    showScrollbar(content);
    if (event.target === thumb) {
      drag = { id: event.pointerId, y: event.clientY, top: content.scrollTop };
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-dragging");
    } else {
      scrollToOffset(event.clientY - trackTop - thumbHeight / 2);
    }
  });
  track.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    update();
    const start = maxScroll ? drag.top / maxScroll * travel : 0;
    scrollToOffset(start + event.clientY - drag.y);
  });

  // 释放、取消捕获或窗口失焦时结束拖动，恢复自动隐藏。
  function finishDrag(event) {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    if (track.hasPointerCapture(id)) track.releasePointerCapture(id);
    track.classList.remove("is-dragging");
    showScrollbar(content);
  }
  track.addEventListener("pointerup", finishDrag);
  track.addEventListener("pointercancel", finishDrag);
  track.addEventListener("lostpointercapture", finishDrag);
  window.addEventListener("blur", finishDrag);
  track.addEventListener("pointerenter", () => showScrollbar(content));
  track.addEventListener("pointerleave", () => showScrollbar(content));
  track.addEventListener("wheel", (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? content.clientHeight : 1;
    content.scrollTop += event.deltaY * unit;
    update();
    showScrollbar(content);
  }, { passive: false });
  content.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);

  const resizeObserver = new ResizeObserver(scheduleUpdate);
  // 同时观察各页面，容器尺寸不变时也能发现内容高度变化。
  function observeContent() {
    resizeObserver.disconnect();
    resizeObserver.observe(content);
    for (const child of content.children) resizeObserver.observe(child);
  }
  const mutationObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList")) observeContent();
    scheduleUpdate();
  });
  mutationObserver.observe(content, { subtree: true, childList: true, attributes: true, characterData: true });
  observeContent();
  update();
  content.classList.add("has-overlay-scrollbar");
  scheduleUpdate();
}

// 初始化全局自动隐藏，仅对主窗口内容区启用悬浮替代。
export function setupAutoHideScrollbars() {
  const content = document.querySelectorAll(".content")[0];
  if (content && !scrollbarOverlays.has(content)) setupContentScrollbar(content);
  document.addEventListener("scroll", (event) => {
    const target = event.target === document
      ? document.scrollingElement
      : event.target;
    if (!target?.classList) return;

    showScrollbar(target);
  }, true);
}
