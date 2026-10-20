const scrollbarTimers = new WeakMap();
const SCROLLBAR_HIDE_DELAY = 700;

export function setupAutoHideScrollbars() {
  document.addEventListener("scroll", (event) => {
    const target = event.target === document
      ? document.scrollingElement
      : event.target;
    if (!target?.classList) return;

    target.classList.add("is-scrolling");
    clearTimeout(scrollbarTimers.get(target));
    scrollbarTimers.set(target, setTimeout(() => {
      target.classList.remove("is-scrolling");
      scrollbarTimers.delete(target);
    }, SCROLLBAR_HIDE_DELAY));
  }, true);
}
