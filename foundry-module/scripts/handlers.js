// Every action the MCP server can ask for. Each handler gets the tool's parameters and returns
// plain JSON. Throwing an Error sends its message back to Claude.

import { COUNTED_TYPES, EMBEDDED, TOP_TYPES, describePlan, isExpired, makeTag, matchesSession, newSession, planCleanup, summarizeSessions, tagOf } from "./sessions.js";

const MODULE_ID = "foundry-mcp";
const PHYSICAL_TYPES = new Set(["equipment", "weapon", "armor", "shield", "consumable", "treasure", "backpack"]);

// ---------- session tagging ----------

let session = null;

// Called before every request: picks up the world's current session, or starts a new one if there
// is none or it's more than 12 hours old.
export async function ensureSession() {
  const saved = game.settings.get(MODULE_ID, "session");
  if (!isExpired(saved, Date.now())) {
    session = saved;
    return session;
  }
  session = newSession(null, Date.now(), () => foundry.utils.randomID());
  await game.settings.set(MODULE_ID, "session", session);
  return session;
}

// Give new document data its own ID and a tag naming the current session. Create it with
// { keepId: true } so the ID in the tag matches the document.
function stamp(data) {
  if (!session) throw new Error("No session yet; ensureSession() must run first.");
  data._id ??= foundry.utils.randomID();
  foundry.utils.setProperty(data, `flags.${MODULE_ID}`, makeTag(session, data._id, Date.now()));
  return data;
}

const KEEP_ID = { keepId: true };

function createTagged(cls, data) {
  return cls.create(stamp(data), KEEP_ID);
}

function embedTagged(parent, type, list) {
  return parent.createEmbeddedDocuments(type, list.map(stamp), KEEP_ID);
}

// ---------- helpers ----------

function requirePf2e() {
  if (game.system.id !== "pf2e") throw new Error(`This tool is for Pathfinder 2e, but this world uses "${game.system.id}".`);
}

async function getDoc(uuid, what = "document") {
  if (!uuid) throw new Error(`No ${what} UUID given.`);
  const doc = await fromUuid(uuid);
  if (!doc) throw new Error(`Could not find ${what} "${uuid}". Use list_documents or search_compendium to get a valid UUID.`);
  return doc;
}

async function getActor(uuid) {
  let doc = await getDoc(uuid, "actor");
  if (doc.documentName === "Token") doc = doc.actor;
  if (doc?.documentName !== "Actor") throw new Error(`"${uuid}" is not an actor.`);
  return doc;
}

async function resolveScene(uuid) {
  if (uuid) {
    const scene = await getDoc(uuid, "scene");
    if (scene.documentName !== "Scene") throw new Error(`"${uuid}" is not a scene.`);
    return scene;
  }
  const scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active;
  if (!scene) throw new Error("No scene is open. Give a sceneUuid or open a scene first.");
  return scene;
}

async function getFolderId(nameOrId, type) {
  if (!nameOrId) return undefined;
  const byId = game.folders.get(nameOrId);
  if (byId) return byId.id;
  const byName = game.folders.find((f) => f.type === type && f.name.toLowerCase() === nameOrId.toLowerCase());
  if (byName) return byName.id;
  const created = await createTagged(Folder.implementation, { name: nameOrId, type });
  return created.id;
}

function docClass(name) {
  return CONFIG[name]?.documentClass ?? getDocumentClass(name);
}

function htmlToText(html, max = 8000) {
  if (!html) return "";
  // A detached element has no layout, so innerText runs words together; walk the text nodes instead,
  // with line breaks after block elements.
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const el of div.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr, br, blockquote")) el.after("\n");
  const parts = [];
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode.nodeValue.replace(/[ \t]+/g, " ");
    if (t.trim() || t.includes("\n")) parts.push(t.includes("\n") && !t.trim() ? "\n" : t.trim());
  }
  const out = parts.join(" ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > max ? out.slice(0, max) + " ..." : out;
}

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

// Scene geometry: grid squares counted from the scene's top-left (inside the padding).
function sceneDims(scene) {
  if (canvas?.scene?.id === scene.id && canvas.dimensions) return canvas.dimensions;
  if (scene.dimensions?.size) return scene.dimensions;
  if (typeof scene.getDimensions === "function") {
    try {
      return scene.getDimensions();
    } catch {}
  }
  const size = scene.grid.size;
  return {
    size,
    sceneX: Math.ceil((scene.padding * scene.width) / size) * size,
    sceneY: Math.ceil((scene.padding * scene.height) / size) * size,
  };
}

function converter(scene, units) {
  const d = sceneDims(scene);
  const size = d.size ?? scene.grid.size;
  if (units === "pixels") return { x: (v) => v, y: (v) => v, len: (v) => v, size, d };
  return {
    x: (v) => Math.round((d.sceneX ?? 0) + v * size),
    y: (v) => Math.round((d.sceneY ?? 0) + v * size),
    len: (v) => Math.round(v * size),
    size,
    d,
  };
}

function toGrid(scene, x, y) {
  const d = sceneDims(scene);
  const size = d.size ?? scene.grid.size;
  return { x: +((x - (d.sceneX ?? 0)) / size).toFixed(2), y: +((y - (d.sceneY ?? 0)) / size).toFixed(2) };
}

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wallData(type) {
  const S = CONST.WALL_SENSE_TYPES;
  const M = CONST.WALL_MOVEMENT_TYPES;
  switch (type) {
    case "door":
      return { door: CONST.WALL_DOOR_TYPES.DOOR };
    case "secret":
      return { door: CONST.WALL_DOOR_TYPES.SECRET };
    case "window":
      return { sight: S.NONE, light: S.NONE, sound: S.LIMITED, move: M.NORMAL };
    case "invisible":
      return { sight: S.NONE, light: S.NONE, sound: S.NONE, move: M.NORMAL };
    case "ethereal":
      return { move: M.NONE };
    default:
      return {};
  }
}

// The background image lives on the scene in v13 and on the scene's first Level in v14.
async function setBackground(scene, src) {
  if (!src) return;
  const level = scene.levels?.contents?.[0] ?? scene.firstLevel ?? null;
  if (level && level.background?.src !== src) await level.update({ background: { src } });
  else if (!level && scene.background?.src !== src) await scene.update({ "background.src": src });
}

function backgroundOf(scene) {
  return scene.levels?.contents?.[0]?.background?.src ?? scene.background?.src ?? null;
}

// Find tokens on a scene by ID or name. A name matches exactly first; otherwise every token whose
// name starts with it ("Goblin Pyro" finds "Goblin Pyro 1" and "Goblin Pyro 2").
function findTokens(scene, refs) {
  if (!refs?.length) throw new Error("Name at least one token.");
  const all = scene.tokens.contents;
  const found = new Map();
  const missing = [];
  for (const ref of refs) {
    const r = String(ref).trim();
    const lower = r.toLowerCase();
    let hits = all.filter((t) => t.id === r || t.uuid === r);
    if (!hits.length) hits = all.filter((t) => t.name.toLowerCase() === lower);
    if (!hits.length) hits = all.filter((t) => t.name.toLowerCase().startsWith(lower));
    if (!hits.length) missing.push(r);
    for (const t of hits) found.set(t.id, t);
  }
  if (missing.length) {
    const names = [...new Set(all.map((t) => t.name))].slice(0, 40).join(", ");
    throw new Error(`No token matching ${missing.map((m) => `"${m}"`).join(", ")} on "${scene.name}". Tokens here: ${names || "none"}.`);
  }
  return [...found.values()];
}

function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return undefined;
  return `${hp.value}/${hp.max}${hp.temp ? ` (+${hp.temp} temp)` : ""}`;
}

