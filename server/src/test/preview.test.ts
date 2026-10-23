// Tests the map preview drawing plan the Foundry module uses (foundry-module/scripts/preview.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const p: any = await import(pathToFileURL(join(here, "..", "..", "..", "foundry-module", "scripts", "preview.js")).href);

// A 20 x 10 square scene at 100 px per square, with 10% padding (so the map starts at 200,100).
const rect = { x: 200, y: 100, w: 2000, h: 1000 };

test("the scene is scaled to fit the longest side, without padding", () => {
  const f = p.previewFrame(rect, 1000);
  assert.equal(f.scale, 0.5);
  assert.equal(f.width, 1000);
  assert.equal(f.height, 500);
  assert.equal(f.x(200), 0);
  assert.equal(f.y(600), 250);
  // Small scenes are never enlarged.
  assert.equal(p.previewFrame({ x: 0, y: 0, w: 400, h: 300 }, 1024).scale, 1);
});

test("walls are coloured by kind", () => {
  assert.equal(p.wallColor({ door: 0, sight: 20, move: 20 }), p.COLORS.wall);
  assert.equal(p.wallColor({ door: 1, ds: 0 }), p.COLORS.door);
  assert.equal(p.wallColor({ door: 1, ds: 1 }), p.COLORS.openDoor);
  assert.equal(p.wallColor({ door: 2 }), p.COLORS.secret);
  assert.equal(p.wallColor({ door: 0, sight: 0, move: 20 }), p.COLORS.seeThrough);
});

const data = {
  rect,
  gridSize: 100,
  images: [{ src: "maps/crypt.webp", ...rect }],
  walls: [{ c: [200, 100, 600, 100], door: 0, sight: 20, move: 20 }, { c: [600, 100, 700, 100], door: 1, ds: 0 }],
  tokens: [{ x: 400, y: 300, w: 100, h: 100, name: "Skeleton Guard", disposition: -1, hidden: true }],
  lights: [{ x: 700, y: 600, bright: 300 }],
  notes: [{ x: 1200, y: 600, text: "Altar" }],
};

test("the plan puts art first, then grid, walls, tokens and pins in picture pixels", () => {
  const plan = p.previewOps(data, {}, 1000);
  assert.equal(plan.columns, 20);
  assert.equal(plan.rows, 10);
  const kinds = plan.ops.map((o: any) => o.op);
  assert.equal(kinds[0], "image");
  assert.deepEqual(plan.ops[0], { op: "image", src: "maps/crypt.webp", x: 0, y: 0, w: 1000, h: 500 });
  // 21 vertical + 11 horizontal grid lines, labels on every square (50 px squares).
  const gridLines = plan.ops.filter((o: any) => o.op === "line" && o.color === p.COLORS.grid);
  assert.equal(gridLines.length, 32);
  const labels = plan.ops.filter((o: any) => o.op === "text" && /^\d+$/.test(o.text));
  assert.equal(labels.length, 30);
  const door = plan.ops.find((o: any) => o.op === "line" && o.color === p.COLORS.door);
  assert.deepEqual([door.x1, door.y1, door.x2, door.y2], [200, 0, 250, 0]);
  const token = plan.ops.find((o: any) => o.op === "rect");
  assert.deepEqual([token.x, token.y, token.w, token.dashed], [100, 100, 50, true]);
  assert.equal(plan.ops.find((o: any) => o.op === "text" && o.text.startsWith("Skeleton")).text, "Skeleton…");
  assert.equal(plan.ops.find((o: any) => o.op === "circle").r, 150);
  assert.ok(plan.ops.find((o: any) => o.op === "diamond"));
  assert.ok(kinds.indexOf("rect") > kinds.lastIndexOf("line"), "tokens are drawn over walls");
});

test("layers can be turned off, and small squares get labels every 5", () => {
  const plan = p.previewOps(data, { grid: false, walls: false, tokens: false, lights: false, notes: false }, 1000);
  assert.deepEqual(plan.ops.map((o: any) => o.op), ["image"]);
  const tiny = p.previewOps({ ...data, rect: { x: 0, y: 0, w: 10000, h: 5000 } }, {}, 1000); // 10 px squares
  const labels = tiny.ops.filter((o: any) => o.op === "text" && /^\d+$/.test(o.text)).map((o: any) => o.text);
  assert.deepEqual(labels.slice(0, 3), ["0", "5", "10"]);
  const hex = p.previewOps({ ...data, square: false }, {}, 1000);
  assert.equal(hex.ops.filter((o: any) => o.color === p.COLORS.grid).length, 0);
});
