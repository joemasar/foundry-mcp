// Spell areas and Regions: turns areas in feet and shapes in grid squares into Foundry v14 Region shape
// data (pixels), works out which squares an area covers, and builds the trap macro. No Foundry globals,
// so it can be tested in Node.
//
// A "frame" describes the scene's grid: { size (pixels per square), distance (feet per square),
// x0, y0 (pixel position of the top-left of the map, inside the padding) }.
// Grid points are in squares counted from 0 at the top-left: 2 is a grid line, 2.5 the middle of a square.
// Angles are degrees clockwise from east: 0 = east, 90 = south, as Foundry uses them.

export const AREA_KINDS = ["burst", "cone", "line", "emanation", "square"];

// PF2e spell area types and the kind we place for each.
const PF2E_AREAS = { burst: "burst", cylinder: "burst", cone: "cone", line: "line", emanation: "emanation", cube: "square", square: "square" };

const COMPASS = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
const COMPASS_WORDS = { east: "e", southeast: "se", south: "s", southwest: "sw", west: "w", northwest: "nw", north: "n", northeast: "ne" };

const EPS = 1e-6;

const round2 = (v) => Math.round(v * 100) / 100;
const norm = (d) => ((d % 360) + 360) % 360;

export function compassDegrees(dir) {
  if (typeof dir === "number" && Number.isFinite(dir)) return norm(dir);
  const s = String(dir ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  const key = COMPASS_WORDS[s] ?? s;
  if (key in COMPASS) return COMPASS[key];
  const n = Number(s);
  if (s !== "" && Number.isFinite(n)) return norm(n);
  throw new Error(`Unknown direction "${dir}". Use degrees (0 = east, 90 = south) or n, ne, e, se, s, sw, w, nw.`);
}

export function angleTo(from, to) {
  if (Math.abs(to.x - from.x) < EPS && Math.abs(to.y - from.y) < EPS) throw new Error("The area can't point at its own starting point.");
  return round2(norm((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI));
}

export function feetToPixels(feet, frame) {
  return (feet / (frame.distance || 5)) * frame.size;
}

export function toPixels(p, frame) {
  return { x: round2(frame.x0 + p.x * frame.size), y: round2(frame.y0 + p.y * frame.size) };
}

export function toSquares(p, frame) {
  return { x: round2((p.x - frame.x0) / frame.size), y: round2((p.y - frame.y0) / frame.size) };
}

// Where a ray from the middle of a rectangle in direction deg leaves it. Straight out of a side for
// 0/90/180/270, out of a corner for the diagonals.
export function edgePoint(rect, deg) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const tx = Math.abs(dx) > EPS ? rect.w / 2 / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > EPS ? rect.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: round2(rect.x + rect.w / 2 + dx * t), y: round2(rect.y + rect.h / 2 + dy * t) };
}

// A PF2e spell's system.area ({ type, value }) as the kind and size we place.
export function spellAreaFromPf2e(area) {
  if (!area?.type) throw new Error("That spell has no area. Give shape and size instead.");
  const kind = PF2E_AREAS[area.type];
  if (!kind) throw new Error(`PF2e "${area.type}" areas aren't supported here; give shape and size instead.`);
  return { kind, feet: Number(area.value) || 5, pf2eType: area.type };
}

/**
 * Region shape data (pixels) for a spell area.
 * kind: burst | cone | line | emanation | square. feet: radius, length, or side of a square.
 * at: a grid point. For a burst it's the centre (use a grid intersection, e.g. {x:4,y:6}); for a cone or
 *   line the starting point; for a square its top-left corner; for an emanation the square it comes from.
 * token: the caster's token source ({ x, y in pixels; width, height in squares; shape }). Without at, a
 *   burst or square is centred on it, an emanation surrounds it, and a cone or line starts at its edge.
 * direction (degrees or compass) or toward (a grid point) aims a cone or line.
 */
