// Tests the spell area and Region geometry the Foundry module uses (foundry-module/scripts/areas.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const a: any = await import(pathToFileURL(join(here, "..", "..", "..", "foundry-module", "scripts", "areas.js")).href);

// 100 px squares, 5 ft each, the map starting at 200,100 (inside the padding).
const frame = { size: 100, distance: 5, x0: 200, y0: 100 };
const keys = (sq: { x: number; y: number }[]) => sq.map((s) => `${s.x},${s.y}`).sort();

test("directions accept degrees and compass points", () => {
  assert.equal(a.compassDegrees(0), 0);
  assert.equal(a.compassDegrees(-90), 270);
  assert.equal(a.compassDegrees("n"), 270);
  assert.equal(a.compassDegrees("South-East"), 45);
  assert.equal(a.compassDegrees("west"), 180);
  assert.equal(a.compassDegrees("135"), 135);
  assert.throws(() => a.compassDegrees("up"), /Unknown direction/);
  assert.equal(a.angleTo({ x: 0, y: 0 }, { x: 0, y: 5 }), 90);
  assert.throws(() => a.angleTo({ x: 1, y: 1 }, { x: 1, y: 1 }), /own starting point/);
});

test("feet and grid points become pixels", () => {
  assert.equal(a.feetToPixels(20, frame), 400);
  assert.deepEqual(a.toPixels({ x: 2, y: 3 }, frame), { x: 400, y: 400 });
  assert.deepEqual(a.toSquares({ x: 450, y: 150 }, frame), { x: 2.5, y: 0.5 });
});

test("a ray from a token's middle leaves by a side or a corner", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(a.edgePoint(rect, 0), { x: 100, y: 50 });
  assert.deepEqual(a.edgePoint(rect, 270), { x: 50, y: 0 });
  assert.deepEqual(a.edgePoint(rect, 45), { x: 100, y: 100 });
  // A Large token, aimed west.
  assert.deepEqual(a.edgePoint({ x: 0, y: 0, w: 200, h: 200 }, 180), { x: 0, y: 100 });
});

