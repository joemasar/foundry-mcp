// Turning map art into a scene: read the image size and work out a scene that fits a grid.
// Pure functions so they can be unit tested.

/** Width and height of a PNG, JPEG, GIF or WebP image from its bytes, or null if it can't tell. */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Start-of-frame markers hold the size; C4, C8 and CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** File extension for image bytes (".png", ".jpg", ".gif", ".webp"), or null. */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") return ".gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

export interface GridFit {
  /** Scene size in pixels; the art is stretched to exactly this, keeping its shape. */
  width: number;
  height: number;
  gridSize: number;
  columns: number;
  rows: number;
  how: string;
}

const DEFAULT_LONG_SIDE = 25;

/**
 * A scene size for map art. Give the squares across (columns) or down (rows), or the art's own
 * pixels per square if it has a grid drawn on it. With none, the long side gets 25 squares.
 * Scenes use gridSize pixels per square (default 100), so the art is scaled to match.
 */
export function fitGrid(
  imageWidth: number,
  imageHeight: number,
  opts: { columns?: number; rows?: number; pixelsPerSquare?: number; gridSize?: number } = {},
): GridFit {
  if (!(imageWidth > 0 && imageHeight > 0)) throw new Error("The image has no size.");
  const gridSize = opts.gridSize ?? 100;
  let squarePx: number; // image pixels per square
  let how: string;
  if (opts.pixelsPerSquare) {
    squarePx = opts.pixelsPerSquare;
    how = `the art's own grid of ${opts.pixelsPerSquare} px per square`;
  } else if (opts.columns) {
    squarePx = imageWidth / opts.columns;
    how = `${opts.columns} squares across`;
  } else if (opts.rows) {
    squarePx = imageHeight / opts.rows;
    how = `${opts.rows} squares down`;
  } else {
    squarePx = Math.max(imageWidth, imageHeight) / DEFAULT_LONG_SIDE;
    how = `a guess of ${DEFAULT_LONG_SIDE} squares on the long side; give columns or rows to set it`;
  }
  const scale = gridSize / squarePx;
  const width = Math.round(imageWidth * scale);
  const height = Math.round(imageHeight * scale);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return { width, height, gridSize, columns: round2(width / gridSize), rows: round2(height / gridSize), how };
}
