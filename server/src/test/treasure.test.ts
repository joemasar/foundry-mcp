// Tests how the Foundry module sorts compendium items into treasure kinds (foundry-module/scripts/treasure.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const t: any = await import(pathToFileURL(join(here, "..", "..", "..", "foundry-module", "scripts", "treasure.js")).href);

test("bombs and other consumable-trait items count as consumables", () => {
  // Dread Ampoule in PF2e 8.x: a weapon with the consumable trait.
  assert.equal(t.treasureKind("weapon", ["alchemical", "bomb", "consumable", "mental", "splash"]), "consumable");
  assert.equal(t.treasureKind("equipment", ["consumable", "magical"]), "consumable");
});

test("item types decide the rest", () => {
  assert.equal(t.treasureKind("weapon", ["magical"]), "permanent");
  assert.equal(t.treasureKind("armor", []), "permanent");
  assert.equal(t.treasureKind("consumable", ["potion"]), "consumable");
  assert.equal(t.treasureKind("ammo"), "consumable");
  assert.equal(t.treasureKind("treasure", []), null);
  assert.equal(t.treasureKind("spell", []), null);
});

test("cursed, artifact, intelligent and snare items are never picked", () => {
  for (const trait of ["cursed", "artifact", "intelligent", "snare"]) assert.equal(t.treasureKind("equipment", [trait]), null);
  assert.equal(t.treasureKind("consumable", ["snare", "consumable"]), null);
});