export function spellAreaShape({ kind, feet, at, token, direction, toward, angle = 90, widthFeet = 5 }, frame) {
  if (!AREA_KINDS.includes(kind)) throw new Error(`Unknown area "${kind}". Use ${AREA_KINDS.join(", ")}.`);
  if (!(feet > 0)) throw new Error("The area's size in feet must be more than 0.");
  const r = round2(feetToPixels(feet, frame));
  const atPx = at ? toPixels(at, frame) : null;
  const rect = token ? { x: token.x, y: token.y, w: token.width * frame.size, h: token.height * frame.size } : null;
  if (!atPx && !rect) throw new Error("Give at (a grid point) or a token.");
  const centre = rect ? { x: round2(rect.x + rect.w / 2), y: round2(rect.y + rect.h / 2) } : atPx;

  switch (kind) {
    case "burst": {
      const c = atPx ?? centre;
      return { type: "circle", x: c.x, y: c.y, radius: r };
    }
    case "square": {
      const tl = atPx ?? { x: round2(centre.x - r / 2), y: round2(centre.y - r / 2) };
      return { type: "rectangle", x: tl.x, y: tl.y, width: r, height: r, anchorX: 0, anchorY: 0, rotation: 0 };
    }
    case "emanation": {
      const base =
        !atPx && token
          ? { type: "token", x: Math.round(token.x), y: Math.round(token.y), width: token.width, height: token.height, shape: token.shape ?? 0 }
          : { type: "rectangle", x: atPx.x, y: atPx.y, width: frame.size, height: frame.size, anchorX: 0, anchorY: 0, rotation: 0 };
      return { type: "emanation", base, radius: r };
    }
    case "cone":
    case "line": {
      let dir;
      if (toward) dir = angleTo(atPx ?? centre, toPixels(toward, frame));
      else if (direction !== undefined && direction !== null) dir = compassDegrees(direction);
      else throw new Error(`Give a direction or toward to aim the ${kind}.`);
      const o = atPx ?? edgePoint(rect, dir);
      if (kind === "cone") return { type: "cone", x: o.x, y: o.y, radius: r, angle, rotation: dir, curvature: "round" };
      return { type: "line", x: o.x, y: o.y, length: r, width: round2(feetToPixels(widthFeet, frame)), rotation: dir };
    }
  }
}

// ---------- Region shapes in grid squares ----------

// A set of single squares as few rectangles as possible: runs along each row, then runs stacked when
// they line up.
export function cellsToRects(cells) {
  const seen = new Set();
  const byRow = new Map();
  for (const c of cells) {
    const x = Math.floor(c.x);
    const y = Math.floor(c.y);
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byRow.has(y)) byRow.set(y, []);
    byRow.get(y).push(x);
  }
  const runs = [];
  for (const y of [...byRow.keys()].sort((a, b) => a - b)) {
    const xs = byRow.get(y).sort((a, b) => a - b);
    let start = xs[0];
    let prev = xs[0];
    for (const x of xs.slice(1).concat([Infinity])) {
      if (x === prev + 1) {
        prev = x;
        continue;
      }
      runs.push({ x: start, y, w: prev - start + 1, h: 1 });
      start = prev = x;
    }
  }
  // Stack a run onto the one directly above it when they match.
  const out = [];
  const open = new Map();
  for (const r of runs) {
    const k = `${r.x},${r.w}`;
    const above = open.get(k);
    if (above && above.y + above.h === r.y) above.h++;
    else {
      const rect = { ...r };
      out.push(rect);
      open.set(k, rect);
    }
  }
  return out;
}

/**
 * Region shape data (pixels) from shapes in grid squares:
 *   { type: "rectangle", x, y, w, h }  { type: "circle", x, y, radius }  { type: "polygon", points: [x1,y1, x2,y2, ...] }
 *   { type: "squares", cells: [{x,y}, ...] }   Any of them can have hole: true to cut it out.
 */
export function regionShapes(specs, frame) {
  const out = buildShapes(specs, frame);
  if (!out.length) throw new Error("Give at least one shape.");
  if (out.every((s) => s.hole)) throw new Error("A region needs at least one shape that isn't a hole.");
  return out;
}

