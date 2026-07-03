// Node smoke test for the spike — validates VTK parsing + cell index building
// without requiring a browser. Reuses the parser + inverse-trilinear from spike_b.html.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- inlined from spike_b.html (parser + inverse trilinear) ----
function parseVTK(text) {
  const lines = text.split('\n');
  let i = 0;
  const next = () => lines[i++];
  // Skip blank lines — VTK files often have blanks between sections
  const nextNonBlank = () => { let l; do { l = next(); } while (l !== undefined && l.trim() === ''); return l; };
  if (!next().startsWith('# vtk DataFile')) throw new Error('not a VTK file');
  nextNonBlank(); // title
  if (nextNonBlank().trim() !== 'ASCII') throw new Error('only ASCII VTK supported');
  if (!nextNonBlank().includes('UNSTRUCTURED_GRID')) throw new Error('expected UNSTRUCTURED_GRID');
  const nPoints = parseInt(nextNonBlank().split(/\s+/)[1]);
  const positions = new Float32Array(nPoints * 3);
  for (let p = 0; p < nPoints; p++) {
    const parts = next().trim().split(/\s+/).map(Number);
    positions[p*3] = parts[0]; positions[p*3+1] = parts[1]; positions[p*3+2] = parts[2];
  }
  const cellsLine = nextNonBlank().split(/\s+/);
  const nCells = parseInt(cellsLine[1]);
  const cellConn = new Uint32Array(nCells * 8);
  for (let c = 0; c < nCells; c++) {
    const parts = next().trim().split(/\s+/).map(Number);
    if (parts[0] !== 8) throw new Error(`cell ${c} not hex (nverts=${parts[0]})`);
    for (let k = 0; k < 8; k++) cellConn[c*8 + k] = parts[k+1];
  }
  const ctLine = nextNonBlank().split(/\s+/);
  for (let c = 0; c < parseInt(ctLine[1]); c++) {
    const t = parseInt(next().trim());
    if (t !== 12) throw new Error(`cell ${c} not VTK_HEXAHEDRON (type=${t})`);
  }
  if (!nextNonBlank().startsWith('POINT_DATA')) throw new Error('expected POINT_DATA');
  if (nextNonBlank().trim() !== 'SCALARS scalars float') throw new Error('expected SCALARS line');
  if (nextNonBlank().trim() !== 'LOOKUP_TABLE default') throw new Error('expected LOOKUP_TABLE');
  const scalars = new Float32Array(nPoints);
  for (let p = 0; p < nPoints; p++) scalars[p] = parseFloat(next().trim());
  return { positions, cellConn, scalars, nPoints, nCells };
}

