// verify_fron_order.mjs v3 — settle the canvas2D FRONT view interpretation.
// Uses PROPER structured (i, j, k) decomposition from cellIdx (nx=24, ny=25, nz=15)
// and asks: at each (j, k) FRONT-view pixel, which (i, j, k) cell does the canvas
// actually show? Hypothesis: highest-i cell at that (j, k) column (draw-order artifact).
//
// Pure Node — does NOT touch index.html.
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
console.log(`parsed: ${m.nCells} cells, ${m.nPoints} points`);

// Structured dims: 24 × 25 × 15 = 9000
const NX = 24, NY = 25, NZ = 15;
const NYZ = NY * NZ;     // 375
const NXYZ = NX * NYZ;  // 9000
console.log(`structured dims: nx=${NX} ny=${NY} nz=${NZ}  (nxyz=${NXYZ})`);

// Storage: cellIdx = k + j*nz + i*nz*ny   (k fastest, then j, then i)
function decompose(cellIdx) {
  const i = Math.floor(cellIdx / NYZ);
  const j = Math.floor((cellIdx % NYZ) / NZ);
  const k = cellIdx % NZ;
  return [i, j, k];
}

// Per-cell mean of 8 corner scalars (mirrors canvas2D code)
const cellMean = new Float32Array(m.nCells);
for (let c = 0; c < m.nCells; c++) {
  let s = 0;
  for (let k = 0; k < 8; k++) s += m.scalars[m.cellConn[c*8 + k]];
  cellMean[c] = s / 8;
}

// For each (j, k) bin, find the cell with the highest cellIdx (= highest i)
const bins = new Map();
for (let c = 0; c < m.nCells; c++) {
  const [i, j, k] = decompose(c);
  const key = j + ',' + k;
  const cur = bins.get(key);
  if (!cur || c > cur.cellIdx) bins.set(key, { cellIdx: c, i, j, k, scalar: cellMean[c] });
}

// Compute also: for each (j, k), what cells EXIST in this column, and what's
// the max cell count? This tells us about ACTNUM holes.
const binMembers = new Map();
for (let c = 0; c < m.nCells; c++) {
  const [i, j, k] = decompose(c);
  const key = j + ',' + k;
  const arr = binMembers.get(key);
  if (arr) arr.push(c); else binMembers.set(key, [c]);
}

// Distribution of "winning cell i" — should be heavily clustered near 23
let iHist = new Int32Array(NX);
let iHistMissing = 0;
const missingBins = [];
for (const [key, b] of bins) {
  if (b.i < 0 || b.i >= NX) iHistMissing++;
  else iHist[b.i]++;
  if (b.cellIdx < NX * NYZ - 25 && b.i < NX - 1) missingBins.push({ ...b, totalInBin: (binMembers.get(key) || []).length });
}
console.log('\ni distribution of "winning cell" at each (j, k) FRONT pixel:');
for (let i = 0; i < NX; i++) {
  const bar = '█'.repeat(iHist[i]);
  console.log(`  i=${String(i).padStart(2)}: ${String(iHist[i]).padStart(4)} bins ${bar}`);
}
console.log(`missing bins (i out of range): ${iHistMissing}`);

// The FRONT view visible color at (j, k) — show as ASCII map of i and scalar
const COLS = NY, ROWS = NZ;
// glyph by i (column index of winning cell)
function iglyph(i) {
  if (i < 0) return ' ';
  if (i < 6)  return String(i);
  if (i < 12) return String.fromCharCode('a'.charCodeAt(0) + (i - 6));
  if (i < 18) return String.fromCharCode('A'.charCodeAt(0) + (i - 12));
  return String.fromCharCode('!'.charCodeAt(0) + (i - 18));  // ! " # $ % & (for 18..23)
}
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
const scalarGrid = Array.from({ length: ROWS }, () => new Float32Array(COLS));
const iGrid = Array.from({ length: ROWS }, () => new Array(COLS).fill(-1));
for (const [key, b] of bins) {
  grid[b.k][b.j] = iglyph(b.i);
  scalarGrid[b.k][b.j] = b.scalar;
  iGrid[b.k][b.j] = b.i;
}
console.log(`\nFRONT view prediction (canvas2D draw order). SYMBOL = i of winning cell, j=${COLS} cols:`);
console.log('  0-9: i=0..9, a-f: i=6..11 (overlap means a=6,b=7,…), A-F: i=12..17, !"$#&(% : i=18..23');
console.log('\n       j:  ' + Array.from({length: COLS}, (_, j) => j % 10).join(''));
for (let k = 0; k < ROWS; k++) {
  console.log(`  k=${String(k).padStart(2)}:    ${grid[k].join('')}  | scalar mean row: ${(scalarGrid[k].reduce((s,_,i)=>s+scalarGrid[k][i],0)/COLS).toFixed(3)}`);
}

// Sample some wins and verify they ARE the max-cellIdx in their (j,k) bin
console.log('\nSample verification: top cellIdx per (j,k) bin must equal max cellIdx in bin:');
let verified = 0, mismatched = 0;
for (const [key, b] of bins) {
  const arr = binMembers.get(key);
  const maxIdx = arr[arr.length - 1];
  if (maxIdx !== b.cellIdx) {
    mismatched++;
    if (mismatched < 5) console.log(`  MISMATCH ${key}: claimed top=${b.cellIdx}, actual max=${maxIdx}`);
  } else verified++;
}
console.log(`  total bins: ${bins.size}, verified: ${verified}, mismatched: ${mismatched}`);

// Critical check: "FRONT shows per-k variation of highest-i cell" = stripes pattern.
// If this is true, then per-row scalar stddev across j should be SMALL
// (because all j bins at same k show essentially the same i=highest cell family,
// and their PORO is determined by (i=last, j, k) cell).
// In contrast, real reservoir variation across (j, k) would show big spread.
console.log('\nPer-k row statistics of FRONT visible scalar (across j):');
for (let k = 0; k < ROWS; k++) {
  const vals = [];
  for (let j = 0; j < COLS; j++) if (scalarGrid[k][j] > 0) vals.push(scalarGrid[k][j]);
  if (vals.length === 0) continue;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const mean = vals.reduce((a,b)=>a+b, 0)/vals.length;
  const variance = vals.reduce((a,b)=>a+(b-mean)**2, 0)/vals.length;
  const stddev = Math.sqrt(variance);
  console.log(`  k=${String(k).padStart(2)}: n=${String(vals.length).padStart(2)} mean=${mean.toFixed(3)} stddev=${stddev.toFixed(3)} range=[${mn.toFixed(3)},${mx.toFixed(3)}]`);
}

console.log('\n>>> CONCLUSION:');
const winning_i_avg = (() => { let s = 0; for (const [, b] of bins) s += b.i; return s / bins.size; })();
console.log(`  Average "winning i" across all (j,k) bins: ${winning_i_avg.toFixed(1)} / ${NX-1}`);
console.log(`  If avg is close to ${NX-1}, every FRONT pixel shows the highest-i cell at that column`);
console.log(`  → FRONT view stripes are the per-k PORO of the (i=NX-1) COLUMN`);
console.log(`  → they are a draw-order artifact, NOT real reservoir layer structure`);
