// verify_render.mjs — render canvas2D and WebGL side-by-side, save both PNGs,
// print summary stats. Goal: after the cellData corner-order fix, WebGL should
// look much closer to canvas2D (per-cell scalar correct, gradient + lighting
// no longer sign-inverted in v/w).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8768;
const URL_BASE = `http://127.0.0.1:${PORT}`;

// 1) Start static server
let server;
async function startServer() {
  // Static server is launched separately (see static_server.mjs). Just verify it.
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}/index.html`, res => {
      if (res.statusCode === 200) resolve();
      else reject(new Error(`server returned ${res.statusCode}`));
      res.resume();
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 2) Launch chromium with swiftshader (so WebGL works headless)
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl'],
});

async function captureAndDump(urlSuffix, outName, viewportW = 1400, viewportH = 1000) {
  const ctx = await browser.newContext({ viewport: { width: viewportW, height: viewportH } });
  const page = await ctx.newPage();
  const errors = [];
  const consoleMsgs = [];
  page.on('console', m => consoleMsgs.push({ t: m.type(), x: m.text() }));
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(URL_BASE + urlSuffix, { waitUntil: 'load', timeout: 30000 });
  // Wait for cell index build to finish (the load is async, ~3-8s for SPE-9)
  await page.waitForTimeout(8000);

  const hud = await page.evaluate(() => ({
    cells: document.getElementById('s-cells')?.textContent,
    points: document.getElementById('s-points')?.textContent,
    grid: document.getElementById('s-grid')?.textContent,
    build: document.getElementById('s-build')?.textContent,
    fps: document.getElementById('s-fps')?.textContent,
    range: document.getElementById('s-range')?.textContent,
    err: document.getElementById('err')?.textContent,
  }));

  await page.screenshot({ path: join(__dirname, outName), fullPage: false });

  await ctx.close();
  return { hud, errors, consoleMsgs };
}

await startServer();
console.log(`server up at ${URL_BASE}`);
await sleep(500);

console.log('rendering WebGL ?file=spe9…');
const webgl = await captureAndDump('/?file=spe9', 'screenshots/_verify_webgl.png');
console.log('  HUD:', webgl.hud);
console.log('  errors:', webgl.errors.length, webgl.errors.slice(0, 3));
console.log('  console errors:', webgl.consoleMsgs.filter(m => m.t === 'error').length);

console.log('\nrendering canvas2D ?file=spe9&force2d=1…');
const c2d = await captureAndDump('/?file=spe9&force2d=1', 'screenshots/_verify_canvas2d.png');
console.log('  HUD:', c2d.hud);
console.log('  errors:', c2d.errors.length);

await browser.close();
// server is externally managed; don't kill it
console.log('\nDONE. Compare:');
console.log('  screenshots/_verify_webgl.png');
console.log('  screenshots/_verify_canvas2d.png');