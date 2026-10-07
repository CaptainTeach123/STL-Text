// End-to-end smoke test: builds the app, serves it, and drives it in headless Chromium.
//   npm run e2e
// Needs a Chromium: set CHROMIUM_PATH, or run `npx playwright-core install chromium`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';
import { initManifold, manifold } from '../src/manifold.js';
import { parseSTL, triangleSoup, writeBinarySTL } from '../src/stl.js';
import { geometryToManifold, manifoldToSoup } from '../src/mesh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'out');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

/** Triangle count, bounding box and (if watertight) volume of a binary STL file. */
function inspectStl(file) {
  const buf = fs.readFileSync(file);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const n = new DataView(bytes).getUint32(80, true);
  const geometry = parseSTL(bytes);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  let volume = null;
  try {
    const m = geometryToManifold(geometry);
    volume = m.volume();
    m.delete();
  } catch {
    /* not watertight */
  }
  return { triangles: n, sizeOk: buf.length === 84 + n * 50, min: bb.min.toArray(), max: bb.max.toArray(), volume };
}

// --- fixtures -------------------------------------------------------------
await initManifold();
const { Manifold } = manifold();
const soupOf = (m) => manifoldToSoup(m);
const writeFixture = (name, soup) => {
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(writeBinarySTL(soup)));
  return file;
};
const box = Manifold.cube([40, 25, 15], true);
const boxFile = writeFixture('box.stl', soupOf(box));
// a broken box: two triangles missing, five flipped, three duplicated
const broken = (() => {
  const s = soupOf(box);
  const tris = s.length / 9;
  const keep = [];
  for (let t = 0; t < tris; t++) {
    if (t === 3 || t === 7) continue; // holes
    const tri = Array.from(s.subarray(t * 9, t * 9 + 9));
    if (t % 2 === 0 && t < 10) keep.push(...tri.slice(0, 3), ...tri.slice(6, 9), ...tri.slice(3, 6)); // flipped
    else keep.push(...tri);
    if (t < 3) keep.push(...tri); // duplicates
  }
  return new Float32Array(keep);
})();
const brokenFile = writeFixture('broken.stl', broken);
const cyl = Manifold.cylinder(60, 20, 20, 128, true).rotate([90, 0, 0]); // axis along Y, top at z = 20
const cylFile = writeFixture('cylinder.stl', soupOf(cyl));
const inchBox = Manifold.cube([2, 1, 0.5], true);
const inchFile = writeFixture('inch.stl', soupOf(inchBox));
const pacifico = path.join(root, 'node_modules/@fontsource/pacifico/files/pacifico-latin-400-normal.woff');
const fakeWoff2 = path.join(out, 'x.woff2');
fs.writeFileSync(fakeWoff2, Buffer.from('wOF2....'));

// --- build + serve --------------------------------------------------------
await build({ root, logLevel: 'warn' });
const server = await preview({ root, logLevel: 'error', preview: { port: 4173, strictPort: true } });
const url = 'http://localhost:4173/';