function conditionsOf(actor) {
  if (!actor) return [];
  const active = actor.conditions?.active;
  if (Array.isArray(active)) return active.map((c) => (c.value ? `${c.slug} ${c.value}` : c.slug));
  return [...(actor.statuses ?? [])];
}

function levelOf(actor) {
  return actor?.level ?? actor?.system?.details?.level?.value ?? actor?.system?.level?.value;
}

async function changeHp(token, mode, amount, damageType) {
  const actor = token.actor;
  const hp = actor?.system?.attributes?.hp;
  if (!hp) throw new Error(`${token.name} has no hit points.`);
  const before = hp.value;
  let note;
  if (mode === "damage" && typeof actor.applyDamage === "function") {
    // PF2e: apply through the system so temp HP, resistances/weaknesses, dying and defeat all work.
    let done = false;
    if (damageType) {
      try {
        const DamageRoll = CONFIG.Dice.rolls.find((R) => R.name === "DamageRoll");
        if (!DamageRoll) throw new Error("no DamageRoll class");
        const roll = await new DamageRoll(`(${amount})[${damageType}]`).evaluate();
        await actor.applyDamage({ damage: roll, token });
        done = true;
        note = `${damageType} damage, resistances and weaknesses applied`;
      } catch (err) {
        console.warn("foundry-mcp | typed damage failed, applying plain damage", err);
      }
    }
    if (!done) {
      await actor.applyDamage({ damage: amount, token, skipIWR: true });
      if (damageType) note = "applied as untyped damage (resistances not checked)";
    }
  } else if (mode === "damage") {
    const temp = hp.temp ?? 0;
    const fromTemp = Math.min(temp, amount);
    await actor.update({ "system.attributes.hp.temp": temp - fromTemp, "system.attributes.hp.value": Math.max(0, hp.value - (amount - fromTemp)) });
  } else if (mode === "heal") {
    await actor.update({ "system.attributes.hp.value": Math.min(hp.max, hp.value + amount) });
  } else {
    await actor.update({ "system.attributes.hp.value": Math.max(0, Math.min(hp.max, amount)) });
  }
  const after = actor.system.attributes.hp;
  return { token: token.name, before, after: after.value, max: after.max, temp: after.temp || undefined, conditions: conditionsOf(actor), note };
}

// game.combat only covers the scene the GM is looking at. Fall back to the newest active combat anywhere.
function findCombat() {
  if (game.combat) return game.combat;
  const active = game.combats.contents.filter((c) => c.active);
  active.sort((a, b) => Number(b.started) - Number(a.started) || (b._stats?.createdTime ?? 0) - (a._stats?.createdTime ?? 0));
  return active[0] ?? null;
}

function combatSummary(c) {
  if (!c) return { active: false, note: "No combat is running." };
  return {
    active: true,
    combatId: c.id,
    scene: c.scene?.name,
    started: c.started,
    round: c.round,
    current: c.combatant?.name ?? null,
    order: c.turns.map((t, i) => ({
      tokenId: t.tokenId,
      name: t.name,
      initiative: t.initiative,
      current: i === c.turn && c.started,
      npc: t.isNPC,
      hidden: t.hidden || undefined,
      defeated: t.isDefeated || undefined,
      hp: hpOf(t.actor),
      ac: t.actor?.system?.attributes?.ac?.value,
      conditions: conditionsOf(t.actor),
    })),
  };
}

// ---------- summaries ----------

function summarizeActor(a) {
  const s = a.system ?? {};
  const items = a.items.contents;
  const damageOf = (i) => {
    if (!i) return undefined;
    if (i.system.damageRolls) return Object.values(i.system.damageRolls).map((r) => `${r.damage} ${r.damageType}`).join(" plus ");
    const d = i.system.damage;
    return d?.die ? `${d.dice ?? 1}${d.die} ${d.damageType ?? ""}`.trim() : undefined;
  };
  // PF2e works out every strike (from attack items and from weapons) in system.actions; use that when present.
  const derived = Array.isArray(s.actions) ? s.actions.filter((x) => x?.type === "strike" || x?.item) : [];
  const strikes = derived.length
    ? derived.map((x) => ({
        name: x.label ?? x.item?.name,
        bonus: x.totalModifier,
        damage: damageOf(x.item),
        traits: x.item?.system?.traits?.value,
      }))
    : items
        .filter((i) => i.type === "melee")
        .map((i) => ({ name: i.name, bonus: i.system.bonus?.value, damage: damageOf(i), traits: i.system.traits?.value }));
  const actions = items
    .filter((i) => i.type === "action")
    .map((i) => ({ name: i.name, type: i.system.actionType?.value, actions: i.system.actions?.value ?? undefined }));
  const spells = items.filter((i) => i.type === "spell").map((i) => i.name);
  const gear = items
    .filter((i) => PHYSICAL_TYPES.has(i.type))
    .map((i) => (i.system.quantity > 1 ? `${i.name} x${i.system.quantity}` : i.name));
  const other = items.filter((i) => !["melee", "action", "spell"].includes(i.type) && !PHYSICAL_TYPES.has(i.type)).map((i) => `${i.name} (${i.type})`);
  return {
    uuid: a.uuid,
    name: a.name,
    type: a.type,
    img: a.img,
    level: s.details?.level?.value ?? a.level,
    size: s.traits?.size?.value,
    rarity: s.traits?.rarity,
    traits: s.traits?.value,
    hp: s.attributes?.hp ? `${s.attributes.hp.value}/${s.attributes.hp.max}` : undefined,
    ac: s.attributes?.ac?.value,
    perception: a.perception?.mod ?? s.perception?.mod,
    saves: s.saves
      ? Object.fromEntries(Object.entries(s.saves).map(([k, v]) => [k, a.saves?.[k]?.mod ?? v?.value ?? v?.totalModifier]))
      : undefined,
    speed: s.attributes?.speed?.value,
    adjustment: s.attributes?.adjustment ?? undefined,
    strikes,
    actions,
    spells,
    gear,
    other,
    description: htmlToText(s.details?.publicNotes, 3000) || undefined,
    gmNotes: htmlToText(s.details?.privateNotes, 3000) || undefined,
    folder: a.folder?.name,
  };
}

function summarizeItem(i) {
  const s = i.system ?? {};
  return {
    uuid: i.uuid,
    name: i.name,
    type: i.type,
    img: i.img,
    level: s.level?.value,
    rarity: s.traits?.rarity,
    traits: s.traits?.value,
    price: s.price?.value,
    quantity: s.quantity,
    description: htmlToText(s.description?.value, 5000),
    owner: i.parent?.name,
  };
}

function summarizeScene(scene) {
  return {
    uuid: scene.uuid,
    name: scene.name,
    active: scene.active,
    width: scene.width,
    height: scene.height,
    gridSize: scene.grid.size,
    gridSquares: { columns: Math.round(scene.width / scene.grid.size), rows: Math.round(scene.height / scene.grid.size) },
    background: backgroundOf(scene),
    darkness: scene.environment?.darknessLevel ?? scene.darkness,
    levels: scene.levels?.size ?? undefined,
    tokens: scene.tokens.map((t) => ({
      id: t.id,
      uuid: t.uuid,
      name: t.name,
      ...toGrid(scene, t.x, t.y),
      hidden: t.hidden,
      actorUuid: t.actor?.uuid,
      hp: t.actor?.system?.attributes?.hp ? `${t.actor.system.attributes.hp.value}/${t.actor.system.attributes.hp.max}` : undefined,
    })),
    walls: scene.walls.size,
    doors: scene.walls.filter((w) => w.door > 0).length,
    lights: scene.lights.size,
    notes: scene.notes.map((n) => ({ label: n.text || n.entry?.name, journalUuid: n.page?.uuid ?? n.entry?.uuid })),
    folder: scene.folder?.name,
  };
}

