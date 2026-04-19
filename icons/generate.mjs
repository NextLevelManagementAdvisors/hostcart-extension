#!/usr/bin/env node
/**
 * Placeholder icon generator for the Hostcart extension. Produces
 * solid-color PNG squares matching Chrome's required sizes (16/32/48/128).
 * Replace these with proper renders of icon.svg before public release.
 *
 * Usage: node extension/icons/generate.mjs
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const COLOR = [0x0f, 0x17, 0x2a]; // matches icon.svg background
const SIZES = [16, 32, 48, 128];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;       // bit depth
  ihdrData[9] = 2;       // color type RGB
  ihdrData[10] = 0;      // compression
  ihdrData[11] = 0;      // filter
  ihdrData[12] = 0;      // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = COLOR[0];
      raw[p + 1] = COLOR[1];
      raw[p + 2] = COLOR[2];
    }
  }
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

for (const size of SIZES) {
  const file = join(here, `icon-${size}.png`);
  writeFileSync(file, makePng(size));
  console.log(`wrote ${file}`);
}