function inverseTrilinear(C, p) {
  // Closed-form linear approximation at cell center. Exact for axis-aligned
  // cells; small error for highly twisted cells. Newton-Raphson is too slow
  // and oscillates near the center — this is fast and good enough for the spike.
  const c = (i, j, k) => [C[(i + 2*j + 4*k)*3], C[(i + 2*j + 4*k)*3 + 1], C[(i + 2*j + 4*k)*3 + 2]];
  const c000p = c(0,0,0), c100p = c(1,0,0), c010p = c(0,1,0), c110p = c(1,1,0);
  const c001p = c(0,0,1), c101p = c(1,0,1), c011p = c(0,1,1), c111p = c(1,1,1);
  // Centroid
  const cen = [
    0.125 * (c000p[0] + c100p[0] + c010p[0] + c110p[0] + c001p[0] + c101p[0] + c011p[0] + c111p[0]),
    0.125 * (c000p[1] + c100p[1] + c010p[1] + c110p[1] + c001p[1] + c101p[1] + c011p[1] + c111p[1]),
    0.125 * (c000p[2] + c100p[2] + c010p[2] + c110p[2] + c001p[2] + c101p[2] + c011p[2] + c111p[2]),
  ];
  // Basis vectors (∂P/∂u, ∂P/∂v, ∂P/∂w) at the cell center (u=v=w=0.5).
  // ∂P/∂u at center = 0.25 * (c100 + c110 + c101 + c111)
  // ∂P/∂v at center = 0.25 * (c010 + c110 + c011 + c111)
  // ∂P/∂w at center = 0.25 * (c001 + c101 + c011 + c111)
  const aU = [0.25 * (c100p[0] + c110p[0] + c101p[0] + c111p[0]),
             0.25 * (c100p[1] + c110p[1] + c101p[1] + c111p[1]),
             0.25 * (c100p[2] + c110p[2] + c101p[2] + c111p[2])];
  const aV = [0.25 * (c010p[0] + c110p[0] + c011p[0] + c111p[0]),
             0.25 * (c010p[1] + c110p[1] + c011p[1] + c111p[1]),
             0.25 * (c010p[2] + c110p[2] + c011p[2] + c111p[2])];
  const aW = [0.25 * (c001p[0] + c101p[0] + c011p[0] + c111p[0]),
             0.25 * (c001p[1] + c101p[1] + c011p[1] + c111p[1]),
             0.25 * (c001p[2] + c101p[2] + c011p[2] + c111p[2])];
  // Solve: aU*du + aV*dv + aW*dw = p - cen
  const b = [p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]];
  // Inverse 3x3 (Cramer)
  const det = aU[0]*(aV[1]*aW[2] - aV[2]*aW[1])
            - aU[1]*(aV[0]*aW[2] - aV[2]*aW[0])
            + aU[2]*(aV[0]*aW[1] - aV[1]*aW[0]);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const du =  invDet * (b[0]*(aV[1]*aW[2] - aV[2]*aW[1]) - b[1]*(aV[0]*aW[2] - aV[2]*aW[0]) + b[2]*(aV[0]*aW[1] - aV[1]*aW[0]));
  const dv = -invDet * (b[0]*(aU[1]*aW[2] - aU[2]*aW[1]) - b[1]*(aU[0]*aW[2] - aU[2]*aW[0]) + b[2]*(aU[0]*aW[1] - aU[1]*aW[0]));
  const dw =  invDet * (b[0]*(aU[1]*aV[2] - aU[2]*aV[1]) - b[1]*(aU[0]*aV[2] - aU[2]*aV[0]) + b[2]*(aU[0]*aV[1] - aU[1]*aV[0]));
  const u = 0.5 + du, v = 0.5 + dv, w = 0.5 + dw;
  if (u >= -1e-3 && u <= 1 + 1e-3 && v >= -1e-3 && v <= 1 + 1e-3 && w >= -1e-3 && w <= 1 + 1e-3) {
    return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v)), Math.max(0, Math.min(1, w))];
  }
  return null;
}

// ---- main ----
const txt = readFileSync(join(__dirname, 'candidates/hexa.vtk'), 'utf8');
const t0 = performance.now();
const mesh = parseVTK(txt);
console.log(`parse: ${mesh.nCells} cells, ${mesh.nPoints} points, ${(performance.now() - t0).toFixed(0)}ms`);

// Compute bbox
let minx=Infinity, miny=Infinity, minz=Infinity, maxx=-Infinity, maxy=-Infinity, maxz=-Infinity;
for (let p = 0; p < mesh.nPoints; p++) {
  const x = mesh.positions[p*3], y = mesh.positions[p*3+1], z = mesh.positions[p*3+2];
  if (x < minx) minx = x; if (x > maxx) maxx = x;
  if (y < miny) miny = y; if (y > maxy) maxy = y;
  if (z < minz) minz = z; if (z > maxz) maxz = z;
}
console.log(`bbox: [${minx.toFixed(3)},${miny.toFixed(3)},${minz.toFixed(3)}] – [${maxx.toFixed(3)},${maxy.toFixed(3)},${maxz.toFixed(3)}]`);

