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
const bar = Manifold.cube([20, 6, 3], true);
const barFile = writeFixture('bar.stl', soupOf(bar));
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
  /** Set the selected text's lines (one font/size per line kept as is; extra lines removed, missing ones added). */
  const setLines = async (lines) => {
    const count = () => page.locator('#lineList .line').count();
    while ((await count()) > lines.length) {
      await page.click('#lineList .line-remove >> nth=-1');
      await idle();
    }
    while ((await count()) < lines.length) {
      await page.click('#addLineBtn');
      await idle();
    }
    for (let i = 0; i < lines.length; i++) {
      await page.fill(`#lineList .line-text >> nth=${i}`, lines[i]);
    }
    await page.dispatchEvent(`#lineList .line-text >> nth=${lines.length - 1}`, 'change');
    await idle();
  };
  const setText = (text) => setLines(text === '' ? [''] : text.split('\n'));
  const setLineSize = async (index, value) => {
    await page.fill(`#lineList .line-size >> nth=${index}`, String(value));
    await page.dispatchEvent(`#lineList .line-size >> nth=${index}`, 'change');
    await idle();
  };
  const lineFont = (index) => page.locator(`#lineList .line-font >> nth=${index}`);
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
  check((await page.locator('#lineList .line-font >> nth=0 >> option').count()) === 6, 'six bundled fonts listed for the line');
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
  check((await page.inputValue('#lineList .line-text >> nth=0')) === 'Hello' && (await page.inputValue('#lineList .line-text >> nth=1')) === 'World', 'selecting the first item loads its lines into the panel');
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
  await page.click('#lineList .line-text >> nth=0'); // the upload applies to the current line
  await page.setInputFiles('#fontFile', pacifico);
  await page.waitForFunction(() => document.querySelector('#lineList .line-font').value.startsWith('user-'));
  await idle();
  check((await lineFont(0).locator('option:checked').innerText()).includes('Pacifico'), 'uploaded font applied to the current line', await lineFont(0).locator('option:checked').innerText());
  check((await lineFont(1).locator('option:checked').innerText()).includes('Inter'), 'the other line keeps its font');
  await page.check('input[name="mode"][value="engrave"]');
  await idle();
  await setNumber('depth', 1);
  check((await page.locator('#depthLabel').innerText()).startsWith('Depth'), 'label switches to Depth');
  await page.screenshot({ path: path.join(out, '3-engrave-preview.png') });
  const engraved = await download('engraved.stl');
  check(Math.abs(engraved.max[2] - 4) < 0.01, 'engraving does not change the outer height', `max z ${engraved.max[2].toFixed(3)}`);
  check(engraved.volume < base.volume, 'engraving removes volume', `${engraved.volume?.toFixed(0)} < ${base.volume.toFixed(0)}`);

  console.log('\nlines with different fonts and sizes');
  await setLines(['TITLE', 'name']);
  await page.selectOption('#lineList .line-font >> nth=0', 'slab');
  await page.selectOption('#lineList .line-font >> nth=1', 'pacifico');
  await setLineSize(0, 9);
  await setLineSize(1, 5);
  const meta = await page.locator('#itemList li[aria-selected="true"] .meta').innerText();
  check(/2 lines/.test(meta) && /9 \/ 5 mm/.test(meta), 'item shows its two lines and sizes', meta);
  const titleWidth = await (async () => {
    await setLines(['TITLE']);
    await setLineSize(0, 9);
    const w = Number.parseFloat(await page.inputValue('#widthInput'));
    await setLines(['TITLE', 'name']);
    await page.selectOption('#lineList .line-font >> nth=1', 'pacifico');
    await setLineSize(1, 5);
    return w;
  })();
  check(Math.abs(Number.parseFloat(await page.inputValue('#widthInput')) - titleWidth) < 0.6, 'block width equals the widest line', `${await page.inputValue('#widthInput')} vs ${titleWidth}`);
  await page.screenshot({ path: path.join(out, '3b-lines.png') });
  const twoLines = await download('two-lines.stl');
  check(twoLines.volume !== null && twoLines.sizeOk && Math.abs(twoLines.volume - base.volume) > 10, 'two-line block exports as one watertight solid', `${twoLines.volume?.toFixed(0)} vs plain ${base.volume.toFixed(0)}`);
  await page.focus('#lineList .line-text >> nth=1');
  await page.keyboard.press('Enter');
  await idle();
  check((await page.locator('#lineList .line').count()) === 3, 'Enter adds a line below');
  await page.keyboard.press('Backspace');
  await idle();
  check((await page.locator('#lineList .line').count()) === 2, 'Backspace on an empty line removes it');
  await setLines(['Hello', 'World']);
  await page.selectOption('#lineList .line-font >> nth=0', 'inter');
  await page.selectOption('#lineList .line-font >> nth=1', 'inter');
  await setLineSize(0, 10);
  await setLineSize(1, 10);

  console.log('\nline editing keeps what you typed');
  await setLines(['Hello']);
  await page.focus('#lineList .line-text >> nth=0');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await idle();
  await page.keyboard.press('Backspace'); // remove the empty line again
  await idle();
  await page.keyboard.type(' world');
  await idle();
  check((await page.inputValue('#lineList .line-text >> nth=0')) === 'Hello world', 'Backspace on an empty line puts the caret at the end of the previous line', await page.inputValue('#lineList .line-text >> nth=0'));
  await page.evaluate(() => {
    const input = document.querySelector('#lineList .line-text');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', 'Happy\nBirthday');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await idle();
  check((await page.locator('#lineList .line').count()) === 2 && (await page.inputValue('#lineList .line-text >> nth=1')) === 'Birthday', 'pasting multi-line text makes lines', `${await page.locator('#lineList .line').count()} lines`);
  await page.click('#lineList .line-remove >> nth=1');
  await idle();
  check((await page.locator('#lineList .line').count()) === 1 && (await page.evaluate(() => document.activeElement?.className)) === 'line-text', 'removing a line with × keeps the keyboard focus in the editor');
  await setLines(['Hello', 'World']);

  console.log('\nbacking plate: plaque and banner');
  await setLines(['Hello']);
  await page.click('input[name="mode"][value="emboss"]', { force: true });
  await idle();
  const bareWidth = Number.parseFloat(await page.inputValue('#widthInput'));
  await page.selectOption('select[data-key="plate"]', 'plaque');
  await idle();
  const plaqueWidth = Number.parseFloat(await page.inputValue('#widthInput'));
  check(Math.abs(plaqueWidth - (bareWidth + 6)) < 0.6, 'plaque is wider than the text by twice the margin', `${bareWidth} -> ${plaqueWidth}`);
  check(!(await page.locator('.plate-only').first().isHidden()), 'plate controls appear');
  await page.selectOption('select[data-key="plate"]', 'banner');
  await idle();
  const bannerWidth = Number.parseFloat(await page.inputValue('#widthInput'));
  check(bannerWidth > plaqueWidth, 'banner has tails beyond the plaque width', `${plaqueWidth} -> ${bannerWidth}`);
  const plated = await download('banner.stl');
  const textDepth = Number.parseFloat(await page.inputValue('input[type="number"][data-key="depth"]'));
  check(plated.volume > base.volume && plated.sizeOk && Math.abs(plated.max[2] - (4 + 2 + textDepth)) < 0.05, 'banner with raised text exports as one solid, plate 2 mm + text', `max z ${plated.max[2].toFixed(2)} (depth ${textDepth}) vol ${plated.volume?.toFixed(0)}`);
  await page.screenshot({ path: path.join(out, '3c-banner.png') });
  await page.selectOption('select[data-key="plate"]', 'none');
  await idle();

  console.log('\nattach a part');
  const beforePart = await download('before-part.stl'); // the plaque with the current text on it
  const itemsBefore = await page.locator('#itemList li').count();
  await page.setInputFiles('#partFile', barFile);
  await page.waitForFunction((n) => document.querySelectorAll('#itemList li').length === n + 1, itemsBefore);
  await idle();
  check(!(await page.locator('#partCard').isHidden()) && (await page.locator('#textCard').isHidden()), 'selecting a part shows the Part card instead of the text card');
  check((await page.locator('#partInfo').innerText()).includes('20.0 × 6.0 × 3.0'), 'part info shows its size', await page.locator('#partInfo').innerText());
  await page.click('[data-side="top"]');
  await idle();
  const fused = await download('part-fused.stl');
  // the part sits over the raised letters, so the shared volume counts once: between the part minus letters and the part minus its sunk slice
  const added = fused.volume - beforePart.volume;
  check(added > 200 && added <= 360 - 20 * 6 * 0.4 + 1 && fused.sizeOk, 'fused part adds its volume (minus what it shares with the model)', `+${added.toFixed(0)} mm³`);
  await page.check('input[name="join"][value="fillet"]');
  await idle();
  check(!(await page.locator('.fillet-only').first().isHidden()), 'fillet radius control appears');
  const filleted = await download('part-fillet.stl');
  check(filleted.volume > fused.volume + 20 && filleted.sizeOk, 'fillet adds material around the foot', `${filleted.volume?.toFixed(0)} > ${fused.volume?.toFixed(0)}`);
  await page.screenshot({ path: path.join(out, '6-part-fillet.png') });
  await page.check('input[name="join"][value="pegs"]');
  await idle();
  const [dlA, dlB] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForEvent('download', { predicate: (d) => /part-1/.test(d.suggestedFilename()) }),
    page.click('#downloadBtn'),
  ]).then((r) => r.slice(0, 2));
  const fileA = path.join(out, 'pegs-model.stl');
  const fileB = path.join(out, 'pegs-part.stl');
  await dlA.saveAs(fileA);
  await dlB.saveAs(fileB);
  await idle();
  const pegModel = inspectStl(fileA);
  const pegPart = inspectStl(fileB);
  check(pegModel.volume < beforePart.volume - 50 && pegModel.sizeOk, 'pegs: the model gets holes', `${pegModel.volume?.toFixed(0)} < ${beforePart.volume?.toFixed(0)}`);
  check(pegPart.volume > 360 && pegPart.sizeOk, 'pegs: the part downloads separately with its pegs', `${pegPart.volume?.toFixed(0)}`);
  check(Math.abs(pegPart.min[2]) < 0.01 && pegPart.max[2] > 3 + 5 && pegPart.max[2] < 3 + 7, 'pegs: the part file lies flat with the pegs pointing up', `z ${pegPart.min[2].toFixed(2)}…${pegPart.max[2].toFixed(2)}`);
  check((await page.locator('#textNotes').innerText()).includes('Pegs'), 'pegs: the notes explain the separate download');
  await page.check('input[name="mode"][value="engrave"]');
  await idle();
  check(await page.locator('fieldset.join-only').isHidden(), 'a part used as a cutter has no connection options');
  check((await page.locator('#sinkLabel').innerText()).startsWith('Cut depth'), 'the sink field becomes the cut depth for a cutter');
  const cutterPart = await download('part-cutter.stl');
  check(cutterPart.volume < beforePart.volume - 20 && cutterPart.sizeOk, 'a cutter part removes material', `${cutterPart.volume?.toFixed(0)} < ${beforePart.volume?.toFixed(0)}`);
  await page.check('input[name="mode"][value="emboss"]');
  await idle();
  await page.click('#deleteBtn');
  await idle();
  await page.click('#itemList li:first-child');
  await idle();

  console.log('\nshow final result');
  await page.check('#resultToggle');
  await idle();
  check(await page.isChecked('#resultToggle'), 'final result toggle stays on after computing');
  await page.screenshot({ path: path.join(out, '4-final-result.png') });
  await setNumber('depth', 1.2);
  check(!(await page.isChecked('#resultToggle')), 'editing switches the final result view off');

  console.log('\nprinting warnings');
  await page.check('input[name="mode"][value="engrave"]');
  await idle();
  await setNumber('depth', 6);
  check((await page.locator('#textNotes').innerText()).includes('cut through'), 'deep engraving warns about cutting through the plaque', await page.locator('#textNotes').innerText());
  await page.click('#textNotes .btn');
  await idle();
  check(Number.parseFloat(await page.inputValue('input[type="number"][data-key="depth"]')) < 4, 'one-click fix lowers the depth', await page.inputValue('input[type="number"][data-key="depth"]'));
  await setLineSize(0, 3);
  check((await page.locator('#textNotes').innerText()).includes('thinner'), 'tiny text warns about thin strokes');
  await setLineSize(0, 10);

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
  await setText('FIX');
  await page.selectOption('#lineList .line-font >> nth=0', 'inter');
  await idle();
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
  await page.setInputFiles('#partFile', barFile);
  await page.waitForFunction(() => document.querySelector('#itemList li .glyph.part'));
  await idle();
  check(await page.locator('input[name="join"][value="pegs"]').isDisabled(), 'pegs cannot be chosen without a model to make holes in');
  const partAlone = await download('part-alone.stl');
  check(Math.abs(partAlone.min[2]) < 1e-3 && partAlone.volume > 300, 'a part without a model sits on the build plate', `z from ${partAlone.min[2]}`);
  await page.click('#deleteBtn');
  await idle();

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

  console.log('\nloading while another load is in flight');
  await page.dblclick('#sampleBtn');
  await idle();
  check(/plaque: 70\.0 × 30\.0 × 4\.0 mm/.test(await page.locator('#modelInfo').innerText()), 'double-clicking Sample plaque still loads the plaque', await page.locator('#modelInfo').innerText());
  check(!(await status()).startsWith('Could not open'), 'no load error from the superseded request', await status());
  await page.setInputFiles('#stlFile', bigFile);
  await page.click('[data-fix="center"]'); // a model tool while the load is still running
  await openStl(bigFile, 'big');
  check(/180,000 triangles|180000 triangles/.test((await page.locator('#modelInfo').innerText()).replace(/\u202f/g, ',')), 'model tool during a load does not lose the model');

  console.log('\nfonts arriving while typing');
  {
    const slow = await context.newPage();
    const slowProblems = [];
    slow.on('pageerror', (e) => slowProblems.push(e.message));
    let release;
    const gate = new Promise((r) => (release = r));
    let served = 0;
    await slow.route('**/*.woff', async (route) => {
      served += 1;
      if (served > 1) await gate; // the first font loads normally, the rest wait until we say so
      await route.continue();
    });
    await slow.goto(url);
    await slow.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await slow.waitForFunction(() => document.querySelector('#lineList .line-text')?.value === 'Hello', null, { timeout: 30000 });
    await slow.click('#lineList .line-text >> nth=0');
    await slow.keyboard.press('End');
    await slow.keyboard.type(' ab');
    release();
    await slow.waitForFunction(() => document.querySelector('#lineList .line-font').options.length === 6, null, { timeout: 30000 });
    await slow.waitForTimeout(300);
    await slow.keyboard.type('c');
    await slow.keyboard.press('Backspace');
    await slow.waitForTimeout(300);
    const value = await slow.inputValue('#lineList .line-text >> nth=0');
    check(value === 'Hello ab', 'typing continues after fonts arrive and Backspace edits the text, not the item', value);
    check((await slow.locator('#itemList li').count()) === 1, 'the text item survived', String(await slow.locator('#itemList li').count()));
    check(slowProblems.length === 0, 'no page errors in the slow-fonts page', slowProblems.join(' | '));
    await slow.close();
  }

  check(problems.length === 0, 'no console errors or exceptions (page or worker)', problems.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