function buildShapes(specs, frame) {
  const out = [];
  const px = (v) => round2(v * frame.size);
  for (const s of specs ?? []) {
    const hole = !!s.hole;
    if (s.type === "rectangle") {
      if (!(s.w > 0 && s.h > 0)) throw new Error("A rectangle needs w and h above 0.");
      const p = toPixels(s, frame);
      out.push({ type: "rectangle", x: p.x, y: p.y, width: px(s.w), height: px(s.h), anchorX: 0, anchorY: 0, rotation: 0, hole });
    } else if (s.type === "circle") {
      if (!(s.radius > 0)) throw new Error("A circle needs a radius above 0.");
      const p = toPixels(s, frame);
      out.push({ type: "circle", x: p.x, y: p.y, radius: px(s.radius), hole });
    } else if (s.type === "polygon") {
      const pts = s.points ?? [];
      if (pts.length < 6 || pts.length % 2) throw new Error("A polygon needs at least three x,y pairs.");
      const points = [];
      for (let i = 0; i < pts.length; i += 2) {
        const p = toPixels({ x: pts[i], y: pts[i + 1] }, frame);
        points.push(p.x, p.y);
      }
      out.push({ type: "polygon", points, hole });
    } else if (s.type === "squares") {
      if (!s.cells?.length) throw new Error("Give at least one square in cells.");
      for (const r of cellsToRects(s.cells)) out.push(...buildShapes([{ type: "rectangle", ...r, hole }], frame));
    } else throw new Error(`Unknown shape "${s.type}". Use rectangle, circle, polygon or squares.`);
  }
  return out;
}

// ---------- geometry on Foundry shape data ----------

// Bounding box of a shape that has one: rectangles (with anchor, no rotation), tokens (size in squares).
function boxOf(shape, gridSize) {
  if (shape.type === "token") return { x: shape.x, y: shape.y, w: shape.width * gridSize, h: shape.height * gridSize };
  if (shape.type === "rectangle") {
    return { x: shape.x - (shape.anchorX ?? 0) * shape.width, y: shape.y - (shape.anchorY ?? 0) * shape.height, w: shape.width, h: shape.height };
  }
  return null;
}

function local(shape, p) {
  const a = ((shape.rotation ?? 0) * Math.PI) / 180;
  const dx = p.x - shape.x;
  const dy = p.y - shape.y;
  return { u: dx * Math.cos(a) + dy * Math.sin(a), v: -dx * Math.sin(a) + dy * Math.cos(a) };
}

function inPolygon(points, p) {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i];
    const yi = points[i + 1];
    const xj = points[j];
    const yj = points[j + 1];
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToBox(b, p) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

// Is a point (pixels) inside a shape? Ellipses, rings and grid shapes aren't handled (false).
export function pointInShape(shape, p, gridSize) {
  switch (shape.type) {
    case "circle":
      return Math.hypot(p.x - shape.x, p.y - shape.y) <= shape.radius + EPS;
    case "cone": {
      const { u, v } = local(shape, p);
      const d = Math.hypot(u, v);
      if (d < EPS) return true;
      const off = Math.abs((Math.atan2(v, u) * 180) / Math.PI);
      if (off > shape.angle / 2 + EPS) return false;
      return shape.curvature === "flat" ? u <= shape.radius + EPS : d <= shape.radius + EPS;
    }
    case "line": {
      const { u, v } = local(shape, p);
      return u >= -EPS && u <= shape.length + EPS && Math.abs(v) <= shape.width / 2 + EPS;
    }
    case "rectangle": {
      if (shape.rotation) {
        const { u, v } = local(shape, p);
        const u0 = -(shape.anchorX ?? 0) * shape.width;
        const v0 = -(shape.anchorY ?? 0) * shape.height;
        return u >= u0 - EPS && u <= u0 + shape.width + EPS && v >= v0 - EPS && v <= v0 + shape.height + EPS;
      }
      return distToBox(boxOf(shape, gridSize), p) <= EPS;
    }
    case "token":
      return distToBox(boxOf(shape, gridSize), p) <= EPS;
    case "polygon":
      return inPolygon(shape.points, p);
    case "emanation": {
      const b = shape.base;
      if (b?.type === "circle") return Math.hypot(p.x - b.x, p.y - b.y) <= b.radius + shape.radius + EPS;
      const box = b && boxOf(b, gridSize);
      return !!box && distToBox(box, p) <= shape.radius + EPS;
    }
    default:
      return false;
  }
}

/**
 * Squares (grid x,y) whose middle is inside the shapes, as Foundry highlights a spell area. Holes cut
 * squares out. columns/rows limit it to the map.
 */
export function coveredSquares(shapes, frame, columns, rows) {
  const out = [];
  const solid = shapes.filter((s) => !s.hole);
  const holes = shapes.filter((s) => s.hole);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const p = { x: frame.x0 + (x + 0.5) * frame.size, y: frame.y0 + (y + 0.5) * frame.size };
      if (solid.some((s) => pointInShape(s, p, frame.size)) && !holes.some((s) => pointInShape(s, p, frame.size))) out.push({ x, y });
    }
  }
  return out;
}