const executablePath =
  process.env.CHROMIUM_PATH ||
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
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
  page.on('worker', (w) => w.on('console', (m) => m.type() === 'error' && problems.push(`worker: ${m.text()}`)));

  const status = () => page.locator('#status').innerText();
  const idle = async () => {
    await page.waitForTimeout(60);
    await page.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await page.waitForTimeout(60);
    await page.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
  };
  const download = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
    const file = path.join(out, name);
    await dl.saveAs(file);
    await idle();
    return inspectStl(file);
  };
  const openStl = async (file, name) => {
    await page.setInputFiles('#stlFile', file);
    await page.waitForFunction((n) => document.querySelector('#modelInfo').textContent.startsWith(`${n}:`), name);
    await idle();
  };
  const setText = async (text) => {
    await page.fill('#text', text);
    await idle();
  };
  const setNumber = async (key, value) => {
    await page.fill(`input[type="number"][data-key="${key}"]`, String(value));
    await page.dispatchEvent(`input[type="number"][data-key="${key}"]`, 'change');
    await idle();
  };

  console.log('\nload');
  await page.goto(url);
  await page.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#widthInput').value !== '', null, { timeout: 30000 });
  await idle();
  check(/plaque: 70\.0 × 30\.0 × 4\.0 mm/.test(await page.locator('#modelInfo').innerText()), 'sample plaque loaded with correct size');
  check((await page.locator('#font option').count()) === 6, 'six bundled fonts listed');
  check((await page.locator('#itemList li').count()) === 1, 'one text item to start with');
  check((await page.locator('#modelNotes li').innerText()).includes('Watertight'), 'model note says watertight');
  await page.screenshot({ path: path.join(out, '1-initial.png') });

  const canvasPixels = await page.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    const probe = document.createElement('canvas');
    probe.width = c.width;
    probe.height = c.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return painted;
  });
  check(canvasPixels > 5000, 'WebGL canvas rendered the scene', `${canvasPixels} painted pixels`);

  console.log('\nplace by clicking the model');
  await page.click('details summary:has-text("Exact position")');
  const box0 = await page.locator('#stage canvas').boundingBox();
  const before = [await page.inputValue('#posX'), await page.inputValue('#posY')];
  await page.mouse.click(box0.x + box0.width / 2 + 160, box0.y + box0.height / 2 + 60);
  await idle();
  const after = [await page.inputValue('#posX'), await page.inputValue('#posY')];
  check(before.join() !== after.join(), 'clicking the plaque moved the text', `${before} -> ${after}`);
  check((await page.inputValue('#posZ')) === '4', 'text sits on the top surface (z = 4)');
  await page.click('[data-side="top"]');
  await idle();
  check((await page.inputValue('#posX')) === '0' && (await page.inputValue('#posY')) === '0', 'Top button recentres the text');

  console.log('\nraised text');
  const base = await (async () => {
    await setText('');
    return download('plaque.stl');
  })();
  check(base.triangles > 100 && base.sizeOk && base.volume > 0, 'plain plaque downloads as a valid watertight STL', `${base.triangles} triangles`);
  await setText('Hello\nWorld');
  const embossed = await download('embossed.stl');
  check(embossed.triangles > base.triangles && embossed.sizeOk, 'raised STL has more triangles', `${embossed.triangles}`);
  check(Math.abs(embossed.max[2] - 5.5) < 0.01, 'text rises 1.5 mm above the 4 mm plaque', `max z ${embossed.max[2].toFixed(3)}`);
  check(embossed.volume > base.volume, 'raised text adds volume and the result is watertight', `${embossed.volume?.toFixed(0)} > ${base.volume.toFixed(0)}`);
  await page.screenshot({ path: path.join(out, '2-raised.png') });

  console.log('\ntexts list: add, select, delete, undo');
  await page.click('#addTextBtn');
  await setText('Second');
  check((await page.locator('#itemList li').count()) === 2, 'second item added');
  check((await page.locator('#itemList li[aria-selected="true"] .name').innerText()) === 'Second', 'new item is selected');
  await page.click('#itemList li:first-child');
  await idle();
  check((await page.inputValue('#text')) === 'Hello\nWorld', 'selecting the first item loads its text into the panel');
  await page.click('#itemList li:nth-child(2)');
  await page.click('#deleteBtn');
  await idle();
  check((await page.locator('#itemList li').count()) === 1, 'delete removes the item');
  check(!(await page.locator('#toast').isHidden()), 'delete shows an undo toast');
  await page.click('#undoBtn');
  await idle();
  check((await page.locator('#itemList li').count()) === 2, 'undo brings the item back');
  await page.click('#itemList li:nth-child(2)');
  await page.click('#deleteBtn');
  await idle();
  const single = await download('after-delete.stl');
  check(Math.abs(single.volume - embossed.volume) < 1e-3 * embossed.volume, 'deleted item is not in the export', `${single.volume?.toFixed(1)}`);

  console.log('\ncut-in text with an uploaded font');
  await page.setInputFiles('#fontFile', pacifico);
  await page.waitForFunction(() => document.querySelector('#font').value.startsWith('user-'));
  await idle();
  check((await page.locator('#font option:checked').innerText()).includes('Pacifico'), 'uploaded font selected', await page.locator('#font option:checked').innerText());
  await page.check('input[name="mode"][value="engrave"]');
  await idle();
  await setNumber('depth', 1);
  check((await page.locator('#depthLabel').innerText()).startsWith('Depth'), 'label switches to Depth');
  await page.screenshot({ path: path.join(out, '3-engrave-preview.png') });
  const engraved = await download('engraved.stl');
  check(Math.abs(engraved.max[2] - 4) < 0.01, 'engraving does not change the outer height', `max z ${engraved.max[2].toFixed(3)}`);
  check(engraved.volume < base.volume, 'engraving removes volume', `${engraved.volume?.toFixed(0)} < ${base.volume.toFixed(0)}`);

  console.log('\nshow final result');
  await page.check('#resultToggle');
  await idle();
  check(await page.isChecked('#resultToggle'), 'final result toggle stays on after computing');
  await page.screenshot({ path: path.join(out, '4-final-result.png') });
  await setNumber('depth', 1.2);
  check(!(await page.isChecked('#resultToggle')), 'editing switches the final result view off');

  console.log('\nprinting warnings');
  await setNumber('depth', 6);
  check((await page.locator('#textNotes').innerText()).includes('cut through'), 'deep engraving warns about cutting through the plaque', await page.locator('#textNotes').innerText());
  await page.click('#textNotes .btn');
  await idle();
  check(Number.parseFloat(await page.inputValue('input[type="number"][data-key="depth"]')) < 4, 'one-click fix lowers the depth', await page.inputValue('input[type="number"][data-key="depth"]'));
  await setNumber('size', 3);
  check((await page.locator('#textNotes').innerText()).includes('thinner'), 'tiny text warns about thin strokes');
  await setNumber('size', 10);

  console.log('\nbad font');
  await page.setInputFiles('#fontFile', fakeWoff2);
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  check((await status()).includes('WOFF2'), 'WOFF2 gives a helpful error', await status());

  console.log('\nbroken STL is repaired');
  await openStl(brokenFile, 'broken');
  const modelNotes = await page.locator('#modelNotes').innerText();
  check(/Repaired/.test(modelNotes), 'model note reports the repair', modelNotes.slice(0, 80));
  check(/40\.0 × 25\.0 × 15\.0 mm/.test(await page.locator('#modelInfo').innerText()), 'repaired size is right');
  check(!(await page.locator('input[name="mode"][value="engrave"]').isDisabled()), 'cut-in text is available on the repaired model');
  await page.selectOption('#font', 'inter');
  await setText('FIX');
  await page.check('input[name="mode"][value="engrave"]');
  await setNumber('depth', 1);
  const fixed = await download('broken-engraved.stl');
  check(fixed.volume !== null && fixed.volume < 40 * 25 * 15 && fixed.volume > 40 * 25 * 15 - 200, 'engraved repaired box exports watertight', `${fixed.volume?.toFixed(1)}`);

  console.log('\nengraving follows a curved surface');
  await openStl(cylFile, 'cylinder');
  await setText('HELLO');
  check((await page.inputValue('#posZ')) === '20', 'text auto-placed on top of the cylinder', `z=${await page.inputValue('#posZ')}`);
  check((await page.locator('#textNotes').innerText()).includes('follows the curve'), 'note says the text follows the curve');
  await page.screenshot({ path: path.join(out, '5-cylinder.png') });
  const carved = await download('cylinder-engraved.stl');
  const removed = cyl.volume() - carved.volume;
  // the footprint of "HELLO" (Inter Bold, 10 mm caps) is ~250 mm²; a flat slab 1 mm deep would remove far
  // less at the ends where the surface drops away – conformed text removes ≈ area × depth everywhere
  check(removed > 150 && removed < 400, 'engraving removed roughly footprint × depth on the curve', `${removed.toFixed(0)} mm³`);
  check(Math.abs(carved.max[2] - 20) < 0.01, 'outer radius unchanged', `max z ${carved.max[2].toFixed(3)}`);
  await page.click('details summary:has-text("Advanced")');
  await page.uncheck('input[data-key="conform"]');
  await idle();
  const flat = await download('cylinder-flat.stl');
  check(cyl.volume() - flat.volume < removed * 0.8, 'without "follow curved surfaces" much less is removed', `${(cyl.volume() - flat.volume).toFixed(0)} mm³`);
  await page.check('input[data-key="conform"]');
  await idle();

  console.log('\ninches → mm and model tools');
  await openStl(inchFile, 'inch');
  check((await page.locator('#modelSuggestions').innerText()).includes('inches'), 'inch-sized model gets a units suggestion');
  await page.click('#modelSuggestions .btn');
  await idle();
  check(/50\.8 × 25\.4 × 12\.7 mm/.test(await page.locator('#modelInfo').innerText()), 'model converted to mm', await page.locator('#modelInfo').innerText());
  check((await page.locator('#modelSuggestions').innerText()) === '', 'suggestion disappears after applying it');
  await page.click('[data-fix="rotX"]');
  await idle();
  check(/50\.8 × 12\.7 × 25\.4 mm/.test(await page.locator('#modelInfo').innerText()), 'rotate 90° about X swaps Y and Z');
  await page.click('#undoBtn');
  await idle();
  check(/50\.8 × 25\.4 × 12\.7 mm/.test(await page.locator('#modelInfo').innerText()), 'undo reverts the model transform');

  console.log('\nno model');
  await page.click('#clearBtn');
  await idle();
  await setText('ALONE');
  const alone = await download('text-only.stl');
  const depth = Number.parseFloat(await page.inputValue('input[type="number"][data-key="depth"]'));
  check(alone.triangles > 50 && Math.abs(alone.min[2]) < 1e-3 && Math.abs(alone.max[2] - depth) < 1e-3, 'text-only export sits on the build plate', `z ${alone.min[2]}..${alone.max[2]} (depth ${depth})`);
  check(!(await page.locator('input[name="mode"][value="engrave"]').isChecked()), 'cut-in text became raised when the model was removed');

  console.log('\nresponsiveness while loading a large model');
  const bigFile = writeFixture('big.stl', soupOf(Manifold.sphere(30, 600)));
  const t0 = Date.now();
  // record the worst frame gap on the main thread from the moment the engine gets busy until it is idle again
  const gapProbe = page.evaluate(
    () =>
      new Promise((resolve) => {
        let last = performance.now();
        let worst = 0;
        let sawBusy = false;
        let wasBusy = false;
        const tick = () => {
          const now = performance.now();
          const busy = document.body.dataset.engine === 'busy';
          // only frames spent while the worker computes count: the page must stay interactive then
          if (busy && wasBusy) worst = Math.max(worst, now - last);
          last = now;
          wasBusy = busy;
          if (busy) sawBusy = true;
          if (sawBusy && !busy) resolve(worst);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await openStl(bigFile, 'big');
  const worstGap = await gapProbe;
  check(/180,000 triangles|180000 triangles/.test((await page.locator('#modelInfo').innerText()).replace(/ /g, ',')), '180k-triangle model loaded', `${Date.now() - t0} ms`);
  check(worstGap < 300, 'main thread stayed responsive while the worker loaded it', `worst frame gap ${worstGap.toFixed(0)} ms`);

  check(problems.length === 0, 'no console errors or exceptions (page or worker)', problems.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
