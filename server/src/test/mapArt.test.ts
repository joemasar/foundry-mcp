import { test } from "node:test";
import assert from "node:assert/strict";
import { fitGrid, imageDimensions, sniffImageType } from "../mapArt.js";

function png(w: number, h: number) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w: number, h: number) {
  // SOI, an APP0 segment to skip, then a baseline SOF0 frame header.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.alloc(8)]);
}

function webp(kind: "VP8 " | "VP8L" | "VP8X", w: number, h: number) {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "ascii");
  b.write(kind, 12, "ascii");
  if (kind === "VP8 ") {
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === "VP8L") {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}

test("image sizes are read from PNG, JPEG, GIF and WebP bytes", () => {
  assert.deepEqual(imageDimensions(png(2048, 1536)), { width: 2048, height: 1536 });
  assert.deepEqual(imageDimensions(jpeg(1792, 1024)), { width: 1792, height: 1024 });
  const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
  assert.deepEqual(imageDimensions(gif), { width: 320, height: 240 });
  assert.deepEqual(imageDimensions(webp("VP8 ", 1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(imageDimensions(webp("VP8L", 1000, 600)), { width: 1000, height: 600 });
  assert.deepEqual(imageDimensions(webp("VP8X", 4096, 3000)), { width: 4096, height: 3000 });
  assert.equal(imageDimensions(Buffer.from("not an image")), null);
});

test("image type is told from the bytes", () => {
  assert.equal(sniffImageType(png(1, 1)), ".png");
  assert.equal(sniffImageType(jpeg(1, 1)), ".jpg");
  assert.equal(sniffImageType(webp("VP8X", 1, 1)), ".webp");
  assert.equal(sniffImageType(Buffer.from("hello")), null);
});

test("columns scale the art to 100 px squares and keep its shape", () => {
  const f = fitGrid(1792, 1024, { columns: 28 });
  assert.equal(f.width, 2800);
  assert.equal(f.height, 1600);
  assert.equal(f.columns, 28);
  assert.equal(f.rows, 16);
  assert.equal(f.gridSize, 100);
});

test("rows, the art's own grid, or a default can set the size", () => {
  const byRows = fitGrid(1024, 1024, { rows: 20 });
  assert.deepEqual([byRows.width, byRows.height, byRows.columns], [2000, 2000, 20]);
  const ownGrid = fitGrid(3000, 2100, { pixelsPerSquare: 150 });
  assert.deepEqual([ownGrid.width, ownGrid.height, ownGrid.columns, ownGrid.rows], [2000, 1400, 20, 14]);
  const guess = fitGrid(1536, 1024);
  assert.equal(guess.columns, 25);
  assert.equal(guess.rows, 16.67);
  assert.match(guess.how, /guess/);
  const big = fitGrid(1000, 500, { columns: 10, gridSize: 140 });
  assert.deepEqual([big.width, big.height], [1400, 700]);
  assert.throws(() => fitGrid(0, 100));
});
