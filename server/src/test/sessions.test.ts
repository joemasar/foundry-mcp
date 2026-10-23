// Tests the session tagging logic the Foundry module uses (foundry-module/scripts/sessions.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s: any = await import(pathToFileURL(join(here, "..", "..", "..", "foundry-module", "scripts", "sessions.js")).href);

const HOUR = 3600 * 1000;
const T0 = new Date(2026, 9, 23, 19, 5).getTime();
let n = 0;
const makeId = () => `id${++n}`;

test("an unnamed session is named after the date and time", () => {
  const sess = s.newSession(undefined, T0, makeId);
  assert.equal(sess.name, "2026-10-23 19:05");
  assert.equal(sess.auto, true);
  assert.equal(s.newSession("  Session 12 ", T0, makeId).name, "Session 12");
});

test("sessions expire after 12 hours, and a missing one counts as expired", () => {
  const sess = s.newSession("x", T0, makeId);
  assert.equal(s.isExpired(sess, T0 + 11 * HOUR), false);
  assert.equal(s.isExpired(sess, T0 + 13 * HOUR), true);
  assert.equal(s.isExpired({}, T0), true);
  assert.equal(s.isExpired(null, T0), true);
});

test("a tag only counts on the document it was written for", () => {
  const sess = s.newSession("test", T0, makeId);
  const tag = s.makeTag(sess, "abc", T0);
  assert.ok(s.tagOf({ id: "abc", flags: { "foundry-mcp": tag } }, "foundry-mcp"));
  // A GM duplicate keeps the flags but gets a new ID.
  assert.equal(s.tagOf({ id: "xyz", flags: { "foundry-mcp": tag } }, "foundry-mcp"), null);
  assert.equal(s.tagOf({ id: "abc", flags: {} }, "foundry-mcp"), null);
});

test("sessions match by current, all, ID or name", () => {
  const tag = { session: "S1", sessionName: "Test" };
  assert.ok(s.matchesSession(tag, "current", "S1"));
  assert.ok(!s.matchesSession(tag, "current", "S2"));
  assert.ok(s.matchesSession(tag, "all", "S2"));
  assert.ok(s.matchesSession(tag, "s1", "S2"));
  assert.ok(s.matchesSession(tag, " test ", "S2"));
  assert.ok(!s.matchesSession(tag, "session 12", "S2"));
});

const tag = (createdAt = T0) => ({ session: "S1", sessionName: "test", createdAt });

test("cleanup skips children of deleted parents, the active scene, and character items", () => {
  const entries = [
    { uuid: "Folder.f1", type: "Folder", name: "Goblins", tag: tag(), depth: 0 },
    { uuid: "Folder.f2", type: "Folder", name: "Sub", tag: tag(), depth: 1 },
    { uuid: "JournalEntry.j1", type: "JournalEntry", name: "Notes", tag: tag() },
    { uuid: "Actor.a1", type: "Actor", name: "Test Goblin", tag: tag() },
    { uuid: "Combat.c1", type: "Combat", name: "Combat", tag: tag() },
    // New scene, with walls Claude drew on it: walls go with the scene.
    { uuid: "Scene.s1", type: "Scene", name: "Crypt", tag: tag() },
    { uuid: "Scene.s1.Wall.w1", type: "Wall", name: "Wall", parentUuid: "Scene.s1", parentName: "Crypt", tag: tag() },
    // Tokens on the GM's own scene: removed one by one.
    { uuid: "Scene.r.Token.t1", type: "Token", name: "Test Goblin", parentUuid: "Scene.r", parentName: "River Crossing", tag: tag() },
    // A scene Claude made that is now active: kept.
    { uuid: "Scene.s2", type: "Scene", name: "Live Map", active: true, tag: tag() },
    // Loot given to a PC, and an item on an NPC the GM made.
    { uuid: "Actor.pc.Item.i1", type: "Item", name: "Potion", parentUuid: "Actor.pc", parentName: "Omgot", parentIsCharacter: true, tag: tag() },
    { uuid: "Actor.npc.Item.i2", type: "Item", name: "Club", parentUuid: "Actor.npc", parentName: "Bandit", parentIsCharacter: false, tag: tag() },
  ];
  const plan = s.planCleanup(entries);
  assert.deepEqual(plan.top.map((e: any) => e.uuid), ["Combat.c1", "Scene.s1", "Actor.a1", "JournalEntry.j1"]);
  assert.deepEqual(plan.embedded.map((e: any) => e.uuid), ["Scene.r.Token.t1", "Actor.npc.Item.i2"]);
  assert.deepEqual(plan.folders.map((e: any) => e.uuid), ["Folder.f2", "Folder.f1"], "deepest folder first");
  assert.deepEqual(plan.kept.map((k: any) => k.uuid).sort(), ["Actor.pc.Item.i1", "Scene.s2"]);

  const withLoot = s.planCleanup(entries, { includeCharacterItems: true });
  assert.ok(withLoot.embedded.some((e: any) => e.uuid === "Actor.pc.Item.i1"));
});

