// render_fron.mjs — pixel-accurate simulation of canvas2D FRONT view, no browser.
// Identical algorithm to renderCanvas2DFallback(...) in index.html, line ~245:
//   - ax=1 (y), bx=2 (z)
//   - convex: false
//   - per-cell AABB rect in (y, z) plane
//   - painter: cells.map((_, i) => i) = storage order
//   - last cell to paint a (y_pix, z_pix) wins; with 24×25×15 grid and
//     storage order = (i=j*15 + k) + i*375, the LAST cell to paint each
//     (y_pix, z_pix) pixel is the highest-i cell at that (j, k) column.
//
// Verifies whether my earlier conclusion ("FRONT view shows uniform color
// 0.153 ± 0.005") is correct — or whether the painter actually produces
// visible variation I missed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const VTK = join(__dirname, 'candidates/spe9.vtk');

function parseVTK(text) {
  const lines = text.split('\n');
  let i = 0;
  const next = () => lines[i++];
  const nextNonBlank = () => { let l; do l = next(); while (l !== undefined && l.trim() === ''); return l; };
  if (!next().startsWith('# vtk DataFile')) throw new Error('not VTK');
  nextNonBlank();
  if (nextNonBlank().trim() !== 'ASCII') throw new Error('not ASCII');
  if (!nextNonBlank().includes('UNSTRUCTURED_GRID')) throw new Error('not UNSTRUCTURED_GRID');
  const nPoints = parseInt(nextNonBlank().split(/\s+/)[1]);
  const positions = new Float32Array(nPoints * 3);
  for (let p = 0; p < nPoints; p++) {
    const parts = next().trim().split(/\s+/).map(Number);
    positions[p*3]=parts[0]; positions[p*3+1]=parts[1]; positions[p*3+2]=parts[2];
  }
  const nCells = parseInt(nextNonBlank().split(/\s+/)[1]);
  const cellConn = new Uint32Array(nCells * 8);
  for (let c = 0; c < nCells; c++) {
    const parts = next().trim().split(/\s+/).map(Number);
    if (parts[0] !== 8) throw new Error(`cell ${c} not hex`);
    for (let k = 0; k < 8; k++) cellConn[c*8 + k] = parts[k+1];
  }
  let peek = nextNonBlank();
  if (peek.startsWith('CELL_TYPES')) {
    const nct = parseInt(peek.split(/\s+/)[1]);
    for (let c = 0; c < nct; c++) next();
    peek = nextNonBlank();
  }
  if (!peek.startsWith('POINT_DATA')) throw new Error('expected POINT_DATA');
  if (nextNonBlank().trim() !== 'SCALARS scalars float') throw new Error('expected SCALARS');
  if (nextNonBlank().trim() !== 'LOOKUP_TABLE default') throw new Error('expected LOOKUP_TABLE');
  const scalars = new Float32Array(nPoints);
  for (let p = 0; p < nPoints; p++) scalars[p] = parseFloat(next().trim());
  return { positions, cellConn, scalars, nPoints, nCells };
}

const m = parseVTK(readFileSync(VTK, 'utf8'));

// Per-cell info matching canvas2D
const cells = new Array(m.nCells);
for (let c = 0; c < m.nCells; c++) {
  const corners = new Array(8);
  let s = 0;
  for (let k = 0; k < 8; k++) {
    const pi = m.cellConn[c*8+k];
    corners[k] = [m.positions[pi*3], m.positions[pi*3+1], m.positions[pi*3+2]];
    s += m.scalars[pi];
  }
  cells[c] = { corners, s: s / 8 };
}

const NX = 24, NY = 25, NZ = 15;

// FRONT (ax=1=y, bx=2=z), convex=false → draw AABB rect, last cell wins.
// Same global bbox and scale as canvas2D code
let bMin1 = Infinity, bMax1 = -Infinity, bMin2 = Infinity, bMax2 = -Infinity;
for (const cell of cells) for (const c of cell.corners) {
  if (c[1] < bMin1) bMin1 = c[1]; if (c[1] > bMax1) bMax1 = c[1];
  if (c[2] < bMin2) bMin2 = c[2]; if (c[2] > bMax2) bMax2 = c[2];
}

// Use V=540 like canvas2D, with PAD=30 and V+60 panel offset
const V = 540;
const sA = V / Math.max(bMax1 - bMin1, 1e-9);   // y → canvas Y axis
const sB = V / Math.max(bMax2 - bMin2, 1e-9);   // z → canvas Y axis (flipped)

// Render at lower res for ASCII output (60x40 instead of 540x540)
const RW = 60, RH = 40;
const canvas = new Array(RW * RH).fill(null);

