// coverage_check.mjs — measure cellIndex texture coverage on SPE-9 vs hexa.
// Runs the same logic as index.html's async build, synchronously, and reports
// per-cell failure rates so we know if 22% coverage is a build bug or expected.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function inverseTrilinear(C, p) {
  const c = (i, j, k) => [C[(i + 2*j + 4*k)*3], C[(i + 2*j + 4*k)*3 + 1], C[(i + 2*j + 4*k)*3 + 2]];
  const c000p=c(0,0,0), c100p=c(1,0,0), c010p=c(0,1,0), c110p=c(1,1,0);
  const c001p=c(0,0,1), c101p=c(1,0,1), c011p=c(0,1,1), c111p=c(1,1,1);
  const cen = [0.125*(c000p[0]+c100p[0]+c010p[0]+c110p[0]+c001p[0]+c101p[0]+c011p[0]+c111p[0]),
               0.125*(c000p[1]+c100p[1]+c010p[1]+c110p[1]+c001p[1]+c101p[1]+c011p[1]+c111p[1]),
               0.125*(c000p[2]+c100p[2]+c010p[2]+c110p[2]+c001p[2]+c101p[2]+c011p[2]+c111p[2])];
  const aU = [0.25*(c100p[0]+c110p[0]+c101p[0]+c111p[0]),
             0.25*(c100p[1]+c110p[1]+c101p[1]+c111p[1]),
             0.25*(c100p[2]+c110p[2]+c101p[2]+c111p[2])];
  const aV = [0.25*(c010p[0]+c110p[0]+c011p[0]+c111p[0]),
             0.25*(c010p[1]+c110p[1]+c011p[1]+c111p[1]),
             0.25*(c010p[2]+c110p[2]+c011p[2]+c111p[2])];
  const aW = [0.25*(c001p[0]+c101p[0]+c011p[0]+c111p[0]),
             0.25*(c001p[1]+c101p[1]+c011p[1]+c111p[1]),
             0.25*(c001p[2]+c101p[2]+c011p[2]+c111p[2])];
  const b = [p[0]-cen[0], p[1]-cen[1], p[2]-cen[2]];
  const det = aU[0]*(aV[1]*aW[2]-aV[2]*aW[1]) - aU[1]*(aV[0]*aW[2]-aV[2]*aW[0]) + aU[2]*(aV[0]*aW[1]-aV[1]*aW[0]);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1/det;
  const du =  invDet*(b[0]*(aV[1]*aW[2]-aV[2]*aW[1]) - b[1]*(aV[0]*aW[2]-aV[2]*aW[0]) + b[2]*(aV[0]*aW[1]-aV[1]*aW[0]));
  const dv = -invDet*(b[0]*(aU[1]*aW[2]-aU[2]*aW[1]) - b[1]*(aU[0]*aW[2]-aU[2]*aW[0]) + b[2]*(aU[0]*aW[1]-aU[1]*aW[0]));
  const dw =  invDet*(b[0]*(aU[1]*aV[2]-aU[2]*aV[1]) - b[1]*(aU[0]*aV[2]-aU[2]*aV[0]) + b[2]*(aU[0]*aV[1]-aU[1]*aV[0]));
  const u = 0.5+du, v=0.5+dv, w=0.5+dw;
  if (u>=-1e-3 && u<=1+1e-3 && v>=-1e-3 && v<=1+1e-3 && w>=-1e-3 && w<=1+1e-3) {
    return [Math.max(0,Math.min(1,u)), Math.max(0,Math.min(1,v)), Math.max(0,Math.min(1,w))];
  }
  return null;
}