test("PF2e spell areas map to the kinds we place", () => {
  assert.deepEqual(a.spellAreaFromPf2e({ type: "burst", value: 20 }), { kind: "burst", feet: 20, pf2eType: "burst" });
  assert.equal(a.spellAreaFromPf2e({ type: "cylinder", value: 10 }).kind, "burst");
  assert.equal(a.spellAreaFromPf2e({ type: "cube", value: 10 }).kind, "square");
  assert.throws(() => a.spellAreaFromPf2e(null), /no area/);
  assert.throws(() => a.spellAreaFromPf2e({ type: "ring", value: 10 }), /aren't supported/);
});

test("a 20-foot burst at a grid intersection is a circle and covers 16 squares", () => {
  const shape = a.spellAreaShape({ kind: "burst", feet: 20, at: { x: 5, y: 5 } }, frame);
  assert.deepEqual(shape, { type: "circle", x: 700, y: 600, radius: 400 });
  const sq = a.coveredSquares([shape], frame, 20, 20);
  // Square middles within 4 squares of the corner: a 8x8 block minus the far corners.
  assert.equal(sq.length, 52);
  assert.ok(keys(sq).includes("1,4"));
  assert.ok(!keys(sq).includes("1,1"));
  // 5-foot burst: the four squares around the intersection.
  const small = a.spellAreaShape({ kind: "burst", feet: 5, at: { x: 5, y: 5 } }, frame);
  assert.deepEqual(keys(a.coveredSquares([small], frame, 20, 20)), ["4,4", "4,5", "5,4", "5,5"]);
});

test("a burst on a token is centred on it", () => {
  const token = { x: 400, y: 300, width: 1, height: 1, shape: 0 };
  assert.deepEqual(a.spellAreaShape({ kind: "burst", feet: 10, token }, frame), { type: "circle", x: 450, y: 350, radius: 200 });
});

test("a 15-foot cone from a token aimed east covers the squares in front of it", () => {
  // Token on square 2,2 (pixels 400,300).
  const token = { x: 400, y: 300, width: 1, height: 1, shape: 0 };
  const shape = a.spellAreaShape({ kind: "cone", feet: 15, token, direction: "e" }, frame);
  assert.deepEqual(shape, { type: "cone", x: 500, y: 350, radius: 300, angle: 90, rotation: 0, curvature: "round" });
  const sq = keys(a.coveredSquares([shape], frame, 20, 20));
  assert.ok(sq.includes("3,2") && sq.includes("5,2") && sq.includes("4,1") && sq.includes("4,3"));
  assert.ok(!sq.includes("2,2"), "not the caster's own square");
  assert.ok(!sq.includes("3,0"), "outside the 90 degree spread");
  assert.ok(!sq.includes("6,2"), "past 15 feet");
});

test("a cone or line can be aimed at a grid point", () => {
  const cone = a.spellAreaShape({ kind: "cone", feet: 30, at: { x: 2, y: 2 }, toward: { x: 2, y: 8 } }, frame);
  assert.equal(cone.rotation, 90);
  assert.throws(() => a.spellAreaShape({ kind: "cone", feet: 30, at: { x: 2, y: 2 } }, frame), /direction or toward/);
});

test("a 30-foot line is one square wide and six long", () => {
  const token = { x: 400, y: 300, width: 1, height: 1, shape: 0 };
  const line = a.spellAreaShape({ kind: "line", feet: 30, token, direction: 0 }, frame);
  assert.deepEqual(line, { type: "line", x: 500, y: 350, length: 600, width: 100, rotation: 0 });
  assert.deepEqual(keys(a.coveredSquares([line], frame, 20, 20)), ["3,2", "4,2", "5,2", "6,2", "7,2", "8,2"]);
  const wide = a.spellAreaShape({ kind: "line", feet: 10, at: { x: 0, y: 1 }, direction: 0, widthFeet: 10 }, frame);
  assert.equal(wide.width, 200);
});

test("an emanation surrounds the token, or a square without one", () => {
  const token = { x: 400, y: 300, width: 2, height: 2, shape: 1 };
  const em = a.spellAreaShape({ kind: "emanation", feet: 10, token }, frame);
  assert.deepEqual(em, { type: "emanation", base: { type: "token", x: 400, y: 300, width: 2, height: 2, shape: 1 }, radius: 200 });
  // Large creature on 2..3: 10 ft out reaches 0..5, minus the far corners.
  const sq = keys(a.coveredSquares([em], frame, 20, 20));
  assert.ok(sq.includes("0,2") && sq.includes("5,3") && sq.includes("2,2"));
  assert.ok(!sq.includes("0,0"));
  assert.ok(!sq.includes("6,2"));
  const free = a.spellAreaShape({ kind: "emanation", feet: 5, at: { x: 4, y: 4 } }, frame);
  assert.equal(free.base.type, "rectangle");
  assert.equal(a.coveredSquares([free], frame, 20, 20).length, 9);
});

test("a square area sits at its corner, or centred on a token", () => {
  const s = a.spellAreaShape({ kind: "square", feet: 10, at: { x: 1, y: 1 } }, frame);
  assert.deepEqual(keys(a.coveredSquares([s], frame, 20, 20)), ["1,1", "1,2", "2,1", "2,2"]);
  assert.throws(() => a.spellAreaShape({ kind: "square", feet: 10 }, frame), /at \(a grid point\) or a token/);
  assert.throws(() => a.spellAreaShape({ kind: "blob", feet: 10, at: { x: 0, y: 0 } }, frame), /Unknown area/);
});

test("single squares merge into few rectangles", () => {
  const rects = a.cellsToRects([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 3, y: 1 },
    { x: 1, y: 0 },
  ]);
  assert.deepEqual(rects, [
    { x: 0, y: 0, w: 2, h: 2 },
    { x: 3, y: 1, w: 1, h: 1 },
  ]);
});

test("region shapes in squares become pixels, with holes", () => {
  const shapes = a.regionShapes(
    [
      { type: "rectangle", x: 1, y: 1, w: 3, h: 2 },
      { type: "squares", cells: [{ x: 2, y: 1 }], hole: true },
      { type: "circle", x: 10, y: 10, radius: 1.5 },
      { type: "polygon", points: [0, 0, 2, 0, 0, 2] },
    ],
    frame,
  );
  assert.deepEqual(shapes[0], { type: "rectangle", x: 300, y: 200, width: 300, height: 200, anchorX: 0, anchorY: 0, rotation: 0, hole: false });
  assert.equal(shapes[1].hole, true);
  assert.deepEqual(shapes[2], { type: "circle", x: 1200, y: 1100, radius: 150, hole: false });
  assert.deepEqual(shapes[3].points, [200, 100, 400, 100, 200, 300]);
  // The hole cuts square 2,1 out of the rectangle.
  const sq = keys(a.coveredSquares(shapes.slice(0, 2), frame, 20, 20));
  assert.deepEqual(sq, ["1,1", "1,2", "2,2", "3,1", "3,2"]);
  assert.throws(() => a.regionShapes([], frame), /at least one shape/);
  assert.throws(() => a.regionShapes([{ type: "rectangle", x: 0, y: 0, w: 1, h: 1, hole: true }], frame), /isn't a hole/);
  assert.throws(() => a.regionShapes([{ type: "polygon", points: [0, 0, 1, 1] }], frame), /three/);
});

test("tokens standing on covered squares are found, big ones by any square", () => {
  const tokens = [
    { name: "Goblin", x: 4, y: 4, w: 1, h: 1 },
    { name: "Ogre", x: 6, y: 3, w: 2, h: 2 },
    { name: "Far", x: 12, y: 12, w: 1, h: 1 },
  ];
  const hit = a.tokensOnSquares(tokens, [
    { x: 4, y: 4 },
    { x: 7, y: 4 },
  ]);
  assert.deepEqual(
    hit.map((t: any) => t.name),
    ["Goblin", "Ogre"],
  );
});

test("outlines close around each shape", () => {
  const circle = a.shapeOutline({ type: "circle", x: 0, y: 0, radius: 10 }, 100, 8);
  assert.equal(circle.length, 16);
  assert.deepEqual(circle.slice(0, 2), [10, 0]);
  const cone = a.shapeOutline({ type: "cone", x: 0, y: 0, radius: 10, angle: 90, rotation: 0 }, 100, 8);
  assert.deepEqual(cone.slice(0, 2), [0, 0]);
  const line = a.shapeOutline({ type: "line", x: 0, y: 0, length: 10, width: 2, rotation: 0 }, 100);
  assert.deepEqual(line, [0, 1, 10, 1, 10, -1, 0, -1]);
  const token = a.shapeOutline({ type: "token", x: 0, y: 0, width: 2, height: 1 }, 100);
  assert.deepEqual(token, [0, 0, 200, 0, 200, 100, 0, 100]);
  const em = a.shapeOutline({ type: "emanation", radius: 50, base: { type: "token", x: 0, y: 0, width: 1, height: 1 } }, 100, 8);
  assert.ok(em.length > 8);
  assert.deepEqual(a.shapeOutline({ type: "grid" }, 100), []);
});

test("difficult terrain costs 2, greater 3, and flying ignores it by default", () => {
  assert.deepEqual(a.terrainDifficulties(["walk", "fly", "swim"]), { walk: 2, fly: 1, swim: 2 });
  assert.deepEqual(a.terrainDifficulties(["walk", "fly"], "greater", true), { walk: 3, fly: 3 });
});

test("damage formulas get their type, and bad input is refused", () => {
  assert.equal(a.damageFormula("2d6", "fire"), "2d6[fire]");
  assert.equal(a.damageFormula("4d6+3", "Piercing"), "(4d6+3)[piercing]");
  assert.equal(a.damageFormula("2d6[fire]", "cold"), "2d6[fire]");
  assert.equal(a.damageFormula("", "fire"), "");
  assert.throws(() => a.damageFormula("2d6}<script>", "fire"), /isn't a damage formula/);
  assert.throws(() => a.damageFormula("2d6", "fire]|x"), /isn't a damage type/);
});

test("a trap card has PF2e save and damage buttons, with text escaped", () => {
  const card = a.trapCard({ name: "Pit <trap>", message: "The floor gives way!", save: { type: "Reflex", dc: 20, basic: true }, damage: "2d6", damageType: "bludgeoning" });
  assert.ok(card.includes("Pit &lt;trap&gt;"));
  assert.ok(card.includes("@Check[reflex|dc:20|basic]"));
  assert.ok(card.includes("@Damage[2d6[bludgeoning]]"));
  assert.ok(card.includes("__TOKEN__"));
  assert.throws(() => a.trapCard({ name: "x", save: { type: "perception", dc: 15 } }), /save must be/);
  assert.throws(() => a.trapCard({ name: "x", save: { type: "will" } }), /needs a DC/);
});

test("the trap macro is valid JavaScript with its settings", () => {
  const src = a.trapMacroSource({ name: "Dart's trap", damage: "1d8", damageType: "piercing", pause: true });
  // Foundry runs a script macro as the body of an async function.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction("token", "event", "behavior", "game", "ChatMessage", "foundry", src));
  assert.ok(src.includes('"once":true'));
  assert.ok(src.includes('"pause":true'));
  assert.ok(src.includes('"playersOnly":true'));
});

test("the trap macro posts a whisper for a player's token and switches itself off", async () => {
  const src = a.trapMacroSource({ name: "Pit", damage: "2d6", once: true });
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction("token", "event", "behavior", "game", "ChatMessage", "foundry", src);
  const posted: any[] = [];
  const updates: any[] = [];
  const game = { users: [{ id: "gm", isGM: true }, { id: "p1", isGM: false }], togglePause: () => {} };
  const ChatMessage = { create: async (d: any) => posted.push(d) };
  const behavior = { update: async (d: any) => updates.push(d) };
  const foundry = { utils: { escapeHTML: (s: string) => s.replace(/</g, "&lt;") } };
  const pc = { name: "Ezren<", actor: { hasPlayerOwner: true } };
  await run(undefined, { data: { token: pc } }, behavior, game, ChatMessage, foundry);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].whisper, ["gm"]);
  assert.ok(posted[0].content.includes("Ezren&lt;"));
  assert.deepEqual(updates, [{ disabled: true }]);
  // A monster walking in doesn't set it off.
  await run(undefined, { data: { token: { name: "Goblin", actor: { hasPlayerOwner: false } } } }, behavior, game, ChatMessage, foundry);
  assert.equal(posted.length, 1);
});

test("move_tokens waits until tokens arrive, stop, or time runs out", () => {
  // Arrived and held still briefly: done.
  assert.equal(a.moveSettled({ stillMs: 300, elapsedMs: 900, allArrived: true }), true);
  assert.equal(a.moveSettled({ stillMs: 150, elapsedMs: 900, allArrived: true }), false);
  // Not on the target yet: a short pause mid-move (or before a teleport) isn't the end.
  assert.equal(a.moveSettled({ stillMs: 600, elapsedMs: 3000, allArrived: false }), false);
  assert.equal(a.moveSettled({ stillMs: 1200, elapsedMs: 3000, allArrived: false }), true);
  // Never waits past the limit.
  assert.equal(a.moveSettled({ stillMs: 0, elapsedMs: 10_000, allArrived: false }), true);
});
