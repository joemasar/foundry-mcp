// Map preview: turns a scene's walls, tokens, lights and notes into simple shapes on a small picture,
// so Claude can look at a map. No Foundry globals, so it can be tested in Node.

export const COLORS = {
  wall: "#ff3b30",
  door: "#ffcc00",
  openDoor: "#7CFC00",
  secret: "#c061ff",
  seeThrough: "#4da6ff", // windows and invisible walls: block movement, not sight
  grid: "rgba(255,255,255,0.25)",
  label: "#ffffff",
  light: "#ffd27f",
  note: "#00e5ff",
  token: { [-2]: "#9b59b6", [-1]: "#e74c3c", 0: "#f1c40f", 1: "#2ecc71" },
};

export const LEGEND = {
  "red line": "wall",
  "yellow line": "closed door",
  "green line": "open door",
  "purple line": "secret door",
  "blue line": "window or invisible wall",
  "red/yellow/green box": "hostile/neutral/friendly token (dashed = hidden)",
  "orange circle": "light (bright radius)",
  "cyan diamond": "map pin",
  "numbers on the edges": "grid squares, counted from 0 at the top-left",
};

/**
 * Scale for drawing the scene's own area (without padding) into at most maxSize pixels on the long side.
 * rect is in canvas pixels: { x, y, w, h }.
 */
export function previewFrame(rect, maxSize = 1024) {
  const scale = Math.min(1, maxSize / Math.max(rect.w, rect.h));
  const width = Math.max(1, Math.round(rect.w * scale));
  const height = Math.max(1, Math.round(rect.h * scale));
  return { scale, width, height, x: (v) => (v - rect.x) * scale, y: (v) => (v - rect.y) * scale };
}

export function wallColor(w) {
  if (w.door === 2) return COLORS.secret;
  if (w.door === 1) return w.ds === 1 ? COLORS.openDoor : COLORS.door;
  if (w.sight === 0 && w.move !== 0) return COLORS.seeThrough;
  return COLORS.wall;
}

/**
 * Shapes to draw, in picture pixels, in drawing order.
 * data: { rect, gridSize, square (bool), images: [{src,x,y,w,h}], walls: [{c,door,ds,sight,move}],
 *         tokens: [{x,y,w,h,name,disposition,hidden}] (canvas pixels), lights: [{x,y,bright}] (bright in pixels),
 *         notes: [{x,y,text}] }
 * show: { grid, walls, tokens, lights, notes } (all default true)
 */
export function previewOps(data, show = {}, maxSize = 1024) {
  const on = (k) => show[k] !== false;
  const f = previewFrame(data.rect, maxSize);
  const ops = [];
  const sq = data.gridSize * f.scale;

  for (const img of data.images ?? []) ops.push({ op: "image", src: img.src, x: f.x(img.x), y: f.y(img.y), w: img.w * f.scale, h: img.h * f.scale });

  const columns = Math.round(data.rect.w / data.gridSize);
  const rows = Math.round(data.rect.h / data.gridSize);
  if (on("grid") && data.square !== false && sq >= 4) {
    for (let c = 0; c <= columns; c++) ops.push({ op: "line", x1: c * sq, y1: 0, x2: c * sq, y2: f.height, color: COLORS.grid, width: 1 });
    for (let r = 0; r <= rows; r++) ops.push({ op: "line", x1: 0, y1: r * sq, x2: f.width, y2: r * sq, color: COLORS.grid, width: 1 });
    const size = Math.max(9, Math.min(16, Math.round(sq * 0.45)));
    const every = sq >= 24 ? 1 : 5;
    for (let c = 0; c < columns; c += every) ops.push({ op: "text", text: String(c), x: c * sq + sq / 2, y: 2, size, color: COLORS.label, align: "center", baseline: "top" });
    for (let r = 0; r < rows; r += every) ops.push({ op: "text", text: String(r), x: 2, y: r * sq + sq / 2, size, color: COLORS.label, align: "left", baseline: "middle" });
  }

  if (on("lights")) {
    for (const l of data.lights ?? []) {
      ops.push({ op: "circle", x: f.x(l.x), y: f.y(l.y), r: Math.max(3, (l.bright ?? 0) * f.scale), color: COLORS.light, width: 1.5 });
    }
  }

  if (on("walls")) {
    const lw = Math.max(2, Math.round(sq / 12));
    for (const w of data.walls ?? []) {
      const [x1, y1, x2, y2] = w.c;
      ops.push({ op: "line", x1: f.x(x1), y1: f.y(y1), x2: f.x(x2), y2: f.y(y2), color: wallColor(w), width: w.door ? lw + 1 : lw });
    }
  }

  if (on("tokens")) {
    for (const t of data.tokens ?? []) {
      const color = COLORS.token[t.disposition] ?? COLORS.token[0];
      const x = f.x(t.x);
      const y = f.y(t.y);
      const w = t.w * f.scale;
      const h = t.h * f.scale;
      ops.push({ op: "rect", x, y, w, h, color, width: 2, dashed: !!t.hidden });
      if (w >= 14) ops.push({ op: "text", text: shortName(t.name), x: x + w / 2, y: y + h / 2, size: Math.max(8, Math.min(14, Math.round(w / 4))), color: COLORS.label, align: "center", baseline: "middle" });
    }
  }

  if (on("notes")) {
    for (const n of data.notes ?? []) {
      ops.push({ op: "diamond", x: f.x(n.x), y: f.y(n.y), r: Math.max(4, sq / 5), color: COLORS.note });
      if (n.text) ops.push({ op: "text", text: shortName(n.text, 18), x: f.x(n.x) + Math.max(6, sq / 4), y: f.y(n.y), size: 11, color: COLORS.note, align: "left", baseline: "middle" });
    }
  }

  return { width: f.width, height: f.height, scale: f.scale, columns, rows, ops };
}

export function shortName(name, max = 10) {
  const s = String(name ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