function checkCoverage(vtkPath, label) {
  const m = parseVTK(readFileSync(vtkPath, 'utf8'));
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  for (let p = 0; p < m.nPoints; p++) {
    const x=m.positions[p*3],y=m.positions[p*3+1],z=m.positions[p*3+2];
    if (x<minx)minx=x; if (x>maxx)maxx=x;
    if (y<miny)miny=y; if (y>maxy)maxy=y;
    if (z<minz)minz=z; if (z>maxz)maxz=z;
  }
  console.log(`\n=== ${label} (${m.nCells} cells) ===`);
  console.log(`bbox: [${minx.toFixed(2)}, ${miny.toFixed(2)}, ${minz.toFixed(2)}] – [${maxx.toFixed(2)}, ${maxy.toFixed(2)}, ${maxz.toFixed(2)}]`);
  console.log(`bbox size: ${(maxx-minx).toFixed(0)} × ${(maxy-miny).toFixed(0)} × ${(maxz-minz).toFixed(0)}`);

  // AABB per cell
  const cellAABBmin = new Float32Array(m.nCells * 3);
  const cellAABBmax = new Float32Array(m.nCells * 3);
  for (let c = 0; c < m.nCells; c++) {
    let mnX=Infinity,mnY=Infinity,mnZ=Infinity,mxX=-Infinity,mxY=-Infinity,mxZ=-Infinity;
    for (let k = 0; k < 8; k++) {
      const pi = m.cellConn[c*8+k];
      const x=m.positions[pi*3],y=m.positions[pi*3+1],z=m.positions[pi*3+2];
      if (x<mnX)mnX=x;if(y<mnY)mnY=y;if(z<mnZ)mnZ=z;
      if (x>mxX)mxX=x;if(y>mxY)mxY=y;if(z>mxZ)mxZ=z;
    }
    cellAABBmin[c*3]=mnX; cellAABBmin[c*3+1]=mnY; cellAABBmin[c*3+2]=mnZ;
    cellAABBmax[c*3]=mxX; cellAABBmax[c*3+1]=mxY; cellAABBmax[c*3+2]=mxZ;
  }
  // Sum cell AABB volume vs bbox volume
  let cellVolTotal = 0;
  for (let c = 0; c < m.nCells; c++) {
    const dx = cellAABBmax[c*3]-cellAABBmin[c*3];
    const dy = cellAABBmax[c*3+1]-cellAABBmin[c*3+1];
    const dz = cellAABBmax[c*3+2]-cellAABBmin[c*3+2];
    cellVolTotal += dx*dy*dz;
  }
  const bboxVol = (maxx-minx)*(maxy-miny)*(maxz-minz);
  console.log(`AABB sum: ${cellVolTotal.toExponential(3)} ft³  bbox: ${bboxVol.toExponential(3)} ft³  ratio: ${(cellVolTotal/bboxVol*100).toFixed(1)}%`);

  // 64³ voxel walk (matches index.html)
  const GRID = 64, COARSE = 8;
  const sx = (maxx-minx)/COARSE, sy=(maxy-miny)/COARSE, sz=(maxz-minz)/COARSE;
  const coarseCells = new Array(COARSE**3);
  for (let i = 0; i < coarseCells.length; i++) coarseCells[i] = [];
  for (let c = 0; c < m.nCells; c++) {
    const x0 = Math.max(0, Math.floor((cellAABBmin[c*3]-minx)/sx));
    const y0 = Math.max(0, Math.floor((cellAABBmin[c*3+1]-miny)/sy));
    const z0 = Math.max(0, Math.floor((cellAABBmin[c*3+2]-minz)/sz));
    const x1 = Math.min(COARSE-1, Math.floor((cellAABBmax[c*3]-minx)/sx));
    const y1 = Math.min(COARSE-1, Math.floor((cellAABBmax[c*3+1]-miny)/sy));
    const z1 = Math.min(COARSE-1, Math.floor((cellAABBmax[c*3+2]-minz)/sz));
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      coarseCells[z*COARSE*COARSE+y*COARSE+x].push(c);
    }
  }
  const fsx=(maxx-minx)/GRID, fsy=(maxy-miny)/GRID, fsz=(maxz-minz)/GRID;
  const tmpCorners = new Float32Array(24);
  let hits=0, miss=0, aabbFailButHit=0, newtonFailButHit=0;
  for (let z = 0; z < GRID; z++) for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    const wx=minx+(x+0.5)*fsx, wy=miny+(y+0.5)*fsy, wz=minz+(z+0.5)*fsz;
    const cx=Math.min(COARSE-1,Math.floor((wx-minx)/sx));
    const cy=Math.min(COARSE-1,Math.floor((wy-miny)/sy));
    const cz=Math.min(COARSE-1,Math.floor((wz-minz)/sz));
    const cands = coarseCells[cz*COARSE*COARSE+cy*COARSE+cx];
    let best = -1;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (wx < cellAABBmin[c*3] || wx > cellAABBmax[c*3]) continue;
      if (wy < cellAABBmin[c*3+1] || wy > cellAABBmax[c*3+1]) continue;
      if (wz < cellAABBmin[c*3+2] || wz > cellAABBmax[c*3+2]) continue;
      const VTK_TO_STD = [0,1,3,2,4,5,7,6];
      for (let k = 0; k < 8; k++) {
        const pi = m.cellConn[c*8+VTK_TO_STD[k]];
        tmpCorners[k*3]=m.positions[pi*3];
        tmpCorners[k*3+1]=m.positions[pi*3+1];
        tmpCorners[k*3+2]=m.positions[pi*3+2];
      }
      const uvw = inverseTrilinear(tmpCorners, [wx, wy, wz]);
      if (uvw) { best = c; break; }
      else newtonFailButHit++;
    }
    if (best < 0) {
      // Also count if AABB would have hit but we failed
      let aabbWouldHit = 0;
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (wx < cellAABBmin[c*3] || wx > cellAABBmax[c*3]) continue;
        if (wy < cellAABBmin[c*3+1] || wy > cellAABBmax[c*3+1]) continue;
        if (wz < cellAABBmin[c*3+2] || wz > cellAABBmax[c*3+2]) continue;
        aabbWouldHit++;
      }
      if (aabbWouldHit > 0) aabbFailButHit++;
      miss++;
    } else hits++;
  }
  console.log(`voxel walk: hits=${hits} miss=${miss} (${(100*hits/GRID**3).toFixed(1)}% coverage)`);
  console.log(`  of the ${miss} misses:`);
  console.log(`    AABB-would-have-hit but Newton failed: ${aabbFailButHit}`);
  console.log(`    pure outside (no AABB hit): ${miss - aabbFailButHit}`);
  console.log(`  total Newton failures across all voxels: ${newtonFailButHit}`);
}

checkCoverage(join(__dirname, 'candidates/spe9.vtk'), 'SPE-9');
checkCoverage(join(__dirname, 'candidates/hexa.vtk'), 'hexa');