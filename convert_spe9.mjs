// GRDECL (Corner-Point Geometry) → VTK converter for SPE-9.
//   Usage: node convert_spe9.mjs <in.GRDECL> <in.DATA> <out.vtk>
import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.length !== 5) {
  console.error('usage: node convert_spe9.mjs <in.GRDECL> <in.DATA> <out.vtk>');
  process.exit(1);
}
const [, , IN_GRDECL, IN_DATA, OUT_VTK] = process.argv;

// ---- Parse a GRDECL/DATA-style file into {keyword: flatNumberArray}
function readDeck(path) {
  const txt = readFileSync(path, 'utf8');
  const lines = txt.split('\n');
  let i = 0;
  const nxt = () => lines[i++];
  const out = {};
  while (i < lines.length) {
    while (i < lines.length) {
      const l = lines[i].trim();
      if (l === '' || l.startsWith('--')) { i++; continue; }
      break;
    }
    if (i >= lines.length) break;
    const kw = nxt().trim();
    if (!kw) continue;
    const vals = [];
    while (i < lines.length) {
      const l = nxt();
      if (l === undefined) break;
      const trimmed = l.trim();
      if (trimmed === '' || trimmed.startsWith('--')) continue;
      for (const t of trimmed.split(/\s+/)) {
        if (t === '/') break;
        const m = t.match(/^(\d+)\*(.+)$/);
        if (m) {
          const n = parseInt(m[1]);
          const v = parseFloat(m[2]);
          for (let k = 0; k < n; k++) vals.push(v);
        } else {
          const v = parseFloat(t);
          if (!isNaN(v)) vals.push(v);
        }
      }
      if (trimmed.endsWith('/')) break;
    }
    out[kw] = vals;
  }
  return out;
}

const deck = readDeck(IN_GRDECL);
const dataDeck = readDeck(IN_DATA);
for (const k of Object.keys(dataDeck)) if (!deck[k]) deck[k] = dataDeck[k];

const [nx, ny, nz] = deck.SPECGRID;
const nCells = nx * ny * nz;
console.error(`SPECGRID: ${nx} x ${ny} x ${nz} = ${nCells} cells`);

if (!deck.PORO) deck.PORO = new Array(nCells).fill(0.1);
if (!deck.ACTNUM) deck.ACTNUM = new Array(nCells).fill(1);

const activeIdx = [];
for (let k = 0; k < nCells; k++) if (deck.ACTNUM[k]) activeIdx.push(k);
const nActive = activeIdx.length;
console.error(`active cells: ${nActive} of ${nCells}`);

// Build points (deduped by grid index) and cell connectivity
const pointKey = (i, j, k) => `${i},${j},${k}`;
const pointIndex = new Map();
const points = [];  // flat [x, y, z, ...]
const cells = new Int32Array(nActive * 8);

function addPoint(i, j, k, x, y, z) {
  const key = pointKey(i, j, k);
  let idx = pointIndex.get(key);
  if (idx === undefined) {
    idx = points.length / 3;
    points.push(x, y, z);
    pointIndex.set(key, idx);
  }
  return idx;
}

let cellOut = 0;
for (const cellIdx of activeIdx) {
  const k = cellIdx % nz;
  const j = Math.floor(cellIdx / nz) % ny;
  const i = Math.floor(cellIdx / (nz * ny));

  // 4 pillars around the cell at grid corners (i+0/1, j+0/1).
  // Pillars[py][px] = { top: [x,y,z], bot: [x,y,z] }
  const P = [];
  for (let py = 0; py < 2; py++) {
    const row = [];
    for (let px = 0; px < 2; px++) {
      const pi = (j + py) * (nx + 1) + (i + px);
      row.push({
        top: [deck.COORD[6*pi + 0], deck.COORD[6*pi + 1], deck.COORD[6*pi + 2]],
        bot: [deck.COORD[6*pi + 3], deck.COORD[6*pi + 4], deck.COORD[6*pi + 5]],
      });
    }
    P.push(row);
  }

  // 8 ZCORN depths for this cell (standard OPM/Eclipse layout):
  //   corner index c encodes (kx, ky, kz) = (c&1, (c>>1)&1, (c>>2)&1)
  //   where kx is i-direction, ky is j-direction, kz is k-direction.
  // ZCORN stores DEPTHS (positive = down). We negate for Y-up.
  for (let c = 0; c < 8; c++) {
    const kx = c & 1;
    const ky = (c >> 1) & 1;
    const kz = (c >> 2) & 1;

    // Bilinear blend of pillar x/y at the kz layer (top layer when kz=0, bot layer when kz=1)
    const p00 = P[ky    ][kx    ];
    const p10 = P[ky    ][kx ^ 1];
    const p01 = P[ky ^ 1][kx    ];
    const p11 = P[ky ^ 1][kx ^ 1];
    const layer = kz === 0
      ? [p00.top, p10.top, p01.top, p11.top]
      : [p00.bot, p10.bot, p01.bot, p11.bot];
    // Bilinear weights: kx, ky ∈ {0, 1}
    const wx0 = 1 - kx, wx1 = kx;
    const wy0 = 1 - ky, wy1 = ky;
    const x = wx0 * wy0 * layer[0][0] + wx1 * wy0 * layer[1][0]
            + wx0 * wy1 * layer[2][0] + wx1 * wy1 * layer[3][0];
    const y = wx0 * wy0 * layer[0][1] + wx1 * wy0 * layer[1][1]
            + wx0 * wy1 * layer[2][1] + wx1 * wy1 * layer[3][1];
    // z: depth from ZCORN, negated for Y-up
    const z = -deck.ZCORN[8 * cellIdx + c];

    const idx = addPoint(i + kx, j + ky, k + kz, x, y, z);
    cells[cellOut * 8 + c] = idx;
  }
  cellOut++;
}

console.error(`points (deduped): ${points.length / 3}`);

// Per-point porosity = average of cells that share the point
const nPoints = points.length / 3;
const pointScalar = new Float32Array(nPoints);
const pointCount = new Int32Array(nPoints);
for (let a = 0; a < nActive; a++) {
  const cellIdx = activeIdx[a];
  const poro = deck.PORO[cellIdx] || 0;
  for (let c = 0; c < 8; c++) {
    const p = cells[a * 8 + c];
    pointScalar[p] += poro;
    pointCount[p] += 1;
  }
}
for (let i = 0; i < nPoints; i++) {
  if (pointCount[i] > 0) pointScalar[i] /= pointCount[i];
}

const lines = [
  '# vtk DataFile Version 1.0',
  'GRDECL reservoir (SPE-9) → VTK',
  'ASCII',
  '',
  'DATASET UNSTRUCTURED_GRID',
  `POINTS ${nPoints} float`,
];
for (let i = 0; i < nPoints; i++) {
  lines.push(`${points[3*i].toFixed(4)} ${points[3*i+1].toFixed(4)} ${points[3*i+2].toFixed(4)}`);
}
lines.push('', `CELLS ${nActive} ${nActive * 9}`);
for (let c = 0; c < nActive; c++) {
  const a = cells[c*8], b = cells[c*8+1], cc = cells[c*8+2], d = cells[c*8+3];
  const e = cells[c*8+4], f = cells[c*8+5], g = cells[c*8+6], h = cells[c*8+7];
  lines.push(`8 ${a} ${b} ${cc} ${d} ${e} ${f} ${g} ${h}`);
}
lines.push('', `CELL_TYPES ${nActive}`);
for (let c = 0; c < nActive; c++) lines.push('12');
lines.push('', `POINT_DATA ${nPoints}`, 'SCALARS porosity float', 'LOOKUP_TABLE default');
for (let i = 0; i < nPoints; i++) lines.push(pointScalar[i].toFixed(6));

writeFileSync(OUT_VTK, lines.join('\n') + '\n');
console.error(`wrote ${OUT_VTK}: ${nPoints} pts, ${nActive} cells, ${pointScalar.length} scalars`);

const pmin = Math.min(...pointScalar);
const pmax = Math.max(...pointScalar);
const pmean = pointScalar.reduce((a, b) => a + b, 0) / pointScalar.length;
console.error(`  porosity: min=${pmin.toFixed(3)} mean=${pmean.toFixed(3)} max=${pmax.toFixed(3)}`);
