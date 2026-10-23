// Session tagging: everything Claude creates gets a flag naming the session it was made in, so the
// GM can list it or clean it up later. This file has no Foundry globals, so it can be tested in Node.

export const SESSION_HOURS = 12;

// Top-level document types we look through, in the order cleanup deletes them. Folders go last,
// and only when they're empty.
export const TOP_TYPES = ["Combat", "Scene", "Actor", "Item", "JournalEntry", "RollTable", "Playlist", "Macro", "Folder"];

// Embedded documents we tag when they're added to something Claude didn't make.
export const EMBEDDED = {
  Scene: { tokens: "Token", walls: "Wall", lights: "AmbientLight", notes: "Note", drawings: "Drawing", sounds: "AmbientSound", tiles: "Tile" },
  Actor: { items: "Item" },
  JournalEntry: { pages: "JournalEntryPage" },
};

// Walls, lights and drawings have no useful names, so lists show them as counts.
export const COUNTED_TYPES = new Set(["Wall", "AmbientLight", "Drawing", "AmbientSound", "Tile"]);

function pad(n) {
  return String(n).padStart(2, "0");
}

export function autoName(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function newSession(name, now, makeId) {
  const clean = typeof name === "string" ? name.trim() : "";
  return { id: makeId(), name: clean || autoName(now), started: now, auto: !clean };
}

// A session ends 12 hours after it started, so next week's game doesn't land in tonight's session.
export function isExpired(session, now) {
  return !session?.id || !(session.started > 0) || now - session.started > SESSION_HOURS * 3600 * 1000;
}

export function makeTag(session, docId, now) {
  return { session: session.id, sessionName: session.name, id: docId, createdAt: now };
}

// A document counts as Claude's only if the tag was written for that exact document. Copies the GM
// makes (duplicating an actor, say) get a new ID, so they aren't picked up.
export function tagOf(doc, moduleId) {
  const t = doc?.flags?.[moduleId];
  return t?.session && t.id === doc.id ? t : null;
}

// ref is "current", "all", a session ID, or a session name (case-insensitive; every session with
// that name matches).
export function matchesSession(tag, ref, currentId) {
  if (!ref || ref === "current") return tag.session === currentId;
  if (ref === "all") return true;
  const r = String(ref).trim().toLowerCase();
  return tag.session.toLowerCase() === r || String(tag.sessionName ?? "").trim().toLowerCase() === r;
}

// Group tagged entries by session for an overview.
export function summarizeSessions(entries, currentId) {
  const by = new Map();
  for (const e of entries) {
    let s = by.get(e.tag.session);
    if (!s) {
      s = { id: e.tag.session, name: e.tag.sessionName, current: e.tag.session === currentId || undefined, first: e.tag.createdAt, last: e.tag.createdAt, counts: {} };
      by.set(e.tag.session, s);
    }
    s.first = Math.min(s.first, e.tag.createdAt);
    s.last = Math.max(s.last, e.tag.createdAt);
    s.counts[e.type] = (s.counts[e.type] ?? 0) + 1;
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

// Work out what a cleanup would delete and what it keeps, and why.
// Each entry: { uuid, type, name, tag, parentUuid?, parentName?, parentIsCharacter?, active?, depth? }
//   parentUuid is set for embedded documents. depth is the folder nesting depth (for folders).
export function planCleanup(entries, { includeCharacterItems = false } = {}) {
  const chosen = new Set(entries.map((e) => e.uuid));
  const top = [];
  const embedded = [];
  const folders = [];
  const kept = [];
  for (const e of entries) {
    if (e.parentUuid) {
      // Goes away with its parent anyway.
      if (chosen.has(e.parentUuid)) continue;
      if (e.type === "Item" && e.parentIsCharacter && !includeCharacterItems) {
        kept.push({ uuid: e.uuid, name: e.name, on: e.parentName, reason: "on a player character (set includeCharacterItems to remove it)" });
        continue;
      }
      embedded.push(e);
    } else if (e.type === "Folder") {
      folders.push(e);
    } else if (e.type === "Scene" && e.active) {
      kept.push({ uuid: e.uuid, name: e.name, reason: "it's the active scene; switch scenes first" });
    } else {
      top.push(e);
    }
  }
  // Anything left inside a kept scene stays too.
  const keptUuids = new Set(kept.map((k) => k.uuid));
  const embeddedFinal = embedded.filter((e) => !keptUuids.has(e.parentUuid));
  top.sort((a, b) => TOP_TYPES.indexOf(a.type) - TOP_TYPES.indexOf(b.type));
  // Deepest folders first, so a parent can be empty by the time we reach it.
  folders.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  return { top, embedded: embeddedFinal, folders, kept };
}

// A short, readable version of a plan or result for Claude to show the GM.
export function describePlan(plan) {
  const groups = {};
  const add = (key, label) => (groups[key] ??= []).push(label);
  for (const e of plan.top) add(e.type, e.name);
  for (const e of plan.folders) add("Folder (if empty)", e.name);
  const counted = {};
  for (const e of plan.embedded) {
    if (COUNTED_TYPES.has(e.type)) {
      const k = `${e.type} on ${e.parentName}`;
      counted[k] = (counted[k] ?? 0) + 1;
    } else add(`${e.type} on another document`, `${e.name} (on ${e.parentName})`);
  }
  for (const [k, n] of Object.entries(counted)) add("Walls, lights and drawings", `${n} ${k}`);
  return groups;
}
