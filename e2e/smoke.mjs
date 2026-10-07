// End-to-end smoke test: builds the app, serves it, and drives it in headless Chromium.
//   npm run e2e
// Needs a Chromium: set CHROMIUM_PATH, or run `npx playwright install chromium`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';
import { initManifold, manifold } from '../src/manifold.js';
import { writeBinarySTL } from '../src/stl.js';
import { manifoldToGeometry } from '../src/mesh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'out');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

/** Triangle count + bounding box of a binary STL file. */
function inspectStl(file) {
  const buf = fs.readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const x = view.getFloat32(84 + t * 50 + 12 + v * 12 + a * 4, true);
        min[a] = Math.min(min[a], x);
        max[a] = Math.max(max[a], x);
      }
    }
  }
  return { triangles: n, sizeOk: buf.length === 84 + n * 50, min, max };
}

// --- fixtures -------------------------------------------------------------
await initManifold();
const { Manifold } = manifold();
const boxFile = path.join(out, 'box.stl');
const box = Manifold.cube([40, 25, 15], true);
fs.writeFileSync(boxFile, Buffer.from(writeBinarySTL(manifoldToGeometry(box))));
const pacifico = path.join(root, 'node_modules/@fontsource/pacifico/files/pacifico-latin-400-normal.woff');
const fakeWoff2 = path.join(out, 'x.woff2');
fs.writeFileSync(fakeWoff2, Buffer.from('wOF2....'));

// --- build + serve --------------------------------------------------------
await build({ root, logLevel: 'warn' });
const server = await preview({ root, logLevel: 'error', preview: { port: 4173, strictPort: true } });
const url = 'http://localhost:4173/';

const executablePath =
  process.env.CHROMIUM_PATH ||
  [ '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium' ].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await context.newPage();
  // Let the test read WebGL pixels back (the app itself doesn't need this).
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
      return getContext.call(this, type, attrs);
    };
  });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

  const status = () => page.locator('#status').innerText();
  const download = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
    const file = path.join(out, name);
    await dl.saveAs(file);
    return inspectStl(file);
  };
  const idle = () => page.waitForSelector('#busy', { state: 'hidden' });

  console.log('\nload');
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Click the plaque'), null, { timeout: 30000 });
  await idle();
  check(/plaque: 70\.0 × 30\.0 × 4\.0 mm/.test(await page.locator('#modelInfo').innerText()), 'sample plaque loaded with correct size');
  check((await page.locator('#font option').count()) === 6, 'six bundled fonts listed');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, '1-initial.png') });

  // WebGL actually drew something
  const canvasPixels = await page.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    const probe = document.createElement('canvas');
    probe.width = c.width; probe.height = c.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return painted;
  });
  check(canvasPixels > 5000, 'WebGL canvas rendered the scene', `${canvasPixels} painted pixels`);

  console.log('\nplace by clicking the model');
  const box0 = await page.locator('#stage canvas').boundingBox();
  const before = [await page.inputValue('#posX'), await page.inputValue('#posY')];
  await page.mouse.click(box0.x + box0.width / 2 + 110, box0.y + box0.height / 2 + 10);
  const after = [await page.inputValue('#posX'), await page.inputValue('#posY')];
  check(before.join() !== after.join(), 'clicking the plaque moved the text', `${before} -> ${after}`);
  check((await page.inputValue('#posZ')) === '4', 'text sits on the top surface (z = 4)');

  console.log('\nemboss');
  await page.fill('#text', 'Hello\nWorld');
  await page.waitForTimeout(400);
  const base = await (async () => {
    // download the untouched plaque for a triangle-count baseline
    await page.fill('#text', '');
    const info = await download('plaque.stl');
    await page.fill('#text', 'Hello\nWorld');
    return info;
  })();
  check(base.triangles > 100 && base.sizeOk, 'plaque downloads as valid binary STL', `${base.triangles} triangles`);
  await page.waitForTimeout(300);
  await page.click('#applyBtn');
  await idle();
  check((await status()).includes('Text merged'), 'apply merged the text', await status());
  const embossed = await download('embossed.stl');
  check(embossed.triangles > base.triangles && embossed.sizeOk, 'embossed STL has more triangles', `${embossed.triangles}`);
  check(Math.abs(embossed.max[2] - 5.5) < 0.01, 'text rises 1.5 mm above the 4 mm plaque', `max z ${embossed.max[2].toFixed(3)}`);
  await page.screenshot({ path: path.join(out, '2-embossed.png') });

  console.log('\nundo');
  await page.click('#undoBtn');
  const undone = await download('undone.stl');
  check(undone.triangles === base.triangles, 'undo restores the original mesh', `${undone.triangles}`);

  console.log('\nengrave with an uploaded font');
  await page.setInputFiles('#fontFile', pacifico);
  await page.waitForFunction(() => document.querySelector('#font').value.startsWith('user-'));
  check((await page.locator('#font option:checked').innerText()).includes('Pacifico'), 'uploaded font selected', await page.locator('#font option:checked').innerText());
  await page.check('input[name="mode"][value="engrave"]');
  await page.fill('input[type="number"][data-key="depth"]', '1');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, '3-engrave-preview.png') });
  await page.click('#applyBtn');
  await idle();
  check((await status()).includes('Text merged'), 'engrave applied', await status());
  const engraved = await download('engraved.stl');
  check(Math.abs(engraved.max[2] - 4) < 0.01, 'engraving does not change the outer height', `max z ${engraved.max[2].toFixed(3)}`);
  check(engraved.triangles > base.triangles, 'engraved STL has the cut geometry', `${engraved.triangles}`);
  await page.screenshot({ path: path.join(out, '4-engraved.png') });

  console.log('\nbad font');
  await page.setInputFiles('#fontFile', fakeWoff2);
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  check((await status()).includes('WOFF2'), 'WOFF2 gives a helpful error', await status());

  console.log('\nopen an STL file, snap to a side');
  await page.setInputFiles('#stlFile', boxFile);
  await page.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('box:'));
  check(/40\.0 × 25\.0 × 15\.0 mm/.test(await page.locator('#modelInfo').innerText()), 'STL loaded with correct size');
  check((await page.inputValue('#posZ')) === '7.5', 'text auto-placed on top face', `z=${await page.inputValue('#posZ')}`);
  await page.click('[data-side="front"]');
  check((await page.inputValue('#posY')) === '-12.5', 'Front button snaps to the -Y face', `y=${await page.inputValue('#posY')}`);
  await page.selectOption('#font', { index: 1 });
  await page.click('input[name="mode"][value="emboss"]', { force: true });
  await page.fill('#text', 'FRONT');
  await page.fill('input[type="number"][data-key="depth"]', '1.5');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, '5-front-side.png') });
  const wall = await download('box-front.stl');
  check(Math.abs(wall.min[1] - -14) < 0.01, 'text on the front wall protrudes 1.5 mm in -Y (box face at -12.5)', `min y ${wall.min[1].toFixed(3)}`);

  console.log('\nno model');
  await page.click('#clearBtn');
  await page.fill('#text', 'ALONE');
  await page.waitForTimeout(400);
  const alone = await download('text-only.stl');
  check(alone.triangles > 50 && Math.abs(alone.min[2]) < 1e-3 && Math.abs(alone.max[2] - 1.5) < 1e-3, 'text-only export sits on the build plate', `z ${alone.min[2]}..${alone.max[2]}`);

  check(problems.length === 0, 'no console errors or exceptions', problems.join(' | '));
} finally {
  await browser.close();
  await server.close();
  box.delete();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
