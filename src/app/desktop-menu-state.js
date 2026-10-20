let desktopMenuRefresh = () => Promise.resolve();

export function setDesktopMenuRefresh(handler) {
  desktopMenuRefresh = handler;
}

export function requestDesktopMenuRefresh() {
  return desktopMenuRefresh();
}