// Painter: iterate cells in storage order; for each, paint its AABB rect
for (let c = 0; c < m.nCells; c++) {
  const cell = cells[c];
  let mnA = Infinity, mxA = -Infinity, mnB = Infinity, mxB = -Infinity;
  for (const p of cell.corners) {
    if (p[1] < mnA) mnA = p[1]; if (p[1] > mxA) mxA = p[1];
    if (p[2] < mnB) mnB = p[2]; if (p[2] > mxB) mxB = p[2];
  }
  // Map (mnA, mxA) → pixel range (y axis: pad..pad+V, V flipped)
  // canvas2D code uses: ox + (mnA - minA) * sA, width = (mxA-mnA) * sA
  // and for row axis (z): oy + V - (mxB - minB) * sB, height = (mxB-mnB) * sB
  // So canvas Y pixel = V - (z - minB) * sB  →  higher z = lower pixel y
  // For ASCII we use top-down: row=0 is high z (top), row=RH-1 is low z (bottom)
  const pixLeft   = Math.floor((mnA - bMin1) * sA / V * RW);
  const pixRight  = Math.ceil((mxA - bMin1) * sA / V * RW);
  const pixTop    = Math.floor((1 - (mxB - bMin2) / (bMax2 - bMin2)) * RH);
  const pixBottom = Math.ceil((1 - (mnB - bMin2) / (bMax2 - bMin2)) * RH);
  for (let py = pixTop; py < pixBottom; py++) {
    for (let px = pixLeft; px < pixRight; px++) {
      if (py < 0 || py >= RH || px < 0 || px >= RW) continue;
      canvas[py * RW + px] = { c, s: cell.s };
    }
  }
}

// Render visible cells per pixel as ASCII
console.log(`FRONT view simulation (canvas2D, painter=storage-order): ${RW} cols × ${RH} rows`);
console.log(`  bMin1(y)=${bMin1.toFixed(0)} bMax1(y)=${bMax1.toFixed(0)} (range ${(bMax1-bMin1).toFixed(0)})`);
console.log(`  bMin2(z)=${bMin2.toFixed(0)} bMax2(z)=${bMax2.toFixed(0)} (range ${(bMax2-bMin2).toFixed(0)})`);
console.log(`  cols=j-axis (reservoir y), rows=z-axis (reservoir k; top→bottom)`);
console.log('');

// Glyph by scalar (matches viridis-ish palette bins)
const glyph = (s) => {
  if (s == null) return ' ';
  if (s < 0.105) return ' ';
  if (s < 0.125) return '.';
  if (s < 0.140) return '·';
  if (s < 0.155) return 'o';
  if (s < 0.165) return 'O';
  return '#';
};
// header: column index = canvas x (which is j)
let headerRow = '       ';
for (let x = 0; x < RW; x++) headerRow += (x % 10 === 0 ? '|' : ' ');
console.log(headerRow);
let emptyRowCount = 0;
for (let y = 0; y < RH; y++) {
  let line = '';
  let emptyLine = true;
  for (let x = 0; x < RW; x++) {
    const cell = canvas[y * RW + x];
    line += glyph(cell ? cell.s : null);
    if (cell) emptyLine = false;
  }
  if (emptyLine) { emptyRowCount++; console.log(`  r=${String(y).padStart(2)}: ${line}  (empty)`); }
  else console.log(`  r=${String(y).padStart(2)}: ${line}`);
}
console.log(`\nempty rows (no cell covers): ${emptyRowCount}`);

// Per-row scalar distribution (across j)
console.log('\nPer-row statistics of FRONT visible scalar:');
for (let y = 0; y < RH; y++) {
  const vals = [];
  for (let x = 0; x < RW; x++) {
    const cell = canvas[y * RW + x];
    if (cell) vals.push(cell.s);
  }
  if (vals.length === 0) continue;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const mean = vals.reduce((a,b)=>a+b, 0) / vals.length;
  const stddev = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0) / vals.length);
  console.log(`  r=${String(y).padStart(2)}: n=${String(vals.length).padStart(3)} mean=${mean.toFixed(3)} stddev=${stddev.toFixed(4)} range=[${mn.toFixed(3)}, ${mx.toFixed(3)}]`);
}

// Also dump which cells are visible at each row
console.log('\nWinning cells per row (winning cellIdx set):');
for (let y = 0; y < RH; y++) {
  const cellIdxs = new Set();
  for (let x = 0; x < RW; x++) {
    const cell = canvas[y * RW + x];
    if (cell) cellIdxs.add(cell.c);
  }
  if (cellIdxs.size === 0) continue;
  const idxArr = [...cellIdxs];
  console.log(`  r=${String(y).padStart(2)}: distinct visible cells: ${idxArr.length}, ids: ${idxArr.slice(0, 5).join(',')}${idxArr.length > 5 ? ', ...' : ''}`);
}
