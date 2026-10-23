import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetFor, creatureXp, evaluateEncounter, pickEncounter, seededRandom, spreadPositions } from "../encounter.js";

test("budgets match GM Core for parties of 4, 3 and 6", () => {
  assert.equal(budgetFor("moderate", 4), 80);
  assert.equal(budgetFor("severe", 4), 120);
  assert.equal(budgetFor("moderate", 3), 60);
  assert.equal(budgetFor("extreme", 6), 240);
  assert.equal(budgetFor("trivial", 5), 50);
});

test("creature XP by level difference, with elite and weak", () => {
  assert.equal(creatureXp(1, 1), 40);
  assert.equal(creatureXp(-1, 1), 20);
  assert.equal(creatureXp(5, 1), 160);
  assert.equal(creatureXp(6, 1), null);
  assert.equal(creatureXp(-4, 1), 0);
  assert.equal(creatureXp(1, 1, "elite"), 60);
  assert.equal(creatureXp(1, 1, "weak"), 30);
});

test("the goblin warren against a level 1 party of 4 is extreme", () => {
  const e = evaluateEncounter(
    [
      { name: "Scrapjaw", level: -1 },
      { name: "Goblin Pyro", level: 1, count: 2 },
      { name: "Mother Soot", level: 2 },
      { name: "Zealot of Asmodeus", level: 4 },
    ],
    1,
    4,
  );
  // 20 + 80 + 60 + 120 = 280
  assert.equal(e.totalXp, 280);
  assert.equal(e.difficulty, "beyond extreme");
  assert.ok(e.warnings.some((w) => w.includes("Zealot")));
});

test("a classic moderate encounter rates moderate", () => {
  const e = evaluateEncounter([{ name: "Orc", level: 2, count: 2 }], 2, 4);
  assert.equal(e.totalXp, 80);
  assert.equal(e.difficulty, "moderate");
});

test("picked encounters stay within budget and type limits", () => {
  const candidates = [
    { uuid: "a", name: "Skeleton Guard", level: -1 },
    { uuid: "b", name: "Zombie Shambler", level: -1 },
    { uuid: "c", name: "Ghoul", level: 1 },
    { uuid: "d", name: "Wight", level: 3 },
    { uuid: "e", name: "Lich", level: 12 },
  ];
  for (let seed = 1; seed < 50; seed++) {
    const r = pickEncounter(candidates, 1, 4, "moderate", { random: seededRandom(seed) });
    assert.ok(r.spent <= r.budget, `seed ${seed} overspent`);
    assert.ok(r.picks.length <= 3);
    assert.ok(!r.picks.some((p) => p.uuid === "e"), "never picks creatures far above the party");
    assert.ok(r.spent >= r.budget - 20, `seed ${seed} left too much budget: ${r.spent}/${r.budget}`);
  }
});

test("positions fill the area, then spill to the right", () => {
  assert.deepEqual(spreadPositions({ x: 2, y: 3, w: 2, h: 1 }, 3), [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
  ]);
  assert.equal(spreadPositions({ x: 0, y: 0, w: 4, h: 4 }, 4, 2).length, 4);
});
