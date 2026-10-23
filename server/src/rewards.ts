// PF2e rewards maths (GM Core, "Awarding XP" and "Party Treasure by Level"). Pure functions so they can be unit tested.

// ---------- XP ----------

export type Accomplishment = "minor" | "moderate" | "major";

export const ACCOMPLISHMENT_XP: Record<Accomplishment, number> = { minor: 10, moderate: 30, major: 80 };

/**
 * XP each character gets for an encounter. Awards always use the amount for a group of four, so a
 * bigger party (which faced a bigger budget) gets the same award as four would: 100 XP for five PCs is 80 each.
 */
export function encounterAward(totalXp: number, partySize: number): number {
  return Math.round((totalXp * 4) / Math.max(1, partySize));
}

// ---------- treasure ----------

export type ItemKind = "permanent" | "consumable";

/** How many items of each item level. */
export type Slots = { level: number; count: number }[];

export interface TreasureRow {
  level: number;
  /** Total value for a party of four. */
  totalGp: number;
  permanent: Slots;
  consumables: Slots;
  currencyGp: number;
  currencyPerExtraPc: number;
}

// Total value, party currency and currency per additional PC, by party level 1-20.
const VALUES: [number, number, number][] = [
  [175, 40, 10],
  [300, 70, 18],
  [500, 120, 30],
  [850, 200, 50],
  [1350, 320, 80],
  [2000, 500, 125],
  [2900, 720, 180],
  [4000, 1000, 250],
  [5700, 1400, 350],
  [8000, 2000, 500],
  [11500, 2800, 700],
  [16500, 4000, 1000],
  [25000, 6000, 1500],
  [36500, 9000, 2250],
  [54500, 13000, 3250],
  [82500, 20000, 5000],
  [128000, 30000, 7500],
  [208000, 48000, 12000],
  [355000, 80000, 20000],
  [490000, 140000, 35000],
];

/** One row of the Party Treasure by Level table (for four characters). */
export function treasureRow(level: number): TreasureRow {
  if (!Number.isInteger(level) || level < 1 || level > 20) throw new Error(`Party level must be 1-20, not ${level}.`);
  const [totalGp, currencyGp, currencyPerExtraPc] = VALUES[level - 1];
  let permanent: Slots;
  let consumables: Slots;
  if (level === 20) {
    permanent = [{ level: 20, count: 4 }];
    consumables = [{ level: 20, count: 4 }, { level: 19, count: 2 }];
  } else if (level === 1) {
    permanent = [{ level: 2, count: 2 }, { level: 1, count: 2 }];
    consumables = [{ level: 2, count: 2 }, { level: 1, count: 3 }];
  } else {
    permanent = [{ level: level + 1, count: 2 }, { level, count: 2 }];
    consumables = [{ level: level + 1, count: 2 }, { level, count: 2 }, { level: level - 1, count: 2 }];
  }
  return { level, totalGp, permanent, consumables, currencyGp, currencyPerExtraPc };
}

function addSlot(slots: Slots, level: number, delta: number) {
  const s = slots.find((x) => x.level === level);
  if (s) s.count = Math.max(0, s.count + delta);
  else if (delta > 0) slots.push({ level, count: delta });
}

/**
 * A level's treasure for any party size. Each character past four adds one permanent item of the
 * party's level, two consumables (party level and one higher) and the extra currency; each missing
 * character takes the same away.
 */
export function treasureForParty(level: number, partySize: number): TreasureRow & { partySize: number; approxTotalGp: number } {
  const row = treasureRow(level);
  const permanent = row.permanent.map((s) => ({ ...s }));
  const consumables = row.consumables.map((s) => ({ ...s }));
  const diff = partySize - 4;
  const step = Math.sign(diff);
  for (let i = 0; i < Math.abs(diff); i++) {
    addSlot(permanent, level, step);
    addSlot(consumables, level, step);
    addSlot(consumables, Math.min(20, level + 1), step);
  }
  const currencyGp = Math.max(0, row.currencyGp + diff * row.currencyPerExtraPc);
  const clean = (s: Slots) => s.filter((x) => x.count > 0).sort((a, b) => b.level - a.level);
  return {
    ...row,
    partySize,
    permanent: clean(permanent),
    consumables: clean(consumables),
    currencyGp,
    approxTotalGp: Math.round((row.totalGp * partySize) / 4),
  };
}

/**
 * Takes a share (0.25 = a quarter) of each slot list, keeping the total count right with the largest
 * remainders. Ties are broken at random so repeated quarter-shares don't always give the same levels.
 */
