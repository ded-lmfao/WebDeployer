/**
 * Pure-JS ISO/IEC 18004 QR Code SVG Generator
 * Fully offline, zero external dependencies, renders crisp SVG matrix for TOTP authenticators.
 */

export function renderTotpQrSvg(text) {
  try {
    const matrix = generateQrMatrix(text);
    const n = matrix.length;
    const quiet = 4;
    const total = n + quiet * 2;
    let paths = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return `<svg viewBox="0 0 ${total} ${total}" width="144" height="144" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${paths}" fill="#070b14"/></svg>`;
  } catch {
    return `<div style="font-size:11px; color:#070b14; text-align:center; padding:8px;">Use Setup Key</div>`;
  }
}

export function generateQrMatrix(text) {
  const dataBytes = new TextEncoder().encode(text);
  // Version table for ECC Level L (versions 1..10): [totalCodewords, ecCodewordsPerBlock, numBlocks]
  const V_TABLE = [
    null,
    [26, 7, 1],
    [44, 10, 1],
    [70, 15, 1],
    [100, 20, 1],
    [134, 26, 1],
    [172, 18, 2],
    [196, 20, 2],
    [242, 24, 2],
    [292, 30, 2],
    [346, 18, 4],
  ];
  let ver = 1;
  while (ver <= 10) {
    const [totalCw, ecCw, blocks] = V_TABLE[ver];
    const dataCw = totalCw - ecCw * blocks;
    const headerBytes = ver < 10 ? 2 : 3;
    if (dataBytes.length + headerBytes <= dataCw) break;
    ver++;
  }
  if (ver > 10) ver = 10;
  const [totalCw, ecCw, numBlocks] = V_TABLE[ver];
  const totalDataCw = totalCw - ecCw * numBlocks;

  // Build bit stream: Byte mode (0100), length (8 or 16 bits), payload, terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(dataBytes.length, ver < 10 ? 8 : 16);
  for (const b of dataBytes) pushBits(b, 8);
  const maxBits = totalDataCw * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCw.push(b);
  }
  let padToggle = true;
  while (dataCw.length < totalDataCw) {
    dataCw.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }

  // GF(256) Reed-Solomon
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]);

  let gen = [1];
  for (let i = 0; i < ecCw; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = next;
  }

  const rsEncode = (msg) => {
    const rem = new Uint8Array(ecCw);
    for (const b of msg) {
      const factor = b ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecCw - 1] = 0;
      for (let i = 0; i < ecCw; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return Array.from(rem);
  };

  const dataBlocks = [];
  const ecBlocks = [];
  const baseBlockLen = Math.floor(totalDataCw / numBlocks);
  const extraBlocks = totalDataCw % numBlocks;
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = baseBlockLen + (b >= numBlocks - extraBlocks ? 1 : 0);
    const blk = dataCw.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk));
  }

  const finalCw = [];
  const maxDataLen = baseBlockLen + (extraBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) finalCw.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecCw; i++) {
    for (let b = 0; b < numBlocks; b++) finalCw.push(ecBlocks[b][i]);
  }

  const size = ver * 4 + 17;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        grid[rr][cc] = on ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  const ALIGN_POS = [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
  ];
  const apos = ALIGN_POS[ver];
  for (const ar of apos) {
    for (const ac of apos) {
      if (reserved[ar][ac]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          grid[ar + r][ac + c] = on ? 1 : 0;
          reserved[ar + r][ac + c] = 1;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) {
      grid[6][i] = i % 2 === 0 ? 1 : 0;
      reserved[6][i] = 1;
    }
    if (!reserved[i][6]) {
      grid[i][6] = i % 2 === 0 ? 1 : 0;
      reserved[i][6] = 1;
    }
  }

  for (let i = 0; i < 9; i++) {
    if (i < size) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  grid[size - 8][8] = 1;

  if (ver >= 7) {
    let vinfo = ver;
    for (let i = 0; i < 12; i++) vinfo = (vinfo << 1) ^ ((vinfo >>> 11) * 0x1f25);
    const vbits = (ver << 12) | vinfo;
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      grid[r][c] = bit;
      reserved[r][c] = 1;
      grid[c][r] = bit;
      reserved[c][r] = 1;
    }
  }

  let bitIdx = 0;
  const totalBits = finalCw.length * 8;
  let upward = true;
  for (let rawCol = size - 1; rawCol >= 1; rawCol -= 2) {
    const col = rawCol <= 6 ? rawCol - 1 : rawCol;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (finalCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        if ((r + c) % 2 === 0) bit ^= 1; // Mask 0
        grid[r][c] = bit;
      }
    }
    upward = !upward;
  }

  // Format info for ECC Level L (01) + Mask 0 (000) -> 0x77c4 (MSB bit 14 down to LSB bit 0)
  const fmtBits = 0x77c4;
  const fPos1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (fmtBits >>> (14 - i)) & 1;
    const [r1, c1] = fPos1[i];
    grid[r1][c1] = bit;
    if (i < 7) grid[size - 1 - i][8] = bit;
    else grid[8][size - 15 + i] = bit;
  }

  return grid;
}

window.renderTotpQrSvg = renderTotpQrSvg;
window.generateQrMatrix = generateQrMatrix;