function tableResultText(r) {
  return r.name || htmlToText(r.description) || r.text || r.documentUuid || "";
}

function summarize(doc) {
  switch (doc.documentName) {
    case "Actor":
      return summarizeActor(doc);
    case "Item":
      return summarizeItem(doc);
    case "Scene":
      return summarizeScene(doc);
    case "JournalEntry":
      return {
        uuid: doc.uuid,
        name: doc.name,
        folder: doc.folder?.name,
        pages: doc.pages.contents
          .sort((a, b) => a.sort - b.sort)
          .map((p) => ({ uuid: p.uuid, title: p.name, type: p.type, text: htmlToText(p.text?.content), src: p.src || undefined })),
      };
    case "JournalEntryPage":
      return { uuid: doc.uuid, title: doc.name, journal: doc.parent?.name, html: doc.text?.content };
    case "RollTable":
      return {
        uuid: doc.uuid,
        name: doc.name,
        formula: doc.formula,
        results: doc.results.map((r) => ({ range: r.range, text: tableResultText(r) })),
      };
    case "Token":
      return { uuid: doc.uuid, name: doc.name, ...toGrid(doc.parent, doc.x, doc.y), hidden: doc.hidden, actor: doc.actor ? summarizeActor(doc.actor) : null };
    default:
      return doc.toObject();
  }
}

// ---------- session log helpers ----------

function sessionInfo(s) {
  return { id: s.id, name: s.name, started: new Date(s.started).toLocaleString() };
}

function formatSession(s) {
  return {
    id: s.id,
    name: s.name,
    current: s.current,
    from: new Date(s.first).toLocaleString(),
    to: new Date(s.last).toLocaleString(),
    counts: s.counts,
  };
}

function folderDepth(folder) {
  let depth = 0;
  for (let p = folder.folder; p && depth < 20; p = p.folder) depth++;
  return depth;
}

function isCharacter(actor) {
  return actor.type === "character" || !!actor.hasPlayerOwner;
}

// Every tagged document in the world whose tag passes the filter, including tagged tokens, walls,
// items and pages inside documents Claude didn't make.
function scanTagged(filter) {
  const out = [];
  const add = (doc, extra) => {
    const tag = tagOf(doc, MODULE_ID);
    if (tag && filter(tag)) out.push({ doc, uuid: doc.uuid, type: doc.documentName, name: doc.name || doc.text || doc.documentName, tag, ...extra });
  };
  for (const type of TOP_TYPES) {
    const collection = game.collections.get(type);
    if (!collection) continue;
    for (const doc of collection) {
      add(doc, { active: type === "Scene" ? doc.active : undefined, depth: type === "Folder" ? folderDepth(doc) : undefined });
      for (const field of Object.keys(EMBEDDED[type] ?? {})) {
        for (const child of doc[field] ?? []) {
          add(child, { parentUuid: doc.uuid, parentName: doc.name, parentIsCharacter: type === "Actor" && isCharacter(doc) });
        }
      }
    }
  }
  return out;
}

function brief(e) {
  return {
    type: e.type,
    name: e.name,
    uuid: e.uuid,
    on: e.parentName,
    session: e.tag.sessionName,
    created: new Date(e.tag.createdAt).toLocaleString(),
  };
}

// ---------- handlers ----------