export function scaleSlots(slots: Slots, share: number, random: () => number = Math.random): Slots {
  const total = slots.reduce((a, s) => a + s.count, 0);
  const target = Math.round(total * share);
  const rows = slots.map((s) => {
    const exact = s.count * share;
    return { level: s.level, count: Math.floor(exact), frac: exact - Math.floor(exact), tie: random() };
  });
  let left = target - rows.reduce((a, r) => a + r.count, 0);
  const order = [...rows].sort((a, b) => b.frac - a.frac || a.tie - b.tie);
  for (let i = 0; left > 0 && order.length; i = (i + 1) % order.length) {
    order[i].count++;
    left--;
  }
  return rows.filter((r) => r.count > 0).map(({ level, count }) => ({ level, count })).sort((a, b) => b.level - a.level);
}

export interface TreasurePlan {
  partyLevel: number;
  partySize: number;
  share: number;
  approxValueGp: number;
  permanent: Slots;
  consumables: Slots;
  currencyGp: number;
}

/**
 * The part of a level's treasure to hand out now. Give a share of the level (0.25 for one of four
 * big rewards), or a gp budget, which is turned into a share of the level's total value.
 */
export function planTreasure(
  partyLevel: number,
  partySize: number,
  opts: { share?: number; budgetGp?: number; permanent?: boolean; consumables?: boolean; currency?: boolean; random?: () => number } = {},
): TreasurePlan {
  const t = treasureForParty(partyLevel, partySize);
  let share = opts.share ?? 0.25;
  if (opts.budgetGp !== undefined) share = opts.budgetGp / t.approxTotalGp;
  if (!(share > 0)) throw new Error("The share or budget must be more than 0.");
  const random = opts.random ?? Math.random;
  return {
    partyLevel,
    partySize,
    share: Math.round(share * 1000) / 1000,
    approxValueGp: Math.round(t.approxTotalGp * share),
    permanent: opts.permanent === false ? [] : scaleSlots(t.permanent, share, random),
    consumables: opts.consumables === false ? [] : scaleSlots(t.consumables, share, random),
    currencyGp: opts.currency === false ? 0 : Math.round(t.currencyGp * share * 100) / 100,
  };
}

/** PF2e price object to gp for one item. `per` is the batch size (e.g. 10 arrows). */
export function priceInGp(price: { pp?: number; gp?: number; sp?: number; cp?: number; per?: number } | undefined | null): number {
  if (!price) return 0;
  const total = (price.pp ?? 0) * 10 + (price.gp ?? 0) + (price.sp ?? 0) / 10 + (price.cp ?? 0) / 100;
  return Math.round((total / Math.max(1, price.per ?? 1)) * 100) / 100;
}

/** gp (with fractions) as gold, silver and copper coins. */
export function coinsFromGp(gp: number): { gp: number; sp: number; cp: number } {
  const cp = Math.max(0, Math.round(gp * 100));
  return { gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 };
}

export interface TreasureCandidate {
  uuid: string;
  name: string;
  level: number;
  kind: ItemKind;
  priceGp: number;
  /** From an official (PF2e system) compendium rather than homebrew or a module. */
  official: boolean;
}

export interface TreasurePick {
  uuid: string;
  name: string;
  level: number;
  kind: ItemKind;
  priceGp: number;
  quantity: number;
  official: boolean;
}

/**
 * Fills each slot with a compendium item of that level. Official items come first; if none fit a
 * level it looks one level lower, down to level 1. Different items are preferred over repeats.
 */
export function pickTreasure(
  plan: Pick<TreasurePlan, "permanent" | "consumables">,
  candidates: TreasureCandidate[],
  random: () => number = Math.random,
): { picks: TreasurePick[]; unfilled: { kind: ItemKind; level: number; count: number }[]; itemsValueGp: number } {
  const used = new Map<string, TreasurePick>();
  const unfilled: { kind: ItemKind; level: number; count: number }[] = [];
  const choose = (kind: ItemKind, level: number): TreasureCandidate | undefined => {
    for (let l = level; l >= 1; l--) {
      for (const official of [true, false]) {
        const pool = candidates.filter((c) => c.kind === kind && c.level === l && c.official === official);
        if (!pool.length) continue;
        const fresh = pool.filter((c) => !used.has(c.uuid));
        const from = fresh.length ? fresh : pool;
        return from[Math.floor(random() * from.length)];
      }
    }
    return undefined;
  };
  for (const kind of ["permanent", "consumable"] as ItemKind[]) {
    const slots = kind === "permanent" ? plan.permanent : plan.consumables;
    for (const s of slots) {
      for (let i = 0; i < s.count; i++) {
        const c = choose(kind, s.level);
        if (!c) {
          const u = unfilled.find((x) => x.kind === kind && x.level === s.level);
          if (u) u.count++;
          else unfilled.push({ kind, level: s.level, count: 1 });
          continue;
        }
        const p = used.get(c.uuid);
        if (p) p.quantity++;
        else used.set(c.uuid, { ...c, quantity: 1 });
      }
    }
  }
  const picks = [...used.values()];
  const itemsValueGp = Math.round(picks.reduce((a, p) => a + p.priceGp * p.quantity, 0) * 100) / 100;
  return { picks, unfilled, itemsValueGp };
}
