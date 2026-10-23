import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayout } from "../mapLayout.js";

test("a single room gets four merged walls", () => {
  const l = buildLayout([{ x: 0, y: 0, w: 4, h: 3 }]);
  assert.equal(l.walls.length, 4);
  assert.deepEqual(
    l.walls.map((w) => w.c).sort(),
    [
      [0, 0, 0, 3],
      [0, 0, 4, 0],
      [0, 3, 4, 3],
      [4, 0, 4, 3],
    ].sort(),
  );
  assert.equal(l.width, 4);
  assert.equal(l.height, 3);
});

test("two touching rooms share one wall, and a door splits it", () => {
  const rooms = [
    { x: 0, y: 0, w: 3, h: 3 },
    { x: 3, y: 0, w: 3, h: 3 },
  ];
  const closed = buildLayout(rooms);
  const shared = closed.walls.filter((w) => w.c[0] === 3 && w.c[2] === 3);
  assert.equal(shared.length, 1, "shared wall should appear once");
  assert.deepEqual(shared[0].c, [3, 0, 3, 3]);

  const withDoor = buildLayout(rooms, [{ x: 2, y: 1, side: "e" }]);
  const middle = withDoor.walls.filter((w) => w.c[0] === 3 && w.c[2] === 3);
  assert.equal(middle.filter((w) => w.door === 1).length, 1);
  assert.deepEqual(middle.find((w) => w.door === 1)!.c, [3, 1, 3, 2]);
  assert.equal(middle.filter((w) => w.door === 0).length, 2, "wall above and below the door");
});

test("the same door given from either side lands on the same edge", () => {
  const rooms = [
    { x: 0, y: 0, w: 3, h: 3 },
    { x: 3, y: 0, w: 3, h: 3 },
  ];
  const a = buildLayout(rooms, [{ x: 2, y: 1, side: "e" }]);
  const b = buildLayout(rooms, [{ x: 3, y: 1, side: "w" }]);
  assert.deepEqual(a.walls.map((w) => w.c).sort(), b.walls.map((w) => w.c).sort());
});

test("openings remove the wall and secret doors are type 2", () => {
  const rooms = [
    { x: 0, y: 0, w: 2, h: 2 },
    { x: 0, y: 2, w: 2, h: 2 },
  ];
  const l = buildLayout(rooms, [
    { x: 0, y: 1, side: "s", type: "opening" },
    { x: 1, y: 1, side: "s", type: "secret" },
  ]);
  const onLine = l.walls.filter((w) => w.c[1] === 2 && w.c[3] === 2);
  assert.equal(onLine.length, 1);
  assert.equal(onLine[0].door, 2);
});

test("lit rooms get a centred light and bad rooms are rejected", () => {
  const l = buildLayout([{ x: 2, y: 2, w: 4, h: 2, lit: true }]);
  assert.deepEqual(l.lights, [{ x: 4, y: 3 }]);
  assert.throws(() => buildLayout([{ x: 0, y: 0, w: 0, h: 2 }]));
});