// Tokens ({ x, y, w, h } in squares) that stand on any of the squares.
export function tokensOnSquares(tokens, squares) {
  const set = new Set(squares.map((s) => `${s.x},${s.y}`));
  return tokens.filter((t) => {
    for (let dx = 0; dx < Math.max(1, Math.ceil(t.w)); dx++) {
      for (let dy = 0; dy < Math.max(1, Math.ceil(t.h)); dy++) if (set.has(`${Math.round(t.x) + dx},${Math.round(t.y) + dy}`)) return true;
    }
    return false;
  });
}

function arc(cx, cy, r, from, to, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    pts.push(round2(cx + r * Math.cos(a)), round2(cy + r * Math.sin(a)));
  }
  return pts;
}

function boxCorners(b) {
  return [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h];
}

// An outline (flat [x,y, ...] list) of a shape, for drawing it when Foundry's own polygons aren't to hand.
export function shapeOutline(shape, gridSize, segments = 48) {
  switch (shape.type) {
    case "circle":
      return arc(shape.x, shape.y, shape.radius, 0, 360, segments).slice(0, -2);
    case "ellipse": {
      const pts = [];
      const rot = ((shape.rotation ?? 0) * Math.PI) / 180;
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const ex = shape.radiusX * Math.cos(a);
        const ey = shape.radiusY * Math.sin(a);
        pts.push(round2(shape.x + ex * Math.cos(rot) - ey * Math.sin(rot)), round2(shape.y + ex * Math.sin(rot) + ey * Math.cos(rot)));
      }
      return pts;
    }
    case "ring":
      return arc(shape.x, shape.y, shape.radius + (shape.outerWidth ?? 0), 0, 360, segments).slice(0, -2);
    case "cone": {
      const half = shape.angle / 2;
      const from = shape.rotation - half;
      const to = shape.rotation + half;
      if (shape.curvature === "flat") {
        const r = shape.radius / Math.cos((half * Math.PI) / 180);
        return [shape.x, shape.y, ...arc(shape.x, shape.y, r, from, from, 0), ...arc(shape.x, shape.y, r, to, to, 0)];
      }
      return [shape.x, shape.y, ...arc(shape.x, shape.y, shape.radius, from, to, Math.max(4, Math.round((segments * shape.angle) / 360)))];
    }
    case "line": {
      const a = (shape.rotation * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const hw = shape.width / 2;
      const nx = -uy * hw;
      const ny = ux * hw;
      const ex = shape.x + ux * shape.length;
      const ey = shape.y + uy * shape.length;
      return [shape.x + nx, shape.y + ny, ex + nx, ey + ny, ex - nx, ey - ny, shape.x - nx, shape.y - ny].map(round2);
    }
    case "rectangle": {
      if (!shape.rotation) return boxCorners(boxOf(shape, gridSize));
      const a = (shape.rotation * Math.PI) / 180;
      const u0 = -(shape.anchorX ?? 0) * shape.width;
      const v0 = -(shape.anchorY ?? 0) * shape.height;
      const pts = [];
      for (const [u, v] of [
        [u0, v0],
        [u0 + shape.width, v0],
        [u0 + shape.width, v0 + shape.height],
        [u0, v0 + shape.height],
      ]) {
        pts.push(round2(shape.x + u * Math.cos(a) - v * Math.sin(a)), round2(shape.y + u * Math.sin(a) + v * Math.cos(a)));
      }
      return pts;
    }
    case "token":
      return boxCorners(boxOf(shape, gridSize));
    case "polygon":
      return [...shape.points];
    case "emanation": {
      const b = shape.base;
      const r = shape.radius;
      if (b?.type === "circle") return arc(b.x, b.y, b.radius + r, 0, 360, segments).slice(0, -2);
      const box = b && boxOf(b, gridSize);
      if (!box) return [];
      const q = Math.max(2, Math.round(segments / 4));
      // A rounded rectangle: the box grown by r, with quarter circles at the corners.
      return [
        ...arc(box.x + box.w, box.y + box.h, r, 0, 90, q),
        ...arc(box.x, box.y + box.h, r, 90, 180, q),
        ...arc(box.x, box.y, r, 180, 270, q),
        ...arc(box.x + box.w, box.y, r, 270, 360, q),
      ];
    }
    default:
      return [];
  }
}

// ---------- Region behaviours ----------