// Build cell AABBs
const t1 = performance.now();
const cellAABBmin = new Float32Array(mesh.nCells * 3);
const cellAABBmax = new Float32Array(mesh.nCells * 3);
for (let c = 0; c < mesh.nCells; c++) {
  let cminx=Infinity, cminy=Infinity, cminz=Infinity, cmaxx=-Infinity, cmaxy=-Infinity, cmaxz=-Infinity;
  for (let k = 0; k < 8; k++) {
    const pi = mesh.cellConn[c*8 + k];
    const x = mesh.positions[pi*3], y = mesh.positions[pi*3+1], z = mesh.positions[pi*3+2];
    if (x < cminx) cminx = x; if (x > cmaxx) cmaxx = x;
    if (y < cminy) cminy = y; if (y > cmaxy) cmaxy = y;
    if (z < cminz) cminz = z; if (z > cmaxz) cmaxz = z;
  }
  cellAABBmin[c*3]=cminx; cellAABBmin[c*3+1]=cminy; cellAABBmin[c*3+2]=cminz;
  cellAABBmax[c*3]=cmaxx; cellAABBmax[c*3+1]=cmaxy; cellAABBmax[c*3+2]=cmaxz;
}
console.log(`AABB: ${(performance.now() - t1).toFixed(0)}ms`);

// Coarse grid
const COARSE = 8;
const GRID = 32;
const csx = (maxx - minx) / COARSE, csy = (maxy - miny) / COARSE, csz = (maxz - minz) / COARSE;
const coarseCells = new Array(COARSE * COARSE * COARSE);
for (let i = 0; i < coarseCells.length; i++) coarseCells[i] = [];
for (let c = 0; c < mesh.nCells; c++) {
  const x0 = Math.max(0, Math.floor((cellAABBmin[c*3]   - minx) / csx));
  const y0 = Math.max(0, Math.floor((cellAABBmin[c*3+1] - miny) / csy));
  const z0 = Math.max(0, Math.floor((cellAABBmin[c*3+2] - minz) / csz));
  const x1 = Math.min(COARSE-1, Math.floor((cellAABBmax[c*3]   - minx) / csx));
  const y1 = Math.min(COARSE-1, Math.floor((cellAABBmax[c*3+1] - miny) / csy));
  const z1 = Math.min(COARSE-1, Math.floor((cellAABBmax[c*3+2] - minz) / csz));
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    coarseCells[z * COARSE * COARSE + y * COARSE + x].push(c);
  }
}
let totalCand = 0;
for (const list of coarseCells) totalCand += list.length;
console.log(`coarse grid: ${totalCand} total cell-tile refs (avg ${(totalCand / coarseCells.length).toFixed(1)}/tile)`);

