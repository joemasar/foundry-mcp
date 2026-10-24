// Sorting compendium items into treasure kinds. No Foundry globals, so it can be tested in Node.

const PERMANENT_TYPES = new Set(["weapon", "armor", "shield", "equipment", "backpack"]);
const CONSUMABLE_TYPES = new Set(["consumable", "ammo"]);
// Never hand these out as random treasure.
const SKIP_TRAITS = new Set(["cursed", "artifact", "intelligent", "snare"]);

// "permanent", "consumable", or null for things that aren't random treasure. Some consumables are
// other item types with the consumable trait, such as alchemical bombs (weapons in PF2e 8.x).
export function treasureKind(type, traits = []) {
  if (traits.some((t) => SKIP_TRAITS.has(t))) return null;
  if (CONSUMABLE_TYPES.has(type)) return "consumable";
  if (PERMANENT_TYPES.has(type)) return traits.includes("consumable") ? "consumable" : "permanent";
  return null;
}