export const handlers = {
  async status() {
    const scene = game.scenes.viewed;
    return {
      world: { id: game.world.id, title: game.world.title },
      system: { id: game.system.id, title: game.system.title, version: game.system.version },
      foundryVersion: game.version,
      moduleVersion: game.modules.get(MODULE_ID)?.version,
      viewedScene: scene ? { uuid: scene.uuid, name: scene.name } : null,
      activeScene: game.scenes.active ? { uuid: game.scenes.active.uuid, name: game.scenes.active.name } : null,
      users: game.users.map((u) => ({ name: u.name, gm: u.isGM, online: u.active, character: u.character?.name })),
      partyMembers: game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner).map((a) => ({ uuid: a.uuid, name: a.name, level: a.level })),
      counts: {
        actors: game.actors.size,
        items: game.items.size,
        journals: game.journal.size,
        scenes: game.scenes.size,
        tables: game.tables.size,
        compendiums: game.packs.size,
      },
      combat: findCombat()
        ? (({ round, turn, combatant, combatants, scene: cs }) => ({ round, turn, current: combatant?.name, combatants: combatants.size, scene: cs?.name }))(findCombat())
        : null,
      scriptsAllowed: game.settings.get(MODULE_ID, "allowScripts"),
      session: session ? sessionInfo(session) : null,
    };
  },

  async list({ documentType, search, folder, subtype, limit = 100 }) {
    const collection = game.collections.get(documentType);
    if (!collection) throw new Error(`Unknown document type ${documentType}`);
    const q = search?.toLowerCase();
    const folderId = folder ? (game.folders.get(folder)?.id ?? game.folders.find((f) => f.type === documentType && f.name.toLowerCase() === folder.toLowerCase())?.id) : null;
    if (folder && !folderId) throw new Error(`No ${documentType} folder called "${folder}".`);
    const matches = collection.filter(
      (d) => (!q || d.name.toLowerCase().includes(q)) && (!folderId || d.folder?.id === folderId) && (!subtype || d.type === subtype),
    );
    return {
      total: matches.length,
      results: matches.slice(0, limit).map((d) => ({
        uuid: d.uuid,
        name: d.name,
        type: d.type,
        level: d.system?.details?.level?.value ?? d.system?.level?.value,
        folder: d.folder?.name,
        folderId: d.folder?.id,
        holds: documentType === "Folder" ? d.type : undefined,
        active: documentType === "Scene" ? d.active : undefined,
      })),
    };
  },

  async get({ uuid, full }) {
    const doc = await getDoc(uuid);
    return full ? doc.toObject() : summarize(doc);
  },

  async "compendium.search"({ query = "", documentType, subtype, pack, minLevel, maxLevel, traits, rarity, limit = 25 }) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const packFilter = pack?.toLowerCase();
    const packs = game.packs.filter(
      (p) =>
        (!documentType || p.documentName === documentType) &&
        (!packFilter || p.collection.toLowerCase().includes(packFilter) || p.title.toLowerCase().includes(packFilter)),
    );
    const found = [];
    for (const p of packs) {
      const withFields = p.documentName === "Actor" || p.documentName === "Item";
      const index = await p.getIndex(
        withFields ? { fields: ["system.level.value", "system.details.level.value", "system.traits.rarity", "system.traits.value"] } : {},
      );
      for (const e of index) {
        const name = e.name?.toLowerCase() ?? "";
        if (!words.every((w) => name.includes(w))) continue;
        if (subtype && e.type !== subtype) continue;
        const level = e.system?.level?.value ?? e.system?.details?.level?.value;
        if (minLevel !== undefined && !(level >= minLevel)) continue;
        if (maxLevel !== undefined && !(level <= maxLevel)) continue;
        const entryTraits = e.system?.traits?.value ?? [];
        if (traits?.length && !traits.every((t) => entryTraits.includes(t))) continue;
        if (rarity && (e.system?.traits?.rarity ?? "common") !== rarity) continue;
        found.push({
          uuid: e.uuid ?? `Compendium.${p.collection}.${p.documentName}.${e._id}`,
          name: e.name,
          type: e.type,
          level,
          rarity: e.system?.traits?.rarity,
          traits: entryTraits.slice(0, 8),
          pack: p.title,
          _score: name === query.toLowerCase() ? 0 : name.startsWith(query.toLowerCase()) ? 1 : 2,
        });
      }
      if (found.length > limit * 40) break;
    }
    found.sort((a, b) => a._score - b._score || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return {
      total: found.length,
      searchedPacks: packs.length,
      results: found.slice(0, limit).map(({ _score, ...r }) => r),
    };
  },

  async "compendium.import"({ uuid, name, folder, changes, count = 1 }) {
    const src = await getDoc(uuid);
    if (src.documentName === "Adventure") {
      await src.import();
      return { imported: src.name, note: "Adventure imported with all its actors, items, journals and scenes." };
    }
    const collection = game.collections.get(src.documentName);
    if (!collection) throw new Error(`Cannot import a ${src.documentName} on its own.`);
    let data = collection.fromCompendium(src);
    if (name) data.name = name;
    if (changes) data = foundry.utils.mergeObject(data, foundry.utils.expandObject(changes));
    if (name && src.documentName === "Actor") foundry.utils.setProperty(data, "prototypeToken.name", name);
    const folderId = await getFolderId(folder, src.documentName);
    if (folderId) data.folder = folderId;
    delete data._id;
    const docs = await docClass(src.documentName).createDocuments(
      Array.from({ length: count }, () => stamp(foundry.utils.deepClone(data))),
      KEEP_ID,
    );
    return { created: docs.map((d) => ({ uuid: d.uuid, name: d.name })), summary: summarize(docs[0]) };
  },

  async "pf2e.createNpc"(p) {
    requirePf2e();
    const parseSense = (s) => {
      const m = String(s).toLowerCase().trim().match(/^([a-z-]+)(?:[^\d]*(\d+))?/);
      return m ? (m[2] ? { type: m[1], range: Number(m[2]) } : { type: m[1] }) : { type: s };
    };
    const skills = {};
    const loreItems = [];
    for (const [slug, mod] of Object.entries(p.skills ?? {})) {
      if (slug.endsWith("-lore") || slug.endsWith(" lore")) {
        const label = slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        loreItems.push({ name: label, type: "lore", system: { mod: { value: mod } } });
      } else {
        skills[slug] = { base: mod };
      }
    }
    const system = {
      details: {
        level: { value: p.level },
        publicNotes: p.description ?? "",
        privateNotes: p.gmNotes ?? "",
        blurb: "",
        languages: { value: p.languages ?? [], details: "" },
      },
      traits: { size: { value: p.size ?? "med" }, rarity: p.rarity ?? "common", value: p.traits ?? [] },
      abilities: Object.fromEntries(Object.entries(p.abilities).map(([k, v]) => [k, { mod: v }])),
      attributes: {
        ac: { value: p.ac, details: "" },
        hp: { value: p.hp, max: p.hp, temp: 0, details: "" },
        speed: { value: p.speed ?? 25, otherSpeeds: p.otherSpeeds ?? [], details: "" },
        immunities: (p.immunities ?? []).map((type) => ({ type })),
        resistances: p.resistances ?? [],
        weaknesses: p.weaknesses ?? [],
      },
      perception: { mod: p.perception, senses: (p.senses ?? []).map(parseSense), details: "" },
      saves: {
        fortitude: { value: p.saves.fortitude, saveDetail: "" },
        reflex: { value: p.saves.reflex, saveDetail: "" },
        will: { value: p.saves.will, saveDetail: "" },
      },
      skills,
    };

    const actorData = { name: p.name, type: "npc", system, folder: await getFolderId(p.folder, "Actor") };
    if (p.img) {
      actorData.img = p.img;
      actorData.prototypeToken = { texture: { src: p.img } };
    }
    const actor = await createTagged(Actor.implementation, actorData);

    const items = [...loreItems];
    for (const s of p.strikes ?? []) {
      const traits = [...(s.traits ?? [])];
      if (s.range) traits.push(`range-increment-${s.range}`);
      items.push({
        name: s.name,
        type: "melee",
        system: {
          bonus: { value: s.bonus },
          damageRolls: Object.fromEntries(
            s.damage.map((d) => [foundry.utils.randomID(), { damage: d.formula, damageType: d.type, category: null }]),
          ),
          traits: { value: traits },
          attackEffects: { value: s.effects ?? [] },
        },
      });
    }
    for (const a of p.actions ?? []) {
      const actionType = a.actionType ?? "action";
      items.push({
        name: a.name,
        type: "action",
        system: {
          actionType: { value: actionType },
          actions: { value: actionType === "action" ? (a.actions ?? 1) : null },
          category: a.category ?? (actionType === "passive" ? "defensive" : "offensive"),
          description: { value: a.description },
          traits: { value: a.traits ?? [] },
        },
      });
    }
    const missing = [];
    for (const uuid of p.itemUuids ?? []) {
      const it = await fromUuid(uuid);
      if (!it || it.documentName !== "Item") {
        missing.push(uuid);
        continue;
      }
      const data = it.toObject();
      delete data._id;
      items.push(data);
    }
    if (items.length) await actor.createEmbeddedDocuments("Item", items);

    if (p.spellcasting) {
      const sc = p.spellcasting;
      const [entry] = await actor.createEmbeddedDocuments("Item", [
        {
          name: sc.name ?? `${sc.tradition[0].toUpperCase() + sc.tradition.slice(1)} ${sc.type[0].toUpperCase() + sc.type.slice(1)} Spells`,
          type: "spellcastingEntry",
          system: { tradition: { value: sc.tradition }, prepared: { value: sc.type }, spelldc: { value: sc.attack, dc: sc.dc } },
        },
      ]);
      const spellPacks = game.packs.filter((pk) => pk.documentName === "Item" && (pk.collection === "pf2e.spells-srd" || /spell/i.test(pk.title)));
      const spells = [];
      for (const spellName of sc.spells) {
        let hit = null;
        for (const pk of spellPacks) {
          const index = await pk.getIndex();
          const e = index.find((x) => x.name.toLowerCase() === spellName.toLowerCase());
          if (e) {
            hit = await pk.getDocument(e._id);
            break;
          }
        }
        if (!hit) {
          missing.push(`spell: ${spellName}`);
          continue;
        }
        const data = hit.toObject();
        delete data._id;
        foundry.utils.setProperty(data, "system.location.value", entry.id);
        spells.push(data);
      }
      if (spells.length) await actor.createEmbeddedDocuments("Item", spells);
    }

    return { uuid: actor.uuid, notFound: missing.length ? missing : undefined, summary: summarizeActor(actor) };
  },

  async "pf2e.adjust"({ actorUuid, adjustment }) {
    requirePf2e();
    const actor = await getActor(actorUuid);
    if (actor.type !== "npc") throw new Error("Elite and weak adjustments only apply to NPCs.");
    const value = adjustment === "normal" ? null : adjustment;
    if (typeof actor.applyAdjustment === "function") await actor.applyAdjustment(value);
    else await actor.update({ "system.attributes.adjustment": value });
    return summarizeActor(actor);
  },

  async "pf2e.createItem"(p) {
    requirePf2e();
    let system = {
      description: { value: p.description ?? "" },
      traits: { value: p.traits ?? [], rarity: p.rarity ?? "common" },
      level: { value: p.level ?? 0 },
    };
    if (PHYSICAL_TYPES.has(p.type)) {
      if (p.price) system.price = { value: p.price };
      if (p.bulk !== undefined) system.bulk = { value: p.bulk };
      if (p.quantity) system.quantity = p.quantity;
    }
    if (p.system) system = foundry.utils.mergeObject(system, foundry.utils.expandObject(p.system));
    const data = { name: p.name, type: p.type, system };
    if (p.img) data.img = p.img;

    if (p.actorUuid) {
      const actor = await getActor(p.actorUuid);
      const [item] = await embedTagged(actor, "Item", [data]);
      return { uuid: item.uuid, givenTo: actor.name, summary: summarizeItem(item) };
    }
    data.folder = await getFolderId(p.folder, "Item");
    const item = await createTagged(Item.implementation, data);
    return { uuid: item.uuid, summary: summarizeItem(item) };
  },

  async "actor.addItems"({ actorUuid, itemUuids, quantity }) {
    const actor = await getActor(actorUuid);
    const items = [];
    const missing = [];
    for (const uuid of itemUuids) {
      const it = await fromUuid(uuid);
      if (!it || it.documentName !== "Item") {
        missing.push(uuid);
        continue;
      }
      const data = it.toObject();
      delete data._id;
      if (quantity && data.system && "quantity" in data.system) data.system.quantity = quantity;
      items.push(data);
    }
    const created = items.length ? await embedTagged(actor, "Item", items) : [];
    return { actor: actor.name, added: created.map((i) => i.name), notFound: missing.length ? missing : undefined };
  },

  async "journal.create"({ name, pages, folder, showToPlayers, popOut }) {
    const data = {
      name,
      folder: await getFolderId(folder, "JournalEntry"),
      pages: pages.map((pg, i) => ({
        name: pg.title,
        type: "text",
        sort: (i + 1) * 100000,
        text: { content: pg.content, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
      })),
    };
    if (showToPlayers) data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
    const entry = await createTagged(JournalEntry.implementation, data);
    if (popOut) entry.sheet.render(true);
    return { uuid: entry.uuid, pages: entry.pages.map((pg) => ({ uuid: pg.uuid, title: pg.name })) };
  },

  async "journal.addPage"({ journalUuid, title, content, replace }) {
    const entry = await getDoc(journalUuid, "journal");
    if (entry.documentName !== "JournalEntry") throw new Error(`"${journalUuid}" is not a journal entry.`);
    const existing = replace ? entry.pages.find((pg) => pg.name.toLowerCase() === title.toLowerCase()) : null;
    if (existing) {
      await existing.update({ "text.content": content });
      return { uuid: existing.uuid, replaced: true };
    }
    const maxSort = Math.max(0, ...entry.pages.map((pg) => pg.sort));
    const [page] = await embedTagged(entry, "JournalEntryPage", [
      { name: title, type: "text", sort: maxSort + 100000, text: { content, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
    ]);
    return { uuid: page.uuid, added: true };
  },

  async "journal.show"({ uuid }) {
    const doc = await getDoc(uuid, "journal");
    const Journal = game.journal.constructor;
    if (typeof Journal.show === "function") await Journal.show(doc, { force: true });
    else if (typeof doc.show === "function") await doc.show();
    else throw new Error("This Foundry version has no way to show journals from code.");
    return { shown: doc.name };
  },

  async "table.create"({ name, description, results, formula, folder }) {
    let low = 1;
    const v13 = game.release.generation >= 13;
    const rows = results.map((r) => {
      const weight = r.weight ?? 1;
      const row = { type: CONST.TABLE_RESULT_TYPES.TEXT, weight, range: [low, low + weight - 1] };
      if (v13) Object.assign(row, { name: r.text, description: r.text });
      else row.text = r.text;
      low += weight;
      return row;
    });
    const table = await createTagged(RollTable.implementation, {
      name,
      description: description ?? "",
      formula: formula ?? `1d${low - 1}`,
      results: rows,
      folder: await getFolderId(folder, "RollTable"),
    });
    return { uuid: table.uuid, formula: table.formula, results: rows.length };
  },

  async "asset.upload"({ fileName, subfolder, mime, base64 }) {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const source = typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge ? "forgevtt" : "data";
    const clean = String(subfolder || "uploads").replace(/[^\w\-/ ]+/g, "_").replace(/^\/+|\/+$/g, "");
    const dir = `${MODULE_ID}/${clean}`;
    let partial = "";
    for (const part of dir.split("/")) {
      partial = partial ? `${partial}/${part}` : part;
      try {
        await FP.createDirectory(source, partial, {});
      } catch {
        // already exists
      }
    }
    const blob = await (await fetch(`data:${mime};base64,${base64}`)).blob();
    const file = new File([blob], fileName, { type: mime });
    const res = await FP.upload(source, dir, file, {}, { notify: false });
    if (res === false || res?.status === "error") throw new Error(res?.message ?? "Upload failed. Check that the GM may upload files.");
    return { path: res?.path ?? `${dir}/${fileName}` };
  },

  async "scene.create"(p) {
    let width = p.width;
    let height = p.height;
    const gridSize = p.gridSize ?? 100;
    if (p.background && (!width || !height)) {
      const size = await imageSize(p.background);
      if (size) {
        width ??= size.w;
        height ??= size.h;
      }
    }
    width ??= gridSize * 30;
    height ??= gridSize * 20;
    const data = {
      name: p.name,
      width,
      height,
      padding: 0.1,
      grid: { size: gridSize, distance: p.gridDistance ?? 5, units: "ft", type: CONST.GRID_TYPES.SQUARE },
      tokenVision: p.tokenVision ?? true,
      environment: { darknessLevel: p.darkness ?? 0 },
      folder: await getFolderId(p.folder, "Scene"),
    };
    if (p.background) data.background = { src: p.background };
    if (p.backgroundColor) data.backgroundColor = p.backgroundColor;
    const scene = await createTagged(Scene.implementation, data);
    await setBackground(scene, p.background);
    if (p.activate) await scene.activate();
    else if (p.view ?? true) await scene.view();
    return summarizeScene(scene);
  },

  async "scene.buildLayout"(p) {
    const layout = p.layout;
    const gridSize = p.gridSize ?? 100;
    let scene;
    if (p.sceneUuid) {
      scene = await resolveScene(p.sceneUuid);
      if (p.replaceExisting) {
        for (const kind of ["Wall", "Drawing", "AmbientLight"]) {
          const ids = scene.getEmbeddedCollection(kind).map((d) => d.id);
          if (ids.length) await scene.deleteEmbeddedDocuments(kind, ids);
        }
      }
    } else {
      scene = await createTagged(Scene.implementation, {
        name: p.name,
        width: (layout.width + 1) * gridSize,
        height: (layout.height + 1) * gridSize,
        padding: 0.1,
        backgroundColor: "#141414",
        grid: { size: gridSize, distance: 5, units: "ft", type: CONST.GRID_TYPES.SQUARE },
        tokenVision: true,
        environment: { darknessLevel: p.darkness ?? 0.6 },
        folder: await getFolderId(p.folder, "Scene"),
      });
    }

    const c = converter(scene, "grid");
    const drawings = layout.drawings.map((r) => ({
      author: game.user.id,
      x: c.x(r.x),
      y: c.y(r.y),
      shape: { type: "r", width: c.len(r.w), height: c.len(r.h) },
      fillType: CONST.DRAWING_FILL_TYPES.SOLID,
      fillColor: r.color,
      fillAlpha: 1,
      strokeWidth: 2,
      strokeColor: "#000000",
      strokeAlpha: 0.6,
      text: r.label ?? "",
      fontSize: Math.round(c.size * 0.3),
      textColor: "#f0e6d2",
      textAlpha: 0.85,
    }));
    const walls = layout.walls.map((w) => ({
      c: [c.x(w.c[0]), c.y(w.c[1]), c.x(w.c[2]), c.y(w.c[3])],
      door: w.door,
    }));
    const lights = layout.lights.map((l) => ({
      x: c.x(l.x),
      y: c.y(l.y),
      config: { bright: 15, dim: 30, color: "#ffcc88", alpha: 0.4, animation: { type: "torch", speed: 3, intensity: 3 } },
    }));

    if (drawings.length) await embedTagged(scene, "Drawing", drawings);
    if (walls.length) await embedTagged(scene, "Wall", walls);
    if (lights.length) await embedTagged(scene, "AmbientLight", lights);
    if (p.activate) await scene.activate();
    else await scene.view();

    return {
      sceneUuid: scene.uuid,
      name: scene.name,
      rooms: drawings.length,
      walls: walls.filter((w) => !w.door).length,
      doors: walls.filter((w) => w.door).length,
      lights: lights.length,
      sizeInSquares: { columns: layout.width + 1, rows: layout.height + 1 },
    };
  },

  async "scene.addWalls"({ sceneUuid, units, walls }) {
    const scene = await resolveScene(sceneUuid);
    const c = converter(scene, units);
    const data = [];
    for (const w of walls) {
      const pts = w.points;
      if (pts.length % 2) throw new Error("Wall points must come in x,y pairs.");
      for (let i = 0; i + 3 < pts.length; i += 2) {
        data.push({ c: [c.x(pts[i]), c.y(pts[i + 1]), c.x(pts[i + 2]), c.y(pts[i + 3])], ...wallData(w.type) });
      }
    }
    const created = await embedTagged(scene, "Wall", data);
    return { scene: scene.name, wallsCreated: created.length };
  },

  async "scene.addLights"({ sceneUuid, units, lights }) {
    const scene = await resolveScene(sceneUuid);
    const c = converter(scene, units);
    const created = await embedTagged(
      scene,
      "AmbientLight",
      lights.map((l) => ({
        x: c.x(l.x),
        y: c.y(l.y),
        config: {
          bright: l.bright ?? 20,
          dim: l.dim ?? 40,
          color: l.color ?? null,
          alpha: 0.5,
          animation: { type: l.animation && l.animation !== "none" ? l.animation : null, speed: 4, intensity: 4 },
        },
      })),
    );
    return { scene: scene.name, lightsCreated: created.length };
  },

  async "scene.placeTokens"({ sceneUuid, actorUuid, positions = [], area, count, hidden, name }) {
    const scene = await resolveScene(sceneUuid);
    const actor = await getActor(actorUuid);
    if (actor.pack) throw new Error("That actor is in a compendium. Import it with import_from_compendium first, then place the world copy.");
    if (!positions.length && !area) throw new Error("Give positions or an area.");
    const c = converter(scene, "grid");
    const total = count ?? (positions.length || 1);

    // The system sets the real footprint (a Large creature is 2x2), so ask for a token first.
    const sample = await actor.getTokenDocument({ x: 0, y: 0 });
    const w = Math.max(1, Math.ceil(sample.width));
    const h = Math.max(1, Math.ceil(sample.height));

    // Squares already taken by tokens on the scene, so new ones don't stack.
    const taken = new Set();
    const mark = (gx, gy, tw, th) => {
      for (let dx = 0; dx < tw; dx++) for (let dy = 0; dy < th; dy++) taken.add(`${gx + dx},${gy + dy}`);
    };
    for (const t of scene.tokens) {
      const g = toGrid(scene, t.x, t.y);
      mark(Math.round(g.x), Math.round(g.y), Math.max(1, Math.ceil(t.width)), Math.max(1, Math.ceil(t.height)));
    }
    const fits = (gx, gy) => {
      for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) if (taken.has(`${gx + dx},${gy + dy}`)) return false;
      return true;
    };
    const freeSpot = () => {
      if (area) {
        for (let gy = area.y; gy <= area.y + area.h - h; gy++) for (let gx = area.x; gx <= area.x + area.w - w; gx++) if (fits(gx, gy)) return { x: gx, y: gy };
        // Area full: try the squares just to the right of it.
        for (let gx = area.x + area.w; gx < area.x + area.w + 20; gx++) for (let gy = area.y; gy < area.y + area.h; gy++) if (fits(gx, gy)) return { x: gx, y: gy };
      }
      return null;
    };

    const tokens = [];
    for (let i = 0; i < total; i++) {
      let pos = positions[i];
      if (!pos) pos = freeSpot();
      if (!pos) {
        const last = positions[positions.length - 1] ?? { x: area.x, y: area.y };
        pos = { x: last.x + w * (i - positions.length + 1), y: last.y };
      }
      mark(pos.x, pos.y, w, h);
      const td = await actor.getTokenDocument({ x: c.x(pos.x), y: c.y(pos.y), hidden: !!hidden });
      const obj = td.toObject();
      const base = name ?? obj.name;
      obj.name = total > 1 ? `${base} ${i + 1}` : base;
      tokens.push(obj);
    }
    const created = await embedTagged(scene, "Token", tokens);
    return { scene: scene.name, tokens: created.map((t) => ({ id: t.id, uuid: t.uuid, name: t.name, ...toGrid(scene, t.x, t.y), hidden: t.hidden })) };
  },

  async "scene.addNotes"({ sceneUuid, notes }) {
    const scene = await resolveScene(sceneUuid);
    const c = converter(scene, "grid");
    const data = [];
    for (const n of notes) {
      const doc = await getDoc(n.journalUuid, "journal");
      const entry = doc.documentName === "JournalEntryPage" ? doc.parent : doc;
      data.push({
        x: c.x(n.x),
        y: c.y(n.y),
        entryId: entry.id,
        pageId: doc.documentName === "JournalEntryPage" ? doc.id : null,
        text: n.label ?? doc.name,
        iconSize: 40,
        texture: { src: "icons/svg/book.svg" },
      });
    }
    const created = await embedTagged(scene, "Note", data);
    return { scene: scene.name, notesCreated: created.length };
  },

  async "scene.control"({ sceneUuid, action, darkness }) {
    const scene = await resolveScene(sceneUuid);
    if (action === "activate") await scene.activate();
    else if (action === "view") await scene.view();
    else if (action === "setDarkness") {
      if (darkness === undefined) throw new Error("Give a darkness value from 0 to 1.");
      await scene.update({ "environment.darknessLevel": darkness });
    }
    return { scene: scene.name, active: scene.active, darkness: scene.environment?.darknessLevel };
  },

  async "combat.start"({ sceneUuid, tokenIds, rollNpcInitiative, start }) {
    const scene = await resolveScene(sceneUuid);
    let tokens = scene.tokens.contents.filter((t) => t.actor);
    if (tokenIds?.length) tokens = tokens.filter((t) => tokenIds.includes(t.id));
    if (!tokens.length) throw new Error("No tokens to add to the encounter.");
    const combat = await createTagged(Combat.implementation, { scene: scene.id, active: true });
    await combat.createEmbeddedDocuments(
      "Combatant",
      tokens.map((t) => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden })),
    );
    if (rollNpcInitiative) await combat.rollNPC({ skipDialog: true });
    if (start) await combat.startCombat();
    return {
      combatId: combat.id,
      round: combat.round,
      order: combat.turns.map((t) => ({ name: t.name, initiative: t.initiative, npc: t.isNPC })),
    };
  },

  async roll({ formula, tableUuid, flavor, whisperGM }) {
    const whisper = whisperGM ? gmIds() : [];
    if (tableUuid) {
      const table = await getDoc(tableUuid, "roll table");
      if (table.documentName !== "RollTable") throw new Error(`"${tableUuid}" is not a roll table.`);
      const draw = await table.draw({ displayChat: false });
      const texts = draw.results.map(tableResultText);
      await ChatMessage.implementation.create({
        content: `<h3>${table.name}</h3><p>Rolled ${draw.roll.total}: ${texts.join(", ")}</p>`,
        whisper,
        flavor,
      });
      return { table: table.name, roll: draw.roll.total, results: texts };
    }
    if (!formula) throw new Error("Give a formula or a tableUuid.");
    const roll = await new Roll(formula).evaluate();
    await roll.toMessage({ flavor, whisper });
    return { formula: roll.formula, total: roll.total, breakdown: roll.result };
  },

  async "chat.send"({ content, speakerActorUuid, whisperGM }) {
    const data = { content };
    if (speakerActorUuid) {
      const actor = await getActor(speakerActorUuid);
      data.speaker = ChatMessage.implementation.getSpeaker({ actor });
    }
    if (whisperGM) data.whisper = gmIds();
    const msg = await ChatMessage.implementation.create(data);
    return { messageId: msg.id };
  },

  async update({ uuid, changes }) {
    const doc = await getDoc(uuid);
    if (doc.pack) throw new Error("That document is in a compendium. Import it first, then update the world copy.");
    await doc.update(changes);
    return summarize(doc);
  },

  async delete({ uuid, confirm }) {
    if (confirm !== true) throw new Error("Set confirm to true to delete.");
    const doc = await getDoc(uuid);
    if (doc.pack) throw new Error("Compendium documents can't be deleted from here.");
    const name = doc.name;
    await doc.delete();
    return { deleted: name, type: doc.documentName };
  },

  async "folder.create"({ name, documentType, parent, color }) {
    const folder = await createTagged(Folder.implementation, {
      name,
      type: documentType,
      folder: parent ? await getFolderId(parent, documentType) : null,
      color: color ?? null,
    });
    return { id: folder.id, uuid: folder.uuid, name: folder.name };
  },

  // ---------- tokens ----------

  async "tokens.move"({ sceneUuid, moves }) {
    const scene = await resolveScene(sceneUuid);
    const c = converter(scene, "grid");
    const updates = [];
    for (const m of moves) {
      const [t, ...extra] = findTokens(scene, [m.token]);
      if (extra.length) throw new Error(`"${m.token}" matches ${extra.length + 1} tokens; use the exact name or the token ID.`);
      updates.push({ _id: t.id, x: c.x(m.x), y: c.y(m.y) });
    }
    const done = await scene.updateEmbeddedDocuments("Token", updates);
    return { scene: scene.name, moved: done.map((t) => ({ name: t.name, ...toGrid(scene, t.x, t.y) })) };
  },

  async "tokens.state"({ sceneUuid, tokens, action, name }) {
    const scene = await resolveScene(sceneUuid);
    const list = findTokens(scene, tokens);
    const ids = list.map((t) => t.id);
    if (action === "remove") {
      await scene.deleteEmbeddedDocuments("Token", ids);
      return { scene: scene.name, removed: list.map((t) => t.name) };
    }
    let updates;
    if (action === "reveal" || action === "hide") updates = ids.map((_id) => ({ _id, hidden: action === "hide" }));
    else if (action === "rename") {
      if (!name) throw new Error("Give the new name.");
      updates = ids.map((_id, i) => ({ _id, name: ids.length > 1 ? `${name} ${i + 1}` : name }));
    } else throw new Error(`Unknown action ${action}`);
    await scene.updateEmbeddedDocuments("Token", updates);
    // Hidden combatants should follow their tokens.
    if (action === "reveal" || action === "hide") {
      for (const combat of game.combats.filter((cb) => cb.scene?.id === scene.id)) {
        const cUpdates = combat.combatants.filter((cb) => ids.includes(cb.tokenId)).map((cb) => ({ _id: cb.id, hidden: action === "hide" }));
        if (cUpdates.length) await combat.updateEmbeddedDocuments("Combatant", cUpdates);
      }
    }
    return { scene: scene.name, [action === "rename" ? "renamed" : action === "hide" ? "hidden" : "revealed"]: list.map((t) => scene.tokens.get(t.id)?.name ?? t.name) };
  },

  async "tokens.hp"({ sceneUuid, tokens, mode, amount, damageType }) {
    const scene = await resolveScene(sceneUuid);
    const results = [];
    for (const t of findTokens(scene, tokens)) {
      try {
        results.push(await changeHp(t, mode, amount, damageType));
      } catch (err) {
        results.push({ token: t.name, error: err.message });
      }
    }
    return { scene: scene.name, results };
  },

  async "tokens.conditions"({ sceneUuid, tokens, add = [], remove = [] }) {
    const scene = await resolveScene(sceneUuid);
    const pf2e = game.system.id === "pf2e";
    const results = [];
    for (const t of findTokens(scene, tokens)) {
      const actor = t.actor;
      const errors = [];
      for (const c of add) {
        try {
          if (pf2e && actor.increaseCondition) {
            const manager = game.pf2e?.ConditionManager;
            if (typeof manager?.getCondition === "function" && !manager.getCondition(c.slug)) throw new Error(`"${c.slug}" is not a PF2e condition`);
            await actor.increaseCondition(c.slug, c.value ? { value: c.value } : {});
          } else await actor.toggleStatusEffect(c.slug, { active: true });
        } catch (err) {
          errors.push(`${c.slug}: ${err.message}`);
        }
      }
      for (const slug of remove) {
        try {
          if (pf2e && actor.decreaseCondition) await actor.decreaseCondition(slug, { forceRemove: true });
          else await actor.toggleStatusEffect(slug, { active: false });
        } catch (err) {
          errors.push(`${slug}: ${err.message}`);
        }
      }
      results.push({ token: t.name, conditions: conditionsOf(actor), errors: errors.length ? errors : undefined });
    }
    return { scene: scene.name, results };
  },

  // ---------- combat ----------

  async "combat.status"() {
    return combatSummary(findCombat());
  },

  async "combat.control"({ action, sceneUuid, tokens }) {
    const combat = findCombat();
    if (!combat) throw new Error("No combat is running. Use start_encounter first.");
    switch (action) {
      case "start":
        await combat.startCombat();
        break;
      case "next_turn":
        if (!combat.started) await combat.startCombat();
        else await combat.nextTurn();
        break;
      case "previous_turn":
        await combat.previousTurn();
        break;
      case "next_round":
        await combat.nextRound();
        break;
      case "end": {
        const summary = { ended: true, rounds: combat.round, scene: combat.scene?.name };
        await combat.delete();
        return summary;
      }
      case "add": {
        const scene = combat.scene ?? (await resolveScene(sceneUuid));
        const have = new Set(combat.combatants.map((cb) => cb.tokenId));
        const list = findTokens(scene, tokens).filter((t) => !have.has(t.id));
        if (list.length) {
          const created = await combat.createEmbeddedDocuments(
            "Combatant",
            list.map((t) => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden })),
          );
          const needRoll = created.filter((cb) => cb.isNPC).map((cb) => cb.id);
          if (needRoll.length) await combat.rollInitiative(needRoll, { skipDialog: true });
        }
        break;
      }
      case "remove":
      case "defeated": {
        const scene = combat.scene ?? (await resolveScene(sceneUuid));
        const ids = new Set(findTokens(scene, tokens).map((t) => t.id));
        const cbs = combat.combatants.filter((cb) => ids.has(cb.tokenId));
        if (!cbs.length) throw new Error("None of those tokens are in the combat.");
        if (action === "remove") await combat.deleteEmbeddedDocuments("Combatant", cbs.map((cb) => cb.id));
        else await combat.updateEmbeddedDocuments("Combatant", cbs.map((cb) => ({ _id: cb.id, defeated: true })));
        break;
      }
      case "roll_initiative": {
        let ids;
        if (tokens?.length) {
          const scene = combat.scene ?? (await resolveScene(sceneUuid));
          const tIds = new Set(findTokens(scene, tokens).map((t) => t.id));
          ids = combat.combatants.filter((cb) => tIds.has(cb.tokenId)).map((cb) => cb.id);
        } else ids = combat.combatants.filter((cb) => cb.initiative === null).map((cb) => cb.id);
        if (ids.length) await combat.rollInitiative(ids, { skipDialog: true });
        break;
      }
      default:
        throw new Error(`Unknown combat action ${action}`);
    }
    return combatSummary(game.combats.get(combat.id) ?? findCombat());
  },

  // ---------- chat ----------

  async "chat.read"({ limit = 20, rollsOnly, includeWhispers = true }) {
    let msgs = game.messages.contents;
    if (!includeWhispers) msgs = msgs.filter((m) => !m.whisper?.length);
    if (rollsOnly) msgs = msgs.filter((m) => m.rolls?.length);
    return {
      total: game.messages.size,
      messages: msgs.slice(-limit).map((m) => {
        const ctx = m.flags?.pf2e?.context;
        return {
          time: new Date(m.timestamp).toLocaleTimeString(),
          speaker: m.speaker?.alias ?? m.author?.name,
          player: m.author?.name,
          whisper: m.whisper?.length ? true : undefined,
          flavor: htmlToText(m.flavor, 300) || undefined,
          text: htmlToText(m.content, 600) || undefined,
          rolls: m.rolls?.length ? m.rolls.map((r) => ({ formula: r.formula, total: r.total })) : undefined,
          check: ctx
            ? {
                type: ctx.type,
                outcome: ctx.outcome ?? undefined,
                dc: ctx.dc?.value ?? undefined,
                target: ctx.target?.token ? fromUuidSync(ctx.target.token)?.name : undefined,
              }
            : undefined,
        };
      }),
    };
  },

  // ---------- encounter helpers ----------

  async "pf2e.party"() {
    const party = game.actors.party;
    const members = party?.members ?? [];
    return {
      party: party?.name ?? null,
      members: members.map((a) => ({ uuid: a.uuid, name: a.name, level: levelOf(a), hp: hpOf(a) })),
    };
  },

  async "encounter.sceneCreatures"({ sceneUuid }) {
    const scene = await resolveScene(sceneUuid);
    const friendly = CONST.TOKEN_DISPOSITIONS.FRIENDLY;
    const creatures = scene.tokens.contents
      .filter((t) => t.actor && !t.actor.hasPlayerOwner && t.disposition !== friendly)
      .map((t) => ({
        name: t.name,
        level: levelOf(t.actor),
        adjustment: t.actor.system?.attributes?.adjustment ?? null,
        hidden: t.hidden || undefined,
      }))
      .filter((c) => typeof c.level === "number");
    return { scene: scene.name, creatures };
  },

  // ---------- session log ----------

  async "session.start"({ name }) {
    const previous = session;
    session = newSession(name, Date.now(), () => foundry.utils.randomID());
    await game.settings.set(MODULE_ID, "session", session);
    return { started: sessionInfo(session), previous: previous ? sessionInfo(previous) : null };
  },

  async "session.list"({ session: ref = "current", limit = 200 }) {
    const entries = scanTagged((tag) => matchesSession(tag, ref, session.id));
    const sessions = summarizeSessions(entries, session.id).map(formatSession);
    if (ref === "all") return { current: sessionInfo(session), sessions };
    const named = entries.filter((e) => !COUNTED_TYPES.has(e.type));
    const counted = {};
    for (const e of entries.filter((x) => COUNTED_TYPES.has(x.type))) {
      const k = `${e.type} on ${e.parentName}`;
      counted[k] = (counted[k] ?? 0) + 1;
    }
    return {
      current: sessionInfo(session),
      sessions,
      total: entries.length,
      documents: named.slice(0, limit).map(brief),
      more: named.length > limit ? named.length - limit : undefined,
      mapPieces: Object.keys(counted).length ? counted : undefined,
      note: entries.length ? undefined : `Nothing tagged for "${ref}". Things made before session tagging (module v0.3.0) aren't tracked.`,
    };
  },

  async "session.cleanup"({ session: ref, confirm, includeCharacterItems }) {
    if (!ref) throw new Error("Say which session to clean up: 'current', a session name, or an ID from session_log.");
    const entries = scanTagged((tag) => matchesSession(tag, ref, session.id));
    if (!entries.length) return { found: 0, note: `Nothing tagged for "${ref}". Use session_log with session 'all' to see the sessions.` };
    const plan = planCleanup(entries, { includeCharacterItems });
    const sessions = summarizeSessions(entries, session.id).map(formatSession);
    const notTracked = "Uploaded files and chat messages are not removed.";
    if (confirm !== true) {
      return {
        preview: true,
        sessions,
        willDelete: describePlan(plan),
        kept: plan.kept.length ? plan.kept : undefined,
        notTracked,
        next: "Nothing deleted yet. Show this to the GM, and call again with confirm: true only if they say yes.",
      };
    }

    const errors = [];
    const done = { top: [], embedded: [], folders: [] };
    const kept = [...plan.kept];

    // Things Claude added to scenes, actors and journals it didn't make.
    const byParent = new Map();
    for (const e of plan.embedded) {
      const key = `${e.parentUuid}|${e.type}`;
      if (!byParent.has(key)) byParent.set(key, { parent: e.doc.parent, type: e.type, list: [] });
      byParent.get(key).list.push(e);
    }
    for (const { parent, type, list } of byParent.values()) {
      const live = list.filter((e) => parent.getEmbeddedCollection(type).get(e.doc.id));
      if (!live.length) continue;
      try {
        await parent.deleteEmbeddedDocuments(type, live.map((e) => e.doc.id));
        done.embedded.push(...live);
      } catch (err) {
        errors.push(`${type} on ${parent.name}: ${err.message}`);
      }
    }

    // Whole documents, a type at a time.
    for (const type of TOP_TYPES) {
      if (type === "Folder") continue;
      const collection = game.collections.get(type);
      const live = plan.top.filter((e) => e.type === type && collection?.get(e.doc.id));
      if (!live.length) continue;
      try {
        await docClass(type).deleteDocuments(live.map((e) => e.doc.id));
        done.top.push(...live);
      } catch (err) {
        errors.push(`${type}: ${err.message}`);
      }
    }

    // Folders last, and only when nothing is left in them.
    for (const e of plan.folders) {
      const f = game.folders.get(e.doc.id);
      if (!f) continue;
      const hasDocs = game.collections.get(f.type)?.some((d) => d.folder?.id === f.id);
      const hasFolders = game.folders.some((x) => x.folder?.id === f.id);
      if (hasDocs || hasFolders) {
        kept.push({ uuid: e.uuid, name: e.name, reason: "folder still holds things that weren't part of this cleanup" });
        continue;
      }
      try {
        await f.delete();
        done.folders.push(e);
      } catch (err) {
        errors.push(`Folder ${e.name}: ${err.message}`);
      }
    }

    return {
      sessions,
      deleted: describePlan(done),
      kept: kept.length ? kept : undefined,
      errors: errors.length ? errors : undefined,
      notTracked,
    };
  },

  async "script.run"({ code }) {
    if (!game.settings.get(MODULE_ID, "allowScripts")) {
      throw new Error("Scripts are turned off. The GM can enable 'Allow scripts' in the Foundry MCP Bridge module settings.");
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("game", "canvas", "ui", "foundry", "CONFIG", code);
    const result = await fn(game, canvas, ui, foundry, CONFIG);
    try {
      return JSON.parse(JSON.stringify(result ?? null));
    } catch {
      return String(result);
    }
  },
};
