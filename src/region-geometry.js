const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 整条边均可操作；内侧加宽命中范围，顶部贴屏时延伸至菜单栏下方。
export function regionHit(region, x, y, tolerance = 8) {
  if (!region || region.width < 2 || region.height < 2) return "";
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  if (x < region.x - tolerance || x > right + tolerance ||
      y < region.y - tolerance || y > bottom + tolerance) return "";
  const horizontal = Math.abs(x - region.x) <= tolerance &&
    Math.abs(x - region.x) <= Math.abs(x - right) ? "w"
    : Math.abs(x - right) <= tolerance ? "e" : "";
  const vertical = Math.abs(y - region.y) <= tolerance &&
    Math.abs(y - region.y) <= Math.abs(y - bottom) ? "n"
    : Math.abs(y - bottom) <= tolerance ? "s" : "";
  if (horizontal || vertical) return vertical + horizontal;
  if (x < region.x + Math.min(120, region.width) &&
      y < region.y + Math.min(26, region.height)) return "move";

  const inside = 16;
  const topInset = Math.min(region.height / 3, Math.max(inside, 64 - region.y));
  const nearLeft = x - region.x <= inside && x - region.x <= right - x;
  const nearRight = right - x <= inside && !nearLeft;
  const nearTop = y - region.y <= topInset && y - region.y <= bottom - y;
  const nearBottom = bottom - y <= inside && !nearTop;
  return (nearTop ? "n" : nearBottom ? "s" : "") +
    (nearLeft ? "w" : nearRight ? "e" : "");
}

// 使用拖动起点计算几何，约束主屏边界及最小尺寸，避免累计误差。
export function adjustRegion(region, hit, dx, dy, bounds) {
  dx = Math.round(dx);
  dy = Math.round(dy);
  if (hit === "move") {
    return {
      ...region,
      x: clamp(region.x + dx, 0, bounds.width - region.width),
      y: clamp(region.y + dy, 0, bounds.height - region.height),
    };
  }
  let left = region.x;
  let top = region.y;
  let right = left + region.width;
  let bottom = top + region.height;
  if (hit.includes("w")) left = clamp(left + dx, 0, right - 2);
  if (hit.includes("e")) right = clamp(right + dx, left + 2, bounds.width);
  if (hit.includes("n")) top = clamp(top + dy, 0, bottom - 2);
  if (hit.includes("s")) bottom = clamp(bottom + dy, top + 2, bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
