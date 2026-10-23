import { test } from "node:test";
import assert from "node:assert/strict";
import { seededRandom } from "../encounter.js";
import {
  coinsFromGp,
  encounterAward,
  pickTreasure,
  planTreasure,
  priceInGp,
  scaleSlots,
  treasureForParty,
  treasureRow,
  type TreasureCandidate,
} from "../rewards.js";

const count = (slots: { count: number }[]) => slots.reduce((a, s) => a + s.count, 0);

test("XP awards are always for a group of four", () => {
  assert.equal(encounterAward(80, 4), 80);
  assert.equal(encounterAward(100, 5), 80); // moderate for five
  assert.equal(encounterAward(60, 3), 80); // moderate for three
  assert.equal(encounterAward(120, 6), 80);
});

test("treasure rows match GM Core for levels 1, 3, 10 and 20", () => {
  const r1 = treasureRow(1);
  assert.equal(r1.totalGp, 175);
  assert.equal(r1.currencyGp, 40);
  assert.deepEqual(r1.permanent, [{ level: 2, count: 2 }, { level: 1, count: 2 }]);
  assert.deepEqual(r1.consumables, [{ level: 2, count: 2 }, { level: 1, count: 3 }]);

  const r3 = treasureRow(3);
  assert.equal(r3.totalGp, 500);
  assert.equal(r3.currencyPerExtraPc, 30);
  assert.deepEqual(r3.consumables, [{ level: 4, count: 2 }, { level: 3, count: 2 }, { level: 2, count: 2 }]);

  assert.equal(treasureRow(10).totalGp, 8000);
  assert.equal(treasureRow(10).currencyGp, 2000);

  const r20 = treasureRow(20);
  assert.equal(r20.totalGp, 490000);
  assert.deepEqual(r20.permanent, [{ level: 20, count: 4 }]);
  assert.deepEqual(r20.consumables, [{ level: 20, count: 4 }, { level: 19, count: 2 }]);

  assert.throws(() => treasureRow(0));
  assert.throws(() => treasureRow(21));
});

test("each extra character adds a permanent item, two consumables and currency", () => {
  const five = treasureForParty(3, 5);
  assert.equal(five.currencyGp, 150);
  assert.equal(count(five.permanent), 5);
  assert.deepEqual(five.permanent.find((s) => s.level === 3), { level: 3, count: 3 });
  assert.equal(count(five.consumables), 8);
  assert.deepEqual(five.consumables.find((s) => s.level === 4), { level: 4, count: 3 });
  assert.equal(five.approxTotalGp, 625);

  const three = treasureForParty(3, 3);
  assert.equal(three.currencyGp, 90);
  assert.equal(count(three.permanent), 3);
  assert.equal(count(three.consumables), 4);

  // Level 20 can't go above 20.
  const big = treasureForParty(20, 6);
  assert.deepEqual(big.permanent, [{ level: 20, count: 6 }]);
  assert.deepEqual(big.consumables, [{ level: 20, count: 8 }, { level: 19, count: 2 }]);
});

test("scaling slots keeps the total count, and a full share is unchanged", () => {
  const r = treasureRow(3);
  assert.deepEqual(scaleSlots(r.consumables, 1), r.consumables);
  const quarter = scaleSlots(r.consumables, 0.25, seededRandom(1));
  assert.equal(count(quarter), 2); // round(6 * 0.25)
  const half = scaleSlots(r.permanent, 0.5, seededRandom(2));
  assert.deepEqual(half, [{ level: 4, count: 1 }, { level: 3, count: 1 }]);
  assert.deepEqual(scaleSlots(r.permanent, 0.01), []);
});

test("quarter shares don't always land on the same item levels", () => {
  const seen = new Set<number>();
  for (let s = 1; s <= 20; s++) for (const slot of scaleSlots(treasureRow(5).permanent, 0.25, seededRandom(s))) seen.add(slot.level);
  assert.deepEqual([...seen].sort(), [5, 6]);
});

