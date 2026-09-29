// Generates public/cover.png (1280x720, 16:9 submission cover).
// Run: node scripts/make-cover.js. No dependencies (raw PNG via zlib).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 1280, H = 720;
const raw = Buffer.alloc(W * H * 3 + H);
const px = (x, y, c) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const o = y * (W * 3 + 1) + 1 + x * 3;
  raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
};
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  const t = y / H;
  const bg = [Math.round(15 + t * 18), Math.round(23 + t * 30), Math.round(42 + t * 46)];
  for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = bg[0]; raw[o + 1] = bg[1]; raw[o + 2] = bg[2]; }
}
// cyan glow disc behind mic
const CYAN = [34, 211, 238], WHITE = [226, 232, 240], DIM = [148, 163, 184];
for (let y = 0; y < H; y++) for (let x = 0; x < H; x++) {
  const d = Math.hypot(x - 300, y - 360) / 300;
  if (d < 1) {
    const o = y * (W * 3 + 1) + 1 + x * 3;
    const k = (1 - d) * 0.25;
    raw[o] = Math.min(255, raw[o] + 34 * k); raw[o + 1] = Math.min(255, raw[o + 1] + 211 * k); raw[o + 2] = Math.min(255, raw[o + 2] + 238 * k);
  }
}
// mic glyph
const cx = 300, r = 78, top = 200, bot = 430;
for (let y = top; y < bot; y++) for (let x = cx - r; x < cx + r; x++) {
  const inCap = (y > top + r && y < bot - r && Math.abs(x - cx) <= r);
  const dTop = Math.hypot(x - cx, y - (top + r)), dBot = Math.hypot(x - cx, y - (bot - r));
  if (inCap || (y <= top + r && dTop <= r) || (y >= bot - r && dBot <= r)) px(x, y, CYAN);
}
for (let a = 0; a <= Math.PI; a += 0.005) px(cx + Math.cos(a) * r * 1.6, (top + bot) / 2 + 8 + Math.sin(a) * r * 1.1, CYAN);
for (let y = (top + bot) / 2 + 8 + r * 1.1; y < 590; y++) px(cx, y, CYAN);
for (let x = cx - r; x < cx + r; x++) { px(x, 590, CYAN); px(x, 591, CYAN); }
// 5x7 pixel font
const F = { A: [0x7E,0x11,0x11,0x11,0x7E],B: [0x7F,0x49,0x49,0x49,0x36],C: [0x3E,0x41,0x41,0x41,0x22],D: [0x7F,0x41,0x41,0x22,0x1C],E: [0x7F,0x49,0x49,0x49,0x41],F: [0x7F,0x48,0x48,0x48,0x40],G: [0x3E,0x41,0x49,0x49,0x7A],H: [0x7F,0x08,0x08,0x08,0x7F],I: [0x00,0x41,0x7F,0x41,0x00],J: [0x20,0x40,0x41,0x3F,0x01],K: [0x7F,0x08,0x14,0x22,0x41],L: [0x7F,0x01,0x01,0x01,0x01],M: [0x7F,0x20,0x10,0x20,0x7F],N: [0x7F,0x04,0x08,0x10,0x7F],O: [0x3E,0x41,0x41,0x41,0x3E],P: [0x7F,0x48,0x48,0x48,0x30],Q: [0x3E,0x41,0x51,0x21,0x5E],R: [0x7F,0x48,0x4C,0x4A,0x31],S: [0x31,0x49,0x49,0x49,0x46],T: [0x40,0x40,0x7F,0x40,0x40],U: [0x7F,0x01,0x01,0x01,0x7F],V: [0x7C,0x02,0x01,0x02,0x7C],W: [0x7F,0x02,0x0C,0x02,0x7F],X: [0x63,0x14,0x08,0x14,0x63],Y: [0x07,0x08,0x70,0x08,0x07],Z: [0x61,0x51,0x49,0x45,0x43],' ': [0,0,0,0,0],'.': [0,0x60,0x60,0,0],'-': [0x08,0x08,0x08,0x08,0x08] };
function text(str, x, y, scale, color) {
  let cxp = x;
  for (const ch of str.toUpperCase()) {
    const g = F[ch] || F[' '];
    for (let col = 0; col < 5; col++)
      for (let row = 0; row < 7; row++)
        if (g[col] & (1 << row))
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) px(cxp + col * scale + dx, y + (6 - row) * scale + dy, color);
    cxp += 6 * scale;
  }
  return cxp;
}
text('ORATOR', 560, 250, 16, WHITE);
text('PRACTICE. DIAGNOSE. RETRY. IMPROVE.', 562, 400, 3, CYAN);
text('SPEECH. DEBATE. INTERVIEW.', 562, 440, 3, DIM);

function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
}
const TABLE = crcTable();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  let c = 0xffffffff;
  for (let i = 0; i < td.length; i++) c = TABLE[(c ^ td[i]) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'public', 'cover.png');
fs.writeFileSync(out, png);
console.log('wrote', out, (png.length / 1024).toFixed(0) + 'KB');