// Fine voxel walk
const t2 = performance.now();
const data3D = new Uint32Array(GRID * GRID * GRID);
data3D.fill(0xFFFFFFFF);
const fsx = (maxx - minx) / GRID, fsy = (maxy - miny) / GRID, fsz = (maxz - minz) / GRID;
const tmpCorners = new Float32Array(24);
let hits = 0, miss = 0;
for (let z = 0; z < GRID; z++) {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const wx = minx + (x + 0.5) * fsx, wy = miny + (y + 0.5) * fsy, wz = minz + (z + 0.5) * fsz;
      const cx = Math.min(COARSE-1, Math.floor((wx - minx) / csx));
      const cy = Math.min(COARSE-1, Math.floor((wy - miny) / csy));
      const cz = Math.min(COARSE-1, Math.floor((wz - minz) / csz));
      const cands = coarseCells[cz * COARSE * COARSE + cy * COARSE + cx];
      let best = -1;
      if (x === 16 && y === 16 && z === 16) {
        console.log('voxel (16,16,16) world=', wx.toFixed(4), wy.toFixed(4), wz.toFixed(4), 'coarse tile=', cx, cy, cz, 'candidates:', cands.length);
        let aabbPass = 0, newtonPass = 0;
        for (let ii = 0; ii < cands.length; ii++) {
          const cc = cands[ii];
          const aabbOK = wx >= cellAABBmin[cc*3] && wx <= cellAABBmax[cc*3]
                      && wy >= cellAABBmin[cc*3+1] && wy <= cellAABBmax[cc*3+1]
                      && wz >= cellAABBmin[cc*3+2] && wz <= cellAABBmax[cc*3+2];
          if (aabbOK) {
            aabbPass++;
            const VTK_TO_STD = [0, 1, 3, 2, 4, 5, 7, 6];
            for (let k = 0; k < 8; k++) {
              const pi = mesh.cellConn[cc*8 + VTK_TO_STD[k]];
              tmpCorners[k*3]   = mesh.positions[pi*3];
              tmpCorners[k*3+1] = mesh.positions[pi*3+1];
              tmpCorners[k*3+2] = mesh.positions[pi*3+2];
            }
            const uvw = inverseTrilinear(tmpCorners, [wx, wy, wz]);
            if (uvw) newtonPass++;
            else console.log('  Newton FAIL cell', cc, 'AABB:', [cellAABBmin[cc*3].toFixed(3), cellAABBmin[cc*3+1].toFixed(3), cellAABBmin[cc*3+2].toFixed(3)], '–', [cellAABBmax[cc*3].toFixed(3), cellAABBmax[cc*3+1].toFixed(3), cellAABBmax[cc*3+2].toFixed(3)]);
          }
        }
        console.log('  AABB pass:', aabbPass, 'Newton pass:', newtonPass);
      }
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (wx < cellAABBmin[c*3] || wx > cellAABBmax[c*3]) continue;
        if (wy < cellAABBmin[c*3+1] || wy > cellAABBmax[c*3+1]) continue;
        if (wz < cellAABBmin[c*3+2] || wz > cellAABBmax[c*3+2]) continue;
        // VTK_HEXAHEDRON vertex order: c000, c100, c110, c010, c001, c101, c111, c011
        // inverseTrilinear expects:                       c000, c100, c010, c110, c001, c101, c011, c111
        // remap on read so tmpCorners is in the expected order
        const VTK_TO_STD = [0, 1, 3, 2, 4, 5, 7, 6];
        for (let k = 0; k < 8; k++) {
          const pi = mesh.cellConn[c*8 + VTK_TO_STD[k]];
          tmpCorners[k*3]   = mesh.positions[pi*3];
          tmpCorners[k*3+1] = mesh.positions[pi*3+1];
          tmpCorners[k*3+2] = mesh.positions[pi*3+2];
        }
        const uvw = inverseTrilinear(tmpCorners, [wx, wy, wz]);
        if (uvw) { best = c; break; }
      }
      if (best >= 0) { data3D[z * GRID * GRID + y * GRID + x] = best; hits++; }
      else miss++;
    }
  }
}
console.log(`voxel walk: ${(performance.now() - t2).toFixed(0)}ms, hits=${hits} miss=${miss} (${(100*hits/(GRID**3)).toFixed(1)}% coverage)`);

// Sanity: pick a few voxels and verify
console.log('\nspot checks:');
// Direct test of inverseTrilinear on cell 5577 with point (0.493, 0.493, 0.493)
{
  const c = 5577;
  const VTK_TO_STD = [0, 1, 3, 2, 4, 5, 7, 6];
  const C = new Float32Array(24);
  for (let k = 0; k < 8; k++) {
    const pi = mesh.cellConn[c*8 + VTK_TO_STD[k]];
    C[k*3] = mesh.positions[pi*3]; C[k*3+1] = mesh.positions[pi*3+1]; C[k*3+2] = mesh.positions[pi*3+2];
  }
  console.log('cell 5577 corners (in std order c000,c100,c010,c110,c001,c101,c011,c111):');
  for (let k = 0; k < 8; k++) console.log('  k=' + k, ':', [C[k*3], C[k*3+1], C[k*3+2]]);
  const p = [0.493, 0.493, 0.493];
  const uvw = inverseTrilinear(C, p);
  console.log('inverseTrilinear at (0.493, 0.493, 0.493) for cell 5577:', uvw);
}
for (const [x, y, z, label] of [[16,16,16,'center'], [0,0,0,'corner'], [1,0,0,'+x'], [0,1,0,'+y'], [0,0,1,'+z'], [1,1,0,'+xy'], [2,2,2,'mid'], [31,31,31,'far corner'], [10,5,20,'random']]) {
  const c = data3D[z * GRID * GRID + y * GRID + x];
  if (c === 0xFFFFFFFF) console.log(`  ${label} (${x},${y},${z}): OUTSIDE`);
  else {
    let s = 0;
    for (let k = 0; k < 8; k++) s += mesh.scalars[mesh.cellConn[c*8 + k]];
    console.log(`  ${label} (${x},${y},${z}): cell=${c}, avg_scalar=${(s/8).toFixed(2)}`);
  }
}
