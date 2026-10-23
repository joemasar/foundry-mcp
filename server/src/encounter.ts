// PF2e encounter maths (GM Core, "Building Encounters"). Pure functions so they can be unit tested.

export type Difficulty = "trivial" | "low" | "moderate" | "severe" | "extreme";

export const DIFFICULTIES: Difficulty[] = ["trivial", "low", "moderate", "severe", "extreme"];

// XP budget for a party of four, and the change per character above or below four.
const BUDGET: Record<Difficulty, { base: number; perCharacter: number }> = {
  trivial: { base: 40, perCharacter: 10 },
  low: { base: 60, perCharacter: 20 },
  moderate: { base: 80, perCharacter: 20 },
  severe: { base: 120, perCharacter: 30 },
  extreme: { base: 160, perCharacter: 40 },
};

// XP for one creature, by its level minus the party level.
const CREATURE_XP: Record<number, number> = { [-4]: 10, [-3]: 15, [-2]: 20, [-1]: 30, 0: 40, 1: 60, 2: 80, 3: 120, 4: 160 };

export function budgetFor(difficulty: Difficulty, partySize: number): number {
  const b = BUDGET[difficulty];
  return b.base + (partySize - 4) * b.perCharacter;
}

/** XP for one creature. Elite counts as one level higher, weak as one lower. Returns null when outside -4..+4. */
export function creatureXp(level: number, partyLevel: number, adjustment?: "elite" | "weak" | null): number | null {
  const effective = level + (adjustment === "elite" ? 1 : adjustment === "weak" ? -1 : 0);
  const diff = effective - partyLevel;
  if (diff < -4) return 0; // too weak to matter
  if (diff > 4) return null; // off the chart: far too dangerous to budget
  return CREATURE_XP[diff];
}

export interface CreatureEntry {
  name: string;
  level: number;
  count?: number;
  adjustment?: "elite" | "weak" | null;
}

export interface Evaluation {
  partyLevel: number;
  partySize: number;
  totalXp: number;
  difficulty: Difficulty | "beyond extreme";
  budgets: Record<Difficulty, number>;
  creatures: { name: string; level: number; count: number; xpEach: number | null; note?: string }[];
  warnings: string[];
}

export function evaluateEncounter(creatures: CreatureEntry[], partyLevel: number, partySize: number): Evaluation {
  const budgets = Object.fromEntries(DIFFICULTIES.map((d) => [d, budgetFor(d, partySize)])) as Record<Difficulty, number>;
  const warnings: string[] = [];
  let total = 0;
  const rows = creatures.map((c) => {
    const count = c.count ?? 1;
    const xp = creatureXp(c.level, partyLevel, c.adjustment);
    let note: string | undefined;
    if (xp === null) {
      note = "more than 4 levels above the party: likely a party wipe";
      warnings.push(`${c.name} (level ${c.level}) is more than 4 levels above a level ${partyLevel} party.`);
      total += 160 * count; // count it as at least the top of the chart
    } else {
      if (xp === 0) note = "more than 4 levels below the party: worth no XP";
      total += xp * count;
    }
    const effective = c.level + (c.adjustment === "elite" ? 1 : c.adjustment === "weak" ? -1 : 0);
    if (effective - partyLevel >= 3 && xp !== null) {
      warnings.push(`${c.name} is ${effective - partyLevel} levels above the party; a single creature this strong can swing the fight badly.`);
    }
    return { name: c.name, level: c.level, count, xpEach: xp, note };
  });

  let difficulty: Evaluation["difficulty"] = "trivial";
  for (const d of DIFFICULTIES) if (total >= budgets[d]) difficulty = d;
  if (total > budgets.extreme) difficulty = "beyond extreme";
  // Below the trivial budget still reads as trivial.
  return { partyLevel, partySize, totalXp: total, difficulty, budgets, creatures: rows, warnings };
}

export interface Candidate {
  uuid: string;
  name: string;
  level: number;
}

export interface Pick extends Candidate {
  count: number;
  xpEach: number;
}

/** Small seeded random generator so encounter picks can be repeated in tests. */
export function seededRandom(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Picks creatures from the candidates to fill the XP budget for a difficulty.
 * Prefers a few different creature types, weighted toward ones that spend the budget well.
 */
export function pickEncounter(
  candidates: Candidate[],
  partyLevel: number,
  partySize: number,
  difficulty: Difficulty,
  opts: { maxTypes?: number; maxCreatures?: number; random?: () => number } = {},
): { picks: Pick[]; budget: number; spent: number } {
  const random = opts.random ?? Math.random;
  const maxTypes = opts.maxTypes ?? 3;
  const maxCreatures = opts.maxCreatures ?? 12;
  const budget = budgetFor(difficulty, partySize);

  const pool = candidates
    .map((c) => ({ ...c, xp: creatureXp(c.level, partyLevel) }))
    .filter((c): c is Candidate & { xp: number } => c.xp !== null && c.xp > 0 && c.xp <= budget);

  const picks = new Map<string, Pick>();
  let remaining = budget;
  let total = 0;

  const weightedChoice = <T extends { xp: number }>(items: T[]): T => {
    // Bigger creatures are more likely, but small ones still show up.
    const weights = items.map((i) => Math.sqrt(i.xp));
    let r = random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  };

  while (total < maxCreatures) {
    const fits = pool.filter((c) => c.xp <= remaining);
    if (!fits.length) break;
    const newTypes = fits.filter((c) => !picks.has(c.uuid));
    const existing = fits.filter((c) => picks.has(c.uuid));
    let choice;
    if (picks.size < maxTypes && newTypes.length && (existing.length === 0 || random() < 0.6)) choice = weightedChoice(newTypes);
    else if (existing.length) choice = weightedChoice(existing);
    else break;
    const p = picks.get(choice.uuid);
    if (p) p.count++;
    else picks.set(choice.uuid, { uuid: choice.uuid, name: choice.name, level: choice.level, count: 1, xpEach: choice.xp });
    remaining -= choice.xp;
    total++;
  }

  return { picks: [...picks.values()], budget, spent: budget - remaining };
}

/** Grid squares inside an area, spaced out so tokens don't overlap. */
export function spreadPositions(area: { x: number; y: number; w: number; h: number }, count: number, spacing = 1): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = area.y; y < area.y + area.h && out.length < count; y += spacing) {
    for (let x = area.x; x < area.x + area.w && out.length < count; x += spacing) out.push({ x, y });
  }
  // If the area is too small, keep going in a row to the right of it.
  let extra = 0;
  while (out.length < count) out.push({ x: area.x + area.w + extra++ * spacing, y: area.y });
  return out;
}
