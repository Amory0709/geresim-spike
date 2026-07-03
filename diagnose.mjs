// Headless browser feedback loop for the Geresim spike.
// Captures: console messages, page errors, screenshot. Exits non-zero if errors.
//
// Usage: node diagnose.mjs [URL]   (default: https://amory0709.github.io/geresim-spike/)
import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://amory0709.github.io/geresim-spike/';
const OUT = process.argv[3] || '/tmp/geresim-diag.png';

const browser = await chromium.launch({
  headless: false,
  args: [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--enable-features=Vulkan',
    '--no-sandbox',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const consoleMsgs = [];
const pageErrors = [];

page.on('console', msg => {
  consoleMsgs.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', err => {
  pageErrors.push(err.message);
});
page.on('requestfailed', req => {
  consoleMsgs.push({ type: 'requestfailed', text: `${req.url()} — ${req.failure()?.errorText}` });
});

console.log(`[diag] loading ${URL}`);
const start = Date.now();
await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
console.log(`[diag] page load done in ${Date.now() - start}ms`);

// Give the JS time to run, fetch the data, build textures, render
await page.waitForTimeout(8000);

const hud = await page.evaluate(() => {
  const cellsEl = document.getElementById('s-cells');
  const pointsEl = document.getElementById('s-points');
  const gridEl = document.getElementById('s-grid');
  const fpsEl = document.getElementById('s-fps');
  const errEl = document.getElementById('err');
  return {
    cells: cellsEl?.textContent,
    points: pointsEl?.textContent,
    grid: gridEl?.textContent,
    fps: fpsEl?.textContent,
    err: errEl?.style.display === 'none' ? null : errEl?.textContent,
  };
});

const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  return { w: c.width, h: c.height, exists: true };
});

const centerPixel = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  // Sample center pixel
  const px = new Uint8Array(4);
  gl.readPixels(c.width / 2, c.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [...px];
});

await page.screenshot({ path: OUT, fullPage: false });

console.log('\n[diag] HUD:');
console.log('  cells:', hud.cells, 'points:', hud.points, 'grid:', hud.grid, 'fps:', hud.fps);
console.log('  err box:', hud.err || '(empty)');
console.log('  canvas:', canvasInfo);
console.log('  center pixel RGBA:', centerPixel);

console.log('\n[diag] page errors:');
if (pageErrors.length === 0) console.log('  (none)');
else for (const e of pageErrors) console.log('  -', e);

console.log('\n[diag] console messages:');
if (consoleMsgs.length === 0) console.log('  (none)');
else for (const m of consoleMsgs) {
  const preview = m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text;
  console.log(`  [${m.type}] ${preview}`);
}

console.log(`\n[diag] screenshot: ${OUT}`);

await browser.close();

const hasError = pageErrors.length > 0 || consoleMsgs.some(m => m.type === 'error' || m.type === 'requestfailed');
process.exit(hasError ? 1 : 0);
