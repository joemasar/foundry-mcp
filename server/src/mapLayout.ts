// Turns a list of rectangular rooms (in grid cells) into walls, doors and floor drawings.
// Pure function, so it can be tested without Foundry.
//
// Coordinates: cell (0,0) is the top-left square of the scene. A room {x:2, y:3, w:4, h:2}
// covers columns 2-5 and rows 3-4. Wall coordinates are grid-line intersections.

export type Side = "n" | "s" | "e" | "w";
export type DoorType = "door" | "secret" | "opening";

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  color?: string;
  lit?: boolean;
}

export interface Door {
  x: number;
  y: number;
  side: Side;
  type?: DoorType;
}

export interface LayoutWall {
  c: [number, number, number, number];
  door: 0 | 1 | 2; // 0 wall, 1 door, 2 secret door
}

export interface LayoutDrawing {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  color: string;
}

export interface LayoutLight {
  x: number;
  y: number;
}

export interface Layout {
  walls: LayoutWall[];
  drawings: LayoutDrawing[];
  lights: LayoutLight[];
  width: number; // in cells
  height: number;
}

const PALETTE = ["#6b5b45", "#4f5d4a", "#5a5068", "#4d5a66", "#6a4e4e", "#5e5a44"];

// Edge keys: "h:x:y" is the horizontal line from (x,y) to (x+1,y); "v:x:y" is the vertical line from (x,y) to (x,y+1).
function edgeKey(x: number, y: number, side: Side): string {
  switch (side) {
    case "n":
      return `h:${x}:${y}`;
    case "s":
      return `h:${x}:${y + 1}`;
    case "w":
      return `v:${x}:${y}`;
    case "e":
      return `v:${x + 1}:${y}`;
  }
}

export function buildLayout(rooms: Room[], doors: Door[] = []): Layout {
  const owner = new Map<string, number>();
  let maxX = 0;
  let maxY = 0;
  rooms.forEach((r, i) => {
    if (r.w <= 0 || r.h <= 0) throw new Error(`Room ${i + 1} has no size`);
    if (r.x < 0 || r.y < 0) throw new Error(`Room ${i + 1} has negative coordinates`);
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) owner.set(`${x},${y}`, i);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  });

  // Walls go wherever a floor cell meets empty space or a different room.
  const wallEdges = new Set<string>();
  for (const [cell, i] of owner) {
    const [x, y] = cell.split(",").map(Number);
    const neighbours: [Side, number, number][] = [
      ["n", x, y - 1],
      ["s", x, y + 1],
      ["w", x - 1, y],
      ["e", x + 1, y],
    ];
    for (const [side, nx, ny] of neighbours) {
      if (owner.get(`${nx},${ny}`) !== i) wallEdges.add(edgeKey(x, y, side));
    }
  }

  // Doors replace the wall on their edge (or remove it, for an opening).
  const doorEdges = new Map<string, 1 | 2>();
  for (const d of doors) {
    const key = edgeKey(d.x, d.y, d.side);
    wallEdges.delete(key);
    if (d.type === "opening") continue;
    doorEdges.set(key, d.type === "secret" ? 2 : 1);
  }

  const walls: LayoutWall[] = [];

  // Merge straight runs of plain wall into single segments.
  const rows = new Map<number, number[]>(); // horizontal: y -> xs
  const cols = new Map<number, number[]>(); // vertical: x -> ys
  for (const key of wallEdges) {
    const [kind, a, b] = key.split(":");
    const x = Number(a);
    const y = Number(b);
    if (kind === "h") (rows.get(y) ?? rows.set(y, []).get(y)!).push(x);
    else (cols.get(x) ?? cols.set(x, []).get(x)!).push(y);
  }
  for (const [y, xs] of rows) {
    xs.sort((p, q) => p - q);
    let start = xs[0];
    let prev = xs[0];
    for (let k = 1; k <= xs.length; k++) {
      if (k < xs.length && xs[k] === prev + 1) {
        prev = xs[k];
        continue;
      }
      walls.push({ c: [start, y, prev + 1, y], door: 0 });
      start = prev = xs[k];
    }
  }
  for (const [x, ys] of cols) {
    ys.sort((p, q) => p - q);
    let start = ys[0];
    let prev = ys[0];
    for (let k = 1; k <= ys.length; k++) {
      if (k < ys.length && ys[k] === prev + 1) {
        prev = ys[k];
        continue;
      }
      walls.push({ c: [x, start, x, prev + 1], door: 0 });
      start = prev = ys[k];
    }
  }

  for (const [key, door] of doorEdges) {
    const [kind, a, b] = key.split(":");
    const x = Number(a);
    const y = Number(b);
    walls.push({ c: kind === "h" ? [x, y, x + 1, y] : [x, y, x, y + 1], door });
  }

  const drawings = rooms.map((r, i) => ({
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    label: r.label,
    color: r.color ?? PALETTE[i % PALETTE.length],
  }));
  const lights = rooms.filter((r) => r.lit).map((r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }));

  return { walls, drawings, lights, width: maxX, height: maxY };
}