test("plans are summarised by type, with walls and lights as counts", () => {
  const entries = [
    { uuid: "Actor.a1", type: "Actor", name: "Test Goblin", tag: tag() },
    { uuid: "Scene.r.Wall.1", type: "Wall", name: "Wall", parentUuid: "Scene.r", parentName: "River Crossing", tag: tag() },
    { uuid: "Scene.r.Wall.2", type: "Wall", name: "Wall", parentUuid: "Scene.r", parentName: "River Crossing", tag: tag() },
    { uuid: "Scene.r.Token.t1", type: "Token", name: "Test Goblin", parentUuid: "Scene.r", parentName: "River Crossing", tag: tag() },
  ];
  const d = s.describePlan(s.planCleanup(entries));
  assert.deepEqual(d.Actor, ["Test Goblin"]);
  assert.deepEqual(d["Token on another document"], ["Test Goblin (on River Crossing)"]);
  assert.deepEqual(d["Walls, lights and drawings"], ["2 Wall on River Crossing"]);
});

test("sessions are summarised newest first with counts", () => {
  const entries = [
    { type: "Actor", tag: { session: "A", sessionName: "old", createdAt: T0 } },
    { type: "Actor", tag: { session: "B", sessionName: "new", createdAt: T0 + HOUR } },
    { type: "Token", tag: { session: "B", sessionName: "new", createdAt: T0 + 2 * HOUR } },
  ];
  const out = s.summarizeSessions(entries, "B");
  assert.deepEqual(out.map((x: any) => x.name), ["new", "old"]);
  assert.deepEqual(out[0].counts, { Actor: 1, Token: 1 });
  assert.equal(out[0].current, true);
});

test("XP awards are logged per character and found by session", () => {
  const night = { id: "s1", name: "Session 12" };
  const test2 = { id: "s2", name: "test" };
  let log = s.addXpLog(undefined, night, 80, "Crypt Ambush", T0);
  log = s.addXpLog(log, test2, 30, "", T0 + HOUR);
  assert.equal(log.length, 2);
  assert.equal(log[1].reason, undefined);

  const actors = [
    { name: "Amiri", uuid: "Actor.a", log },
    { name: "Ezren", uuid: "Actor.e", log: s.addXpLog(null, night, 80, "Crypt Ambush", T0) },
    { name: "Seelah", uuid: "Actor.s", log: undefined },
  ];
  const tonight = s.xpAwardsFor(actors, "session 12", "s2");
  assert.deepEqual(tonight.map((x: any) => [x.actor, x.xp]), [["Amiri", 80], ["Ezren", 80]]);
  assert.deepEqual(s.xpAwardsFor(actors, "current", "s2").map((x: any) => x.actor), ["Amiri"]);
  assert.equal(s.xpAwardsFor(actors, "all", "s2").length, 3);
});

test("the XP log keeps only the most recent awards", () => {
  let log: any[] = [];
  for (let i = 0; i < s.XP_LOG_MAX + 5; i++) log = s.addXpLog(log, { id: "s", name: "x" }, i, "", T0 + i);
  assert.equal(log.length, s.XP_LOG_MAX);
  assert.equal(log[0].xp, 5);
});