test("a budget becomes a share of the level, and kinds can be left out", () => {
  const p = planTreasure(3, 4, { budgetGp: 250, random: seededRandom(3) });
  assert.equal(p.share, 0.5);
  assert.equal(p.approxValueGp, 250);
  assert.equal(p.currencyGp, 60);
  assert.equal(count(p.permanent), 2);
  assert.equal(count(p.consumables), 3);

  const coinsOnly = planTreasure(3, 4, { share: 0.25, permanent: false, consumables: false });
  assert.deepEqual(coinsOnly.permanent, []);
  assert.deepEqual(coinsOnly.consumables, []);
  assert.equal(coinsOnly.currencyGp, 30);
  assert.equal(planTreasure(1, 4).share, 0.25);
  assert.throws(() => planTreasure(1, 4, { share: 0 }));
});

test("prices and coins convert to and from gp", () => {
  assert.equal(priceInGp({ gp: 4 }), 4);
  assert.equal(priceInGp({ pp: 1, gp: 2, sp: 5, cp: 3 }), 12.53);
  assert.equal(priceInGp({ gp: 1, per: 10 }), 0.1);
  assert.equal(priceInGp(undefined), 0);
  assert.deepEqual(coinsFromGp(37.5), { gp: 37, sp: 5, cp: 0 });
  assert.deepEqual(coinsFromGp(0.07), { gp: 0, sp: 0, cp: 7 });
  assert.deepEqual(coinsFromGp(-3), { gp: 0, sp: 0, cp: 0 });
});

const item = (uuid: string, kind: TreasureCandidate["kind"], level: number, official = true, priceGp = 10): TreasureCandidate => ({
  uuid,
  name: uuid,
  kind,
  level,
  priceGp,
  official,
});

test("picks prefer official items, avoid repeats and fall back a level", () => {
  const candidates = [
    item("perm4a", "permanent", 4, true, 100),
    item("perm4b", "permanent", 4, true, 90),
    item("perm4home", "permanent", 4, false, 50),
    item("cons3", "consumable", 3, true, 12),
    item("cons5home", "consumable", 5, false, 30),
  ];
  const plan = {
    permanent: [{ level: 4, count: 2 }],
    consumables: [
      { level: 5, count: 1 },
      { level: 4, count: 2 },
    ],
  };
  const r = pickTreasure(plan, candidates, seededRandom(7));
  const perm = r.picks.filter((p) => p.kind === "permanent").map((p) => p.uuid).sort();
  assert.deepEqual(perm, ["perm4a", "perm4b"]); // both official, no repeat, no homebrew
  // Level 5 consumable: only homebrew exists at 5, so it's used before looking lower.
  assert.ok(r.picks.find((p) => p.uuid === "cons5home"));
  // Level 4 consumables: none, so it drops to the level 3 one, twice.
  assert.equal(r.picks.find((p) => p.uuid === "cons3")?.quantity, 2);
  assert.equal(r.itemsValueGp, 100 + 90 + 30 + 24);
  assert.deepEqual(r.unfilled, []);
});

test("slots with nothing at or below their level are reported", () => {
  const r = pickTreasure({ permanent: [{ level: 2, count: 2 }], consumables: [] }, [item("c1", "consumable", 1)]);
  assert.deepEqual(r.picks, []);
  assert.deepEqual(r.unfilled, [{ kind: "permanent", level: 2, count: 2 }]);
});

test("the same seed gives the same treasure", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => item(`i${i}`, i % 2 ? "permanent" : "consumable", 1 + (i % 4)));
  const run = (seed: number) => {
    const random = seededRandom(seed);
    return pickTreasure(planTreasure(3, 4, { share: 0.5, random }), candidates, random).picks.map((p) => p.uuid);
  };
  assert.deepEqual(run(42), run(42));
});
