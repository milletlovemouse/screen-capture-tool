import { test } from "node:test";
import assert from "node:assert/strict";
import { regionHit, adjustRegion } from "./region-geometry.js";

const region = { x: 100, y: 100, width: 200, height: 150 };
const bounds = { width: 800, height: 600 };

test("all eight edges and corners can be selected from outside the border", () => {
  for (const [x, y, expected] of [
    [95, 95, "nw"], [200, 95, "n"], [305, 95, "ne"], [305, 175, "e"],
    [305, 255, "se"], [200, 255, "s"], [95, 255, "sw"], [95, 175, "w"],
  ]) assert.equal(regionHit(region, x, y), expected);
  assert.equal(regionHit(region, 200, 175), "");
  assert.equal(regionHit(region, 80, 175), "");
  assert.equal(regionHit(null, 100, 100), "");
  assert.equal(regionHit(region, 125, 120), "move");
});

test("resizing preserves the opposite edges and uses integer coordinates", () => {
  assert.deepEqual(adjustRegion(region, "nw", -20.4, -30.2, bounds),
    { x: 80, y: 70, width: 220, height: 180 });
  assert.deepEqual(adjustRegion(region, "se", 20, 30, bounds),
    { x: 100, y: 100, width: 220, height: 180 });
  assert.deepEqual(adjustRegion(region, "e", 25, 999, bounds),
    { x: 100, y: 100, width: 225, height: 150 });
  assert.deepEqual(adjustRegion(region, "s", 999, 25, bounds),
    { x: 100, y: 100, width: 200, height: 175 });
});

test("crossing the opposite edge keeps the minimum dimensions", () => {
  assert.deepEqual(adjustRegion(region, "nw", 1000, 1000, bounds),
    { x: 298, y: 248, width: 2, height: 2 });
  assert.deepEqual(adjustRegion(region, "se", -1000, -1000, bounds),
    { x: 100, y: 100, width: 2, height: 2 });
});

test("moving and resizing stay within screen bounds", () => {
  assert.deepEqual(adjustRegion(region, "nw", -1000, -1000, bounds),
    { x: 0, y: 0, width: 300, height: 250 });
  assert.deepEqual(adjustRegion(region, "se", 1000, 1000, bounds),
    { x: 100, y: 100, width: 700, height: 500 });
  assert.deepEqual(adjustRegion(region, "move", 1000, 1000, bounds),
    { x: 600, y: 450, width: 200, height: 150 });
  assert.deepEqual(adjustRegion(region, "move", -1000, -1000, bounds),
    { x: 0, y: 0, width: 200, height: 150 });
});

test("arbitrary points along every edge are draggable, not only handles", () => {
  for (const x of [130, 157, 211, 263, 280]) {
    assert.equal(regionHit(region, x, 103), "n");
    assert.equal(regionHit(region, x, 247), "s");
  }
  for (const y of [130, 147, 189, 213, 230]) {
    assert.equal(regionHit(region, 103, y), "w");
    assert.equal(regionHit(region, 297, y), "e");
  }
  assert.equal(regionHit(region, 250, 115), "n");
  assert.equal(regionHit(region, 285, 190), "e");
  assert.equal(regionHit(region, 200, 235), "s");
  assert.equal(regionHit(region, 115, 190), "w");
});

test("a screen-top edge can be dragged from below the menu bar without jumping", () => {
  const full = { x: 0, y: 0, width: 800, height: 600 };
  for (const x of [90, 250, 570, 740]) {
    assert.equal(regionHit(full, x, 44), "n");
    assert.equal(regionHit(full, x, 60), "n");
  }
  // 从框内 y=44 按下，再下移 20，只应把上边缘从 0 移到 20。
  assert.deepEqual(adjustRegion(full, "n", 0, 64 - 44, bounds),
    { x: 0, y: 20, width: 800, height: 580 });
  assert.equal(regionHit(full, 400, 100), "");
  assert.equal(regionHit(full, 400, 300), "");
});