// Movement costs for difficult terrain: PF2e uses 2 for difficult and 3 for greater difficult terrain.
// Flying ignores it unless flying is true.
export function terrainDifficulties(actions, level = "difficult", flying = false) {
  const cost = level === "greater" ? 3 : 2;
  const out = {};
  for (const a of actions) out[a] = a === "fly" && !flying ? 1 : cost;
  return out;
}

const SAVES = ["fortitude", "reflex", "will"];

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// "2d6" + "fire" -> "2d6[fire]". A formula that already names its type ("2d6[fire]") is kept.
export function damageFormula(damage, type) {
  const f = String(damage ?? "").trim();
  if (!f) return "";
  if (!/^[0-9dDkKhHlL+\-*/()\s,[\]a-zA-Z]+$/.test(f) || /[@{}|]/.test(f)) throw new Error(`"${damage}" isn't a damage formula like "2d6" or "4d6+3".`);
  if (f.includes("[") || !type) return f;
  if (!/^[a-z-]+$/i.test(type)) throw new Error(`"${type}" isn't a damage type like "fire" or "piercing".`);
  const t = type.toLowerCase();
  return /^[0-9]*d?[0-9]+$/i.test(f) ? `${f}[${t}]` : `(${f})[${t}]`;
}

// The chat card a trap posts when it goes off, with PF2e's save and damage buttons.
export function trapCard({ name, message, save, damage, damageType }) {
  const parts = [`<p><strong>${escapeHtml(name)}</strong> was triggered by __TOKEN__.</p>`];
  if (message) parts.push(`<p>${escapeHtml(message)}</p>`);
  if (save) {
    const type = String(save.type ?? "").toLowerCase();
    if (!SAVES.includes(type)) throw new Error(`The save must be one of ${SAVES.join(", ")}.`);
    if (!(save.dc > 0)) throw new Error("The save needs a DC.");
    parts.push(`<p>@Check[${type}|dc:${Math.round(save.dc)}${save.basic ? "|basic" : ""}]</p>`);
  }
  const formula = damageFormula(damage, damageType);
  if (formula) parts.push(`<p>@Damage[${formula}]</p>`);
  return parts.join("");
}

/**
 * Script for the Macro a trap Region runs on entry. Foundry gives the macro token, region, behavior and
 * event. It runs on the GM's client (players can't use the macro), so it can switch the trap off.
 * cfg: { name, message?, save?: {type, dc, basic?}, damage?, damageType?, once?, pause?, announce?, playersOnly? }
 */
export function trapMacroSource(cfg) {
  const settings = {
    card: trapCard(cfg),
    name: String(cfg.name ?? "Trap"),
    once: cfg.once !== false,
    pause: !!cfg.pause,
    announce: !!cfg.announce,
    playersOnly: cfg.playersOnly !== false,
  };
  return [
    "// Made by Foundry MCP: posts the trap's card when a token enters the region.",
    `const cfg = ${JSON.stringify(settings)};`,
    "const tok = event?.data?.token ?? token?.document;",
    "if (!tok) return;",
    "if (cfg.playersOnly && !tok.actor?.hasPlayerOwner) return;",
    "const who = foundry.utils.escapeHTML ? foundry.utils.escapeHTML(tok.name) : tok.name;",
    "const whisper = cfg.announce ? [] : game.users.filter((u) => u.isGM).map((u) => u.id);",
    "await ChatMessage.create({ content: cfg.card.replace('__TOKEN__', who), speaker: { alias: cfg.name }, whisper });",
    "if (cfg.pause) game.togglePause(true, { broadcast: true });",
    "if (cfg.once) await behavior.update({ disabled: true });",
  ].join("\n");
}

// ---------- waiting for token moves ----------

// v14 plays a move out step by step, and a Region can teleport the token just after it stops, so
// move_tokens watches positions until they settle. Given how long the positions have been unchanged
// (stillMs), how long it has waited (elapsedMs) and whether every token is on its target square:
// stop once all have arrived and held still briefly, once nothing has moved for a while (stopped
// short or teleported), or at the time limit.
export const MOVE_WAIT = { arrivedMs: 300, stillMs: 1200, maxMs: 10_000, pollMs: 150 };

export function moveSettled({ stillMs, elapsedMs, allArrived }, limits = MOVE_WAIT) {
  if (elapsedMs >= limits.maxMs) return true;
  if (allArrived) return stillMs >= limits.arrivedMs;
  return stillMs >= limits.stillMs;
}
