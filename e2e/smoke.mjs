// End-to-end smoke test: builds the app, serves it, and drives it in headless Chromium.
//   npm run e2e
// Needs a Chromium: set CHROMIUM_PATH, or run `npx playwright-core install chromium`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { initManifold, manifold } from '../src/manifold.js';
import { parseSTL, triangleSoup, writeBinarySTL } from '../src/stl.js';
import { geometryToManifold, manifoldToSoup } from '../src/mesh.js';
import { box as boxAt, lanternSolid, lidBoxSolid, roundLanternSolid } from '../tests/lanternFixture.js';

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
    // Let the test see how the engine measured the cuts (window.__engine.measures: whether each measure was
    // an estimate, made without building the final result), and hold back the answers to "Fit to my printer"
    // plans (window.__engine.hold) so that it can open another model while one is being planned.
    const Native = window.Worker;
    const engine = (window.__engine = { fits: new Set(), measures: new Map(), hold: false, held: [] });
    window.Worker = class extends Native {
      postMessage(message, transfer) {
        if (message?.type === 'split.plan' && message.mode === 'fit') engine.fits.add(message.id);
        if (message?.type === 'split.plan' && message.mode === 'measure') engine.measures.set(message.id, null);
        return super.postMessage(message, transfer);
      }
      set onmessage(listener) {
        super.onmessage =
          listener &&
          ((event) => {
            const { id, type, result } = event.data ?? {};
            if (engine.measures.has(id) && type !== 'progress') engine.measures.set(id, { estimate: result?.estimate === true });
            if (engine.hold && engine.fits.has(id) && type !== 'progress') engine.held.push(() => listener.call(this, event));
            else listener.call(this, event);
          });
      }
      get onmessage() {
        return super.onmessage;
      }
    };
  });
  /** Hand the page the plans held back, in order. */
  const releasePlans = () =>
    page.evaluate(() => {
      window.__engine.hold = false;
      window.__engine.held.splice(0).forEach((deliver) => deliver());
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

  console.log('\ncurved line');
  const straightWidth = Number.parseFloat(await page.inputValue('#widthInput'));
  await setNumber('curve', 120);
  await page.waitForFunction((w) => Math.abs(Number.parseFloat(document.querySelector('#widthInput').value) - w) > 1, straightWidth, { timeout: 30000 }).catch(() => {});
  const curvedWidth = Number.parseFloat(await page.inputValue('#widthInput'));
  check(Math.abs(curvedWidth - straightWidth) > 1, 'Curve bends the lines into arcs: the block changes shape', `${straightWidth} → ${curvedWidth} mm wide`);
  check((await page.inputValue('input[type="range"][data-key="curve"]')) === '120', 'the curve slider follows the number');
  await page.screenshot({ path: path.join(out, '2b-curved.png') });
  await setNumber('curve', 0);

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
  // dragged off the model: the list and the Part card say so, and "Snap to model" brings it back
  await page.evaluate(() => (document.querySelector('#posX').closest('details').open = true));
  await page.fill('#posX', '140');
  await page.dispatchEvent('#posX', 'change');
  await idle();
  check(/not touching/.test(await page.locator('#itemList li[aria-selected="true"] .meta').innerText()), 'a part off the model is listed as "not touching", not as fused');
  check(/Not touching the model/.test(await page.locator('#partInfo').innerText()), 'the Part card explains that the part is not touching');
  const floating = await download('part-floating.stl');
  check(Math.abs(floating.volume - beforePart.volume) < 1, 'a part that is not touching is left out of the download', `${floating.volume?.toFixed(0)} vs ${beforePart.volume?.toFixed(0)}`);
  await page.click('#snapBtn');
  await idle();
  check(/fused/.test(await page.locator('#itemList li[aria-selected="true"] .meta').innerText()), '"Snap to model" puts the part back on the model', await page.locator('#itemList li[aria-selected="true"] .meta').innerText());
  await page.click('[data-side="top"]');
  await idle();
  // free rotation: roll the bar by 90° so it stands on its end
  await page.click('[data-turn="roll"]');
  await idle();
  check(Number(await page.inputValue('input[type="number"][data-key="roll"]')) === 90, 'the Y button rolls the part by 90°');
  const standing = await download('part-standing.stl');
  await page.click('[data-turn="roll"]');
  await page.click('[data-turn="roll"]');
  await page.click('[data-turn="roll"]');
  await idle();
  check(Number(await page.inputValue('input[type="number"][data-key="roll"]')) === 0, 'four turns bring the roll back to 0');
  const fused = await download('part-fused.stl');
  check(standing.max[2] - fused.max[2] > 15, 'a rolled bar stands 20 mm tall instead of 3', `${standing.max[2].toFixed(1)} vs ${fused.max[2].toFixed(1)}`);
  // the part sits over the raised letters, so the shared volume counts once: between the part minus letters and the part minus its sunk slice
  const added = fused.volume - beforePart.volume;
  check(added > 200 && added <= 360 - 20 * 6 * 0.4 + 1 && fused.sizeOk, 'fused part adds its volume (minus what it shares with the model)', `+${added.toFixed(0)} mm³`);
  // a part turned so another side faces the model: "Snap to model" attaches it by that side and lays it flat
  await page.click('[data-turn="tilt"]');
  await idle();
  check(Number(await page.inputValue('input[type="number"][data-key="tilt"]')) === 90, 'the X button tilts the part by 90°');
  await page.click('#snapBtn');
  await idle();
  check(
    (await page.inputValue('select[data-key="attach"]')) === 'front' && Number(await page.inputValue('input[type="number"][data-key="tilt"]')) === 0,
    '"Snap to model" attaches the part by the side that faced the model and clears the tilt',
    `${await page.inputValue('select[data-key="attach"]')} / tilt ${await page.inputValue('input[type="number"][data-key="tilt"]')}`,
  );
  check(/fused/.test(await page.locator('#itemList li[aria-selected="true"] .meta').innerText()), 'the snapped part is fused with the model');
  await page.selectOption('select[data-key="attach"]', 'bottom');
  await idle();
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

  console.log('\nenhance detail');
  {
    const core = Manifold.cube([24, 24, 6], true);
    const ball = Manifold.sphere(1.5, 36); // a finely rounded edge: soft, like a generated model
    const soft = core.minkowskiSum(ball).refineToLength(0.8);
    const softFile = writeFixture('soft.stl', soupOf(soft));
    core.delete();
    ball.delete();
    soft.delete();
    await openStl(softFile, 'soft');
    await page.click('#enhanceModel summary');
    check(!(await page.locator('[data-enhance="sharpen"]').first().isDisabled()), 'enhance controls are enabled on a watertight model');
    const softBefore = await download('soft-before.stl');
    const triangleCount = async () => Number((await page.locator('#modelInfo').innerText()).match(/([\d,]+) triangles/)[1].replace(/,/g, ''));
    const trianglesBefore = await triangleCount();
    await page.fill('input[type="number"][data-enhance="sharpen"]', '100');
    await page.dispatchEvent('input[type="number"][data-enhance="sharpen"]', 'change');
    await idle();
    const notes = await page.locator('#modelNotes').innerText();
    check(/Enhanced: [\d,]+ points moved/.test(notes), 'model notes report the enhancement', notes.replace(/\s+/g, ' ').slice(0, 160));
    const sharpened = await download('soft-sharpened.stl');
    check((await triangleCount()) === trianglesBefore && sharpened.sizeOk, 'sharpening keeps the model triangle count', `${await triangleCount()} vs ${trianglesBefore}`);
    check(Math.abs(sharpened.volume - softBefore.volume) / softBefore.volume < 0.03, 'sharpening keeps the volume', `${sharpened.volume?.toFixed(0)} vs ${softBefore.volume?.toFixed(0)}`);
    const softBytes = fs.readFileSync(path.join(out, 'soft-before.stl'));
    const sharpBytes = fs.readFileSync(path.join(out, 'soft-sharpened.stl'));
    check(!softBytes.equals(sharpBytes), 'the downloaded model actually changed');
    await page.check('#enhanceCompare');
    await idle();
    check(/Showing the original/.test(await page.locator('#modelNotes').innerText()), '"Show original" shows the model as loaded');
    await page.uncheck('#enhanceCompare');
    await idle();
    check(/Enhanced:/.test(await page.locator('#modelNotes').innerText()), 'unticking brings the enhancement back');
    await page.click('#undoBtn');
    await idle();
    check(!/Enhanced:/.test(await page.locator('#modelNotes').innerText()), 'undo removes the enhancement', await page.locator('#modelNotes').innerText());
    check(Number(await page.inputValue('input[type="number"][data-enhance="sharpen"]')) === 0, 'the slider follows the undo');
    await page.click('#redoBtn');
    await idle();
    await page.click('#enhanceReset');
    await idle();
    check(!/Enhanced:/.test(await page.locator('#modelNotes').innerText()), 'Reset switches the enhancement off');
    await page.screenshot({ path: path.join(out, '7-enhance.png') });

    console.log('\nclean-up spot');
    // a plate with two bumps that have run together and a weaker one further away: what a clumped wreath looks like
    const clumpSolid = (() => {
      const plate = Manifold.cube([30, 30, 4], true).refineToLength(0.4);
      const m = plate.getMesh();
      plate.delete();
      const stride = m.numProp;
      const p = new Float32Array((m.vertProperties.length / stride) * 3);
      for (let i = 0; i < p.length / 3; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = m.vertProperties[i * stride + k];
      for (let v = 0; v < p.length; v += 3) {
        if (Math.abs(p[v + 2] - 2) > 1e-6) continue;
        for (const [bx, by, h] of [[-1.8, 0, 0.8], [1.8, 0, 0.8], [8, 6, 0.25]]) p[v + 2] += h * Math.exp(-((p[v] - bx) ** 2 + (p[v + 1] - by) ** 2) / (2 * 1.2 * 1.2));
      }
      const { Mesh } = manifold();
      return Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: p, triVerts: m.triVerts }));
    })();
    const clumpFile = writeFixture('clump.stl', soupOf(clumpSolid));
    clumpSolid.delete();
    await openStl(clumpFile, 'clump');
    const clumpBefore = await download('clump-before.stl');
    const clumpTriangles = await triangleCount();
    const itemsBefore = await page.locator('#itemList li').count();
    await page.click('[data-side="top"]');
    await idle();
    await page.click('#addSpotBtn');
    await page.waitForFunction((n) => document.querySelectorAll('#itemList li').length === n + 1, itemsBefore);
    await idle();
    check(!(await page.locator('#spotCard').isHidden()) && (await page.locator('#textCard').isHidden()) && (await page.locator('#styleCard').isHidden()), 'selecting a spot shows the Clean-up spot card only');
    check(/mm$/.test(await page.locator('#itemList li[aria-selected="true"] .meta').innerText()), 'the spot is listed with its radius');
    // a spot's amounts re-derive the whole model, so dragging a slider only follows live in the paired control: the model
    // gets the value on release (change), not on every input tick
    const listedBefore = await page.locator('#itemList li[aria-selected="true"] .meta').innerText();
    await page.fill('input[type="number"][data-key="radius"]', '6');
    await page.dispatchEvent('input[type="number"][data-key="radius"]', 'input');
    await idle();
    check((await page.locator('#itemList li[aria-selected="true"] .meta').innerText()) === listedBefore && Number(await page.inputValue('input[type="range"][data-key="radius"]')) === 6, 'typing a spot radius follows in the slider but does not re-derive the model until committed', await page.locator('#itemList li[aria-selected="true"] .meta').innerText());
    await page.dispatchEvent('input[type="number"][data-key="radius"]', 'change');
    await idle();
    check(/6\.0 mm|6 mm/.test(await page.locator('#itemList li[aria-selected="true"] .meta').innerText()), 'committing the radius applies it', await page.locator('#itemList li[aria-selected="true"] .meta').innerText());
    const spotNotes = await page.locator('#spotNotes').innerText();
    check(/Moved [1-9][\d,]* points inside the spot/.test(spotNotes), 'the spot reports what it moved on the clumped bumps', spotNotes.replace(/\s+/g, ' ').slice(0, 120));
    check(/1 clean-up spot applied/.test(await page.locator('#modelNotes').innerText()), 'the model notes count the spot');
    const spotted = await download('clump-spot.stl');
    check((await triangleCount()) === clumpTriangles && Math.abs(spotted.volume - clumpBefore.volume) / clumpBefore.volume < 0.01, 'the download includes the clean-up: same model triangles, volume kept', `${await triangleCount()} vs ${clumpTriangles} / ${spotted.volume?.toFixed(0)} vs ${clumpBefore.volume?.toFixed(0)}`);
    check(!fs.readFileSync(path.join(out, 'clump-spot.stl')).equals(fs.readFileSync(path.join(out, 'clump-before.stl'))), 'the downloaded model actually changed');
    // on the flat part of the plate the spot honestly does nothing
    await page.evaluate(() => (document.querySelector('#posX').closest('details').open = true));
    await page.fill('#posX', '-10');
    await page.dispatchEvent('#posX', 'change');
    await page.fill('#posY', '-10');
    await page.dispatchEvent('#posY', 'change');
    await idle();
    check(/Moved 0 points/.test(await page.locator('#spotNotes').innerText()), 'a spot on a flat area reports no change', await page.locator('#spotNotes').innerText());
    await page.click('#undoBtn');
    await page.click('#undoBtn');
    await idle();
    check(/Moved [1-9]/.test(await page.locator('#spotNotes').innerText()), 'undo moves the spot back onto the bumps');
    await page.click('#deleteBtn');
    await idle();
    check(!/clean-up spot/.test(await page.locator('#modelNotes').innerText()), 'deleting the spot removes it from the model');
    // find the details standing on the model and remove them (the bumps are big for this small plate: say so)
    await page.click('#findDetailsBtn');
    await page.waitForFunction(() => !document.querySelector('#detailsCard').hidden);
    await page.fill('#detailScale', '8');
    await page.click('#findAgainBtn');
    await page.waitForFunction(() => /Found \d+ detail|No details|Could not/.test(document.querySelector('#detailsSummary').textContent), null, { timeout: 60000 });
    await idle();
    const summary = await page.locator('#detailsSummary').innerText();
    check(/Found [1-9]\d* detail/.test(summary), '"Find details" finds the clumped bumps', summary.slice(0, 140));
    // the plan: one row per detail with what it seems to be; rebuilding adds a removing spot and a clean part per row
    const rows = await page.locator('#detailsList li').count();
    check(rows >= 1 && (await page.locator('#detailsList li select').first().inputValue()).length > 0, 'the plan lists each detail with a kind to become', `${rows} rows`);
    await page.locator('#detailsList li select').first().selectOption('dome');
    await page.locator('#detailsList li input[type="checkbox"]').first().check();
    const itemsBeforeRebuild = await page.locator('#itemList li').count();
    check(!(await page.locator('#rebuildBtn').isDisabled()), 'the rebuild button is live with a ticked row');
    await page.click('#rebuildBtn');
    await page.waitForFunction((n) => document.querySelectorAll('#itemList li').length >= n + 2, itemsBeforeRebuild, { timeout: 60000 });
    await idle();
    const itemsAfterRebuild = await page.locator('#itemList li').count();
    check(itemsAfterRebuild >= itemsBeforeRebuild + 2 && /dome/i.test(await page.locator('#itemList li[aria-selected="true"] .name, #itemList li[aria-selected="true"]').first().innerText()), 'rebuilding adds a removing spot and a clean dome part', `${itemsBeforeRebuild} → ${itemsAfterRebuild}`);
    const rebuiltStl = await download('clump-rebuilt.stl');
    check(rebuiltStl.volume !== null && rebuiltStl.sizeOk, 'the rebuilt model downloads as one watertight solid', `${rebuiltStl.volume?.toFixed(1)}`);
    await page.click('#undoBtn');
    await idle();
    check((await page.locator('#itemList li').count()) === itemsBeforeRebuild, 'one undo takes the whole rebuild back');
    check(!(await page.locator('#removeAllBtn').isDisabled()), 'the found details are still on offer after the undo');
    const itemsBeforeRemove = await page.locator('#itemList li').count();
    await page.click('#removeAllBtn');
    await idle();
    const itemsAfterRemove = await page.locator('#itemList li').count();
    check(itemsAfterRemove > itemsBeforeRemove && /removes/.test(await page.locator('#itemList li[aria-selected="true"] .meta').innerText()), '"Remove all found" adds removing spots', `${itemsBeforeRemove} → ${itemsAfterRemove}`);
    check((await page.locator('#spotCard input[data-key="deepen"]').first().isDisabled()) && !(await page.locator('#spotCard input[data-key="radius"]').first().isDisabled()), 'a removing spot has its clean-up amounts disabled, its radius not');
    check(/cuts? the model/.test(await page.locator('#modelNotes').innerText()), 'the model notes say the details are being cut away', (await page.locator('#modelNotes').innerText()).replace(/\s+/g, ' ').slice(0, 160));
    const removedStl = await download('clump-removed.stl');
    // the two bumps that ran together hold about 14.5 mm³ (less the part the engraved text already took); the spot covers most of their skirts
    check(removedStl.volume < clumpBefore.volume - 5 && removedStl.sizeOk, 'the download has the bumps cut away', `${removedStl.volume?.toFixed(1)} vs ${clumpBefore.volume?.toFixed(1)}`);
    while ((await page.locator('#itemList li').count()) > itemsBeforeRemove) {
      await page.click('#deleteBtn');
      await idle();
    }
    // the details were found on the model as it lay: turning it puts them out of place, so the actions go
    check(!(await page.locator('#removeAllBtn').isDisabled()), 'the found details are still on offer after the removing spots are deleted');
    await page.click('[data-fix="rotZ"]');
    await idle();
    check((await page.locator('#removeAllBtn').isDisabled()) && /model changed/.test(await page.locator('#detailsSummary').innerText()), 'turning the model drops the found details', (await page.locator('#detailsSummary').innerText()).slice(0, 100));
    await page.click('#undoBtn');
    await idle();
    await page.click('#itemList li:first-child');
    await idle();
  }

  console.log('\nsplit a model for a small printer');
  {
    const splitOut = path.join(out, 'split');
    fs.mkdirSync(splitOut, { recursive: true });
    /** Download the pieces as one zip and unpack it into e2e/out/split: each STL inspected (and its file kept), each text read. */
    const downloadZip = async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
      const name = dl.suggestedFilename();
      const file = path.join(splitOut, name);
      await dl.saveAs(file);
      await idle();
      const entries = {};
      for (const [entry, bytes] of Object.entries(unzipSync(new Uint8Array(fs.readFileSync(file))))) {
        const target = path.join(splitOut, entry);
        fs.writeFileSync(target, bytes);
        entries[entry] = entry.endsWith('.stl') ? { ...inspectStl(target), file: target } : strFromU8(bytes);
      }
      return { name, entries };
    };
    /** How many separate bodies an STL file holds. */
    const shellCount = (file) => {
      const buf = fs.readFileSync(file);
      const m = geometryToManifold(parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
      const shells = m.decompose();
      shells.forEach((s) => s.delete());
      m.delete();
      return shells.length;
    };
    /** Strongly coloured pixels in the view by hue: cool (the blue piece) and warm (the orchid one next to it). */
    const pieceHues = () =>
      page.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let cool = 0;
        let warm = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, g, b);
          const span = max - Math.min(r, g, b);
          // shading means the exact colours never reach the screen, so go by hue; greys (the grid, the pins) don't count
          if (span < 64) continue;
          const h = ((max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4) * 60 + 360) % 360;
          if (h >= 190 && h <= 250) cool++;
          else if ((h >= 300 && h <= 345) || (h >= 8 && h <= 50)) warm++;
        }
        return { cool, warm };
      });

    /** Pixels of the view in the amber of unrepaired triangles (lit, so by hue; not the salmon or khaki pieces). */
    const amberPixels = () =>
      page.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, g, b);
          const span = max - Math.min(r, g, b);
          if (max < 60 || span < 0.5 * max) continue; // dark or greyish
          const h = ((max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4) * 60 + 360) % 360;
          if (h >= 32 && h <= 48 && r > b + 80) n++;
        }
        return n;
      });

    /** A point on a cut's handle in the view: a pixel in the cuts' violet where the pointer gets the grab cursor, or null. */
    const findHandle = async () => {
      const violet = await page.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const rect = c.getBoundingClientRect();
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const found = [];
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 2) {
            const i = (y * c.width + x) * 4;
            // the handle is unlit: exactly the cut colour, or its lighter hover colour
            const off = Math.min(Math.abs(d[i] - 139) + Math.abs(d[i + 1] - 92) + Math.abs(d[i + 2] - 246), Math.abs(d[i] - 167) + Math.abs(d[i + 1] - 139) + Math.abs(d[i + 2] - 250));
            if (off < 40) found.push([rect.left + (x * rect.width) / c.width, rect.top + (y * rect.height) / c.height, off]);
          }
        }
        return found.sort((p, q) => p[2] - q[2]);
      });
      const tried = [];
      for (const [x, y] of violet) {
        if (tried.some(([a, b]) => Math.hypot(a - x, b - y) < 12)) continue;
        tried.push([x, y]);
        if (tried.length > 150) break;
        await page.mouse.move(x, y);
        await page.waitForTimeout(40);
        if ((await page.evaluate(() => document.querySelector('#stage canvas').style.cursor)) === 'grab') return [x, y];
      }
      return null;
    };
    /** The split card's notes, one line. */
    const splitNotes = async () => (await page.locator('#splitNotes li').allInnerTexts()).join(' / ');
    /** What the model's "bigger than your printer" note offers once Fit's plan for it is in ("Split to fit" until then). */
    const offered = async () => {
      await page.waitForFunction(() => /^Split into \d+ pieces$/.test(document.querySelector('#modelNotes button')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => null);
      return (await page.locator('#modelNotes button').allInnerTexts()).join();
    };
    /** Wait for the cuts to be measured again: that waits for the edits to pause (a second for text). */
    const measured = async () => {
      await idle();
      await page.waitForTimeout(1400);
      await idle();
    };
    /** The cut row's axis (0, 1, 2) and position. */
    const cutState = async (n = 0) => [
      Number(await page.locator(`#cutList li >> nth=${n} >> input[data-cut-axis]:checked`).getAttribute('value')),
      await page.inputValue(`#cutList li >> nth=${n} >> input[data-cut-at]`),
    ];
    /** A fit test downloaded: its status line and how many separate bodies it holds, with their sizes. */
    const fitTest = async (name) => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }).catch(() => null), page.click('#splitFitTestBtn')]);
      if (!dl) return { status: await status(), shells: [] }; // nothing saved: the status line says why
      const file = path.join(splitOut, name);
      await dl.saveAs(file);
      await idle();
      const buf = fs.readFileSync(file);
      const m = geometryToManifold(parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
      const shells = m.decompose().map((x) => {
        const b = x.boundingBox();
        x.delete();
        return [0, 1, 2].map((a) => b.max[a] - b.min[a]).sort((p, q) => p - q);
      });
      m.delete();
      return { status: await status(), shells };
    };

    await setText(''); // nothing raised on the bar, so the planned cut is not pulled away from the middle
    // the model before this one fits the printer: Fit says so, for that model only
    await page.click('#splitFitBtn');
    await idle();
    check(/already fits your printer/.test(await splitNotes()), 'Fit to my printer on a model that fits says so', await splitNotes());

    // a model that couldn't be repaired at all can't be split, so its download doesn't send you to step 6
    const sheetFile = path.join(splitOut, 'sheet.stl');
    {
      const tri = Buffer.alloc(84 + 50);
      tri.writeUInt32LE(1, 80);
      [0, 0, 1, -200, -20, 0, 200, -20, 0, 0, 20, 0].forEach((v, i) => tri.writeFloatLE(v, 84 + i * 4)); // one 400 mm triangle
      fs.writeFileSync(sheetFile, tri);
    }
    await openStl(sheetFile, 'sheet');
    check(!/already fits/.test(await splitNotes()), 'loading another model drops the "already fits" note', await splitNotes());
    check(/needs a solid model/.test(await page.locator('#splitHint').innerText()) && (await page.isDisabled('#splitFitBtn')), 'a model that could not be repaired cannot be split', await page.locator('#splitHint').innerText());
    await download('sheet-whole.stl');
    check(/^Downloaded/.test(await status()) && !/Split for printing/.test(await status()), 'and its download does not point to step 6', (await status()).replace(/\n/g, ' | '));

    // a bar longer than the default 220 mm bed, centred so the cut positions are world x
    const longBar = Manifold.cube([300, 40, 20], true);
    const longBarFile = writeFixture('long-bar.stl', soupOf(longBar));
    longBar.delete();
    await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
    await openStl(longBarFile, 'long-bar');
    check(/won't fit your 220 × 220 mm bed/.test(await page.locator('#toastText').innerText()) && !(await page.locator('#toast').isHidden()), 'loading a model too big for the printer says so in a toast', await page.locator('#toastText').innerText());
    await page.evaluate(() => (document.querySelector('#bedPreset').closest('details').open = true));
    await page.selectOption('#bedPreset', 'generic');
    await idle();
    const whole = await download('long-bar-whole.stl');
    check(Math.abs(whole.volume - 240000) < 1 && /use Split for printing \(step 6\)\.$/.test(await status()), 'the whole bar still downloads as one STL, with a pointer to step 6', (await status()).split('\n').pop());
    const tooBig = (await page.locator('#modelNotes li').allInnerTexts()).find((t) => /bigger than/.test(t)) ?? '';
    check(/bigger than your 220 × 220 × 250 mm printer/.test(tooBig), 'the model notes say it is bigger than the printer', tooBig.replace(/\s+/g, ' '));

    const barOffer = await offered();
    check(barOffer === 'Split into 2 pieces', 'the note offers to split it into 2 pieces', barOffer);
    await page.click('#modelNotes button');
    await idle();
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const cutAt = Number(await page.inputValue('#cutList input[data-cut-at]'));
    check((await page.locator('#cutList li').count()) === 1 && Math.abs(cutAt) < 0.01, '"Split into 2 pieces" makes one cut across the middle', `${await page.locator('#cutList li').count()} cut at ${cutAt}`);
    const rows = await page.locator('#pieceList li').allInnerTexts();
    check(rows.length === 2 && rows.every((r) => /fits/.test(r)), 'two pieces, both fitting the printer', rows.join(' / '));
    check((await page.locator('#downloadBtn').innerText()) === 'Download 2 pieces (.zip)', 'the download button counts the pieces', await page.locator('#downloadBtn').innerText());
    const labelLines = await page.evaluate(() => {
      const btn = document.querySelector('#downloadBtn');
      const range = document.createRange();
      range.selectNodeContents(btn);
      return { lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size, fits: btn.scrollWidth <= btn.clientWidth };
    });
    check(labelLines.lines === 1 && labelLines.fits, 'its label fits on one line', JSON.stringify(labelLines));
    check(await page.isChecked('#resultToggle'), 'the pieces are shown');
    await page.screenshot({ path: path.join(out, '8-split.png') });
    const { cool, warm } = await pieceHues();
    check(cool > 500 && warm > 500, 'the pieces are drawn in contrasting colours', `${cool} cool / ${warm} warm pixels`);

    const zip = await downloadZip();
    check(zip.name === 'long-bar-text-2-pieces.zip', 'one zip named after its pieces', zip.name);
    const names = Object.keys(zip.entries).sort();
    check(
      names.join() === 'long-bar-text-how-to-glue.txt,long-bar-text-piece-1-of-2.stl,long-bar-text-piece-2-of-2.stl,long-bar-text-pins-3x-6x19mm.stl',
      'the zip holds the two pieces, a sheet of pins and the glue sheet',
      names.join(', '),
    );
    const pieces = names.filter((n) => /piece-\d+-of-2\.stl$/.test(n)).map((n) => zip.entries[n]);
    const extent = (s, a) => s.max[a] - s.min[a];
    check(
      pieces.length === 2 && pieces.every((s) => s.volume !== null && s.sizeOk && Math.abs(s.min[2]) < 0.01 && extent(s, 0) <= 210.01 && extent(s, 1) <= 210.01 && extent(s, 2) <= 249.01),
      'each piece is a watertight STL on the build plate that fits the bed less its margins (210 × 210 × 249 mm)',
      pieces.map((s) => [0, 1, 2].map((a) => extent(s, a).toFixed(1)).join(' × ')).join(' / '),
    );
    check(pieces.every((s) => Math.abs(extent(s, 2) - 20) < 0.01), 'the pieces of a bar lie flat, 20 mm high');
    // two Ø6 teardrop holes (372.7 mm³ each) in each cut face, plus two labels engraved 0.6 mm deep
    const removed = whole.volume - pieces.reduce((sum, s) => sum + (s.volume ?? 0), 0);
    check(removed >= 4 * 372.7 && removed <= 4 * 372.7 + 150, 'the pieces add up to the bar less the pin holes and labels', `${removed.toFixed(1)} mm³ removed`);
    const pins = zip.entries['long-bar-text-pins-3x-6x19mm.stl'];
    const pinCount = pins ? shellCount(pins.file) : 0;
    check(pinCount === 3 && Math.abs(extent(pins, 2) - 5.54) < 0.05, 'the pin sheet holds 3 pins (one spare) lying on a flat', pins && `${pinCount} pins, ${extent(pins, 2).toFixed(3)} mm high`);
    check(zip.entries['long-bar-text-how-to-glue.txt']?.includes('1A ↔ 2A'), 'the glue sheet pairs the matching labels');
    check(/^Downloaded long-bar-text-2-pieces\.zip .*: 2 pieces, 3 pins/.test(await status()), 'the status line says what the zip holds', await status());

    // Joints: Built-in pegs – square pegs printed on one piece fit sockets in the other, so there is no pins file
    await page.click('#splitSettings label:has(input[data-split="joint"][value="pegs"])');
    await idle();
    const pegControls = await page.evaluate(() => ({
      pins: [...document.querySelectorAll('[data-split="pins"]')].map((e) => e.disabled && !e.checked),
      on: ['diameter', 'depth', 'count', 'clearance', 'labels'].map((k) => !document.querySelector(`[data-split="${k}"]`).disabled),
      names: [...document.querySelectorAll('#splitSettings [data-peg-label]')].map((e) => e.textContent).join(', '),
      filament: document.querySelector('[data-split="diameter"] option[value="1.75"]').hidden,
    }));
    check(
      pegControls.pins.every(Boolean) && pegControls.on.every(Boolean) && pegControls.filament && pegControls.names === 'Peg size, Peg length, Pegs per face',
      'Built-in pegs turns the pins choice off and the size, length and count over to the pegs, without filament',
      JSON.stringify(pegControls),
    );
    await page.waitForFunction(() => /sockets/.test(document.querySelector('#pieceList').innerText) && !document.querySelector('#pieceList').classList.contains('stale'), null, { timeout: 60000 });
    await measured();
    const pegRows = await page.locator('#pieceList li').allInnerTexts();
    check(
      /^1 · 159 × 40 × 20 mm · .* · 2 pegs$/.test(pegRows[0]) && /^2 · 150 × 40 × 20 mm · .* · 2 sockets$/.test(pegRows[1]),
      'piece 1 carries the pegs, its size counting how far they stand out, and piece 2 has their sockets',
      pegRows.join(' / '),
    );
    check(/· pegs$/.test(await page.locator('#cutList .meta').innerText()), "the cut's row says it has pegs", await page.locator('#cutList .meta').innerText());
    check((await page.locator('[data-split="diameter"] option[value="0"]').innerText()) === 'Auto (6 mm)', 'the size control shows the peg size Auto picked', await page.locator('[data-split="diameter"] option[value="0"]').innerText());
    check(/^Cut into 2 pieces joined by \d+ built-in pegs \(\d+ mm square\)/.test(await splitNotes()), 'the summary says the pieces are joined by built-in pegs', await splitNotes());
    await page.screenshot({ path: path.join(out, '8-split-pegs.png') });
    // five joints share a row: on a panel narrowed by a scroll bar a long name wraps, and the row stays in the card
    const jointsFit = await page.evaluate(async () => {
      const panel = document.querySelector('.panel');
      const seg = document.querySelector('#splitSettings fieldset.joints');
      // the control inside the card (a fieldset is never narrower than its content: it would stick out instead), every
      // name inside its own segment and every segment inside the control
      const fits = () => {
        const box = seg.getBoundingClientRect();
        if (box.right > seg.parentElement.getBoundingClientRect().right + 0.5) return false;
        return [...seg.querySelectorAll('label')].every((l) => {
          const r = l.getBoundingClientRect();
          const name = l.querySelector('span');
          return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && name.scrollWidth <= name.clientWidth;
        });
      };
      const wide = fits();
      panel.style.paddingRight = '34px';
      await new Promise((done) => requestAnimationFrame(done));
      const narrow = fits();
      panel.style.paddingRight = '';
      return { wide, narrow, height: seg.getBoundingClientRect().height };
    });
    check(jointsFit.wide && jointsFit.narrow, 'the five joints fit the card, a long name wrapping on a narrower panel', JSON.stringify(jointsFit));
    await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
    const pegZip = await downloadZip();
    const pegNames = Object.keys(pegZip.entries).sort();
    check(
      pegNames.join() === 'long-bar-text-how-to-glue.txt,long-bar-text-piece-1-of-2.stl,long-bar-text-piece-2-of-2.stl',
      'the zip holds the two pieces and the glue sheet, and no pins',
      pegNames.join(', '),
    );
    const [pegged, socketed] = ['long-bar-text-piece-1-of-2.stl', 'long-bar-text-piece-2-of-2.stl'].map((n) => pegZip.entries[n]);
    check(
      pegged?.volume > 120000 && socketed?.volume < 120000 && pegged.sizeOk && socketed.sizeOk && Math.abs(Math.max(extent(pegged, 0), extent(pegged, 1)) - 159) < 0.01,
      'piece 1 is half the bar and its pegs, piece 2 half the bar less their sockets',
      `${pegged?.volume?.toFixed(1)} / ${socketed?.volume?.toFixed(1)} mm³`,
    );
    check(/push piece 1's pegs \(1A\) in/.test(pegZip.entries['long-bar-text-how-to-glue.txt'] ?? ''), 'the glue sheet says to push piece 1\'s pegs in');
    check(/^Downloaded long-bar-text-2-pieces\.zip .*: 2 pieces and how-to-glue\.txt\./.test(await status()), 'the status line counts no pins', await status());
    await page.waitForTimeout(1000);
    const pegTest = await fitTest('long-bar-pegs-fit-test.stl');
    check(/the 6 mm peg pushes into its socket/.test(pegTest.status) && pegTest.shells.length === 2, 'the fit test is a block with a 6 mm peg and one with its socket', `${pegTest.shells.length} bodies | ${pegTest.status}`);
    // 10 mm pegs don't fit the bar's 20 mm thickness: the cut takes smaller ones, and its note selects it
    await page.selectOption('[data-split="diameter"]', '10');
    await page.waitForFunction(() => /too narrow for 10 mm pegs/.test(document.querySelector('#splitNotes').innerText), null, { timeout: 60000 });
    await idle();
    const smallerNote = page.locator('#splitNotes li', { hasText: 'too narrow for 10 mm pegs' });
    check(/^Cut A is too narrow for 10 mm pegs – it takes \d+ × \d+ mm pegs? instead\.$/.test(await smallerNote.locator('.text').innerText()), 'pegs too big for a face come smaller there, and the note says so', await smallerNote.locator('.text').innerText());
    await smallerNote.locator('button').click();
    check((await page.locator('#cutList li.selected').count()) === 1, 'its button selects the cut', await smallerNote.locator('button').innerText());
    await page.keyboard.press('Escape');
    // the fit test is of the pegs the pieces have, not of the size no face took
    await page.waitForTimeout(1000);
    const smallerTest = await fitTest('long-bar-pegs-10-fit-test.stl');
    check(
      /the 6 mm peg pushes into its socket/.test(smallerTest.status) && JSON.stringify(smallerTest.shells) === JSON.stringify(pegTest.shells),
      'asked for 10 mm pegs the bar takes 6 mm ones, and so does its fit test',
      smallerTest.status,
    );
    await page.selectOption('[data-split="diameter"]', '0');
    await idle();
    // the boxes either side of the cut count a peg's length on the one that will carry them, the piece below the cut
    // where both fit, and a longer peg makes it longer once the cut is measured again
    const setPegLength = async (v) => {
      await page.evaluate((value) => {
        const el = document.querySelector('[data-split="depth"]');
        el.value = value;
        el.dispatchEvent(new Event('change'));
      }, String(v));
      await measured();
    };
    await page.uncheck('#resultToggle');
    await idle();
    await setPegLength(20);
    const pegBoxes = await page.locator('#pieceList li.predicted').allInnerTexts();
    check(
      pegBoxes.length === 2 && /^1 · 170 × 40 × 20 mm · fits/.test(pegBoxes[0]) && /^2 · 150 × 40 × 20 mm · fits/.test(pegBoxes[1]),
      'a 20 mm peg length makes the box that carries the pegs 20 mm longer, and only that one',
      pegBoxes.join(' / '),
    );
    // with no cuts, the model's note counts from its box the pieces a split takes, a peg's length for every cut: on a
    // printer so small that a piece carrying 30 mm pegs has no room left for itself (39 mm tall at most) no split will
    // do, and none is offered, where Auto's pegs leave room
    const offerOnNote = async () => ({
      note: (await page.locator('#modelNotes li').allInnerTexts()).some((t) => /bigger than your 60 × 60 × 40 mm printer/.test(t)),
      offers: await page.locator('#modelNotes button').count(),
    });
    await setPegLength(0);
    await page.evaluate(() => (document.querySelector('#bedPreset').closest('details').open = true));
    for (const [id, v] of [['bedX', '60'], ['bedY', '60'], ['bedZ', '40']]) {
      await page.fill(`#${id}`, v);
      await page.dispatchEvent(`#${id}`, 'change');
    }
    await idle();
    await page.click('#splitClearBtn');
    await idle();
    const autoPegs = await offerOnNote();
    await page.click('#undoBtn');
    await idle();
    await setPegLength(30);
    await page.click('#splitClearBtn');
    await idle();
    const longPegs = await offerOnNote();
    check(
      autoPegs.note && autoPegs.offers === 1 && longPegs.note && longPegs.offers === 0,
      'on a tiny printer the model is offered a split with Auto pegs, and none with 30 mm pegs that leave no room',
      JSON.stringify({ autoPegs, longPegs }),
    );
    await page.click('#undoBtn');
    await idle();
    await setPegLength(0);
    await page.selectOption('#bedPreset', 'generic');
    await idle();
    // filament makes no peg: 1.75 mm set for pins reads as the smallest peg, 3 mm, while Built-in pegs is chosen
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await page.selectOption('[data-split="diameter"]', '1.75');
    await page.click('#splitSettings label:has(input[data-split="joint"][value="pegs"])');
    await idle();
    const asPeg = await page.inputValue('[data-split="diameter"]');
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await idle();
    const asPin = await page.inputValue('[data-split="diameter"]');
    check(asPeg === '3' && asPin === '1.75', 'a 1.75 mm filament size shows as 3 mm pegs, and as filament again for pins', `${asPeg} / ${asPin}`);
    await page.selectOption('[data-split="diameter"]', '0');
    await idle();
    await page.check('#resultToggle');
    await idle();
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await idle();
    check(!(await page.isDisabled('[data-split="pins"][value="print"]')) && (await page.isChecked('[data-split="pins"][value="print"]')), 'back on Auto, the pins are printed again', '');

    // on a bigger printer the bar fits whole: Fit to my printer takes the cut away again, as one undo step
    await page.selectOption('#bedPreset', 'coreonel');
    await idle();
    await page.waitForFunction(() => !document.querySelector('#pieceList').classList.contains('stale'), null, { timeout: 60000 });
    await idle();
    check(/^Cut into 2 pieces/.test(await status()), 'the status line sums up the pieces', (await status()).split('\n')[0]);
    await page.click('#splitFitBtn');
    await idle();
    await page.waitForTimeout(400); // the result of the whole bar, which says nothing
    await idle();
    const fitsWhole = { cuts: await page.locator('#cutList li').count(), notes: await splitNotes(), label: await page.locator('#downloadBtn').innerText() };
    check(
      fitsWhole.cuts === 0 && /already fits your printer/.test(fitsWhole.notes) && fitsWhole.label === 'Download STL',
      'Fit to my printer on a bigger printer takes the cut away: the bar fits whole',
      JSON.stringify(fitsWhole),
    );
    check(!/Cut into|Glue matching/.test(await status()), 'and the status line no longer describes pieces', (await status()).replace(/\n/g, ' | '));
    await page.click('#undoBtn');
    await idle();
    check(
      (await page.locator('#cutList li').count()) === 1 && Math.abs(Number(await page.inputValue('#cutList input[data-cut-at]'))) < 0.01,
      'one Undo brings the cut back',
      `${await page.locator('#cutList li').count()} cuts`,
    );
    await page.selectOption('#bedPreset', 'generic');
    await idle();

    await page.fill('#cutList input[data-cut-at]', '40');
    await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
    await idle();
    // the old pieces stay listed (dimmed) until the new ones arrive
    await page.waitForFunction(() => /190/.test(document.querySelector('#pieceList').innerText) && !document.querySelector('#pieceList').classList.contains('stale'), null, { timeout: 60000 });
    await idle();
    const moved = (await page.locator('#pieceList li').allInnerTexts()).join(' / ');
    check(/190 × 40 × 20 mm/.test(moved) && /110 × 40 × 20 mm/.test(moved), 'typing a new position moves the cut: the pieces become 190 and 110 mm', moved);
    await page.locator('#splitCard').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, '8-split-card.png') });

    // new text takes the pieces down: the card goes back to the boxes between the cuts, at once
    await page.click('#itemList li:first-child');
    await idle();
    await page.click('[data-side="top"]');
    await idle();
    await page.fill('#lineList .line-text >> nth=0', 'O');
    await page.waitForTimeout(150);
    const boxes = await page.locator('#pieceList li.predicted').count();
    check(
      !(await page.isChecked('#resultToggle')) && boxes === 2 && (await page.locator('#pieceList li').count()) === 2 && !(await page.locator('#piecesHint').isHidden()),
      'editing the text puts the boxes between the cuts and "Show the pieces" back in the card',
      `${boxes} boxes, hint ${(await page.locator('#piecesHint').isHidden()) ? 'hidden' : 'shown'}`,
    );
    await page.dispatchEvent('#lineList .line-text >> nth=0', 'change');
    // the cut rows follow the text: which cut runs through it
    await page.evaluate(() => (document.querySelector('#posX').closest('details').open = true));
    await page.fill('#posX', '40');
    await page.dispatchEvent('#posX', 'change');
    await measured();
    check(/through “O”/.test(await page.locator('#cutList .meta').innerText()), 'moving the text onto a cut names it in the cut\'s row', await page.locator('#cutList .meta').innerText());
    // the measure after a text edit is cheap: it never builds the final result, which would hold up the next keystroke's preview
    const lastMeasure = await page.evaluate(() => [...window.__engine.measures.values()].filter(Boolean).at(-1));
    check(lastMeasure?.estimate === true, 'the cuts are measured after a text edit without building the final result', JSON.stringify(lastMeasure));
    await page.fill('#posX', '0');
    await page.dispatchEvent('#posX', 'change');
    await measured();
    check(!/through/.test(await page.locator('#cutList .meta').innerText()), 'and moving it off drops it', await page.locator('#cutList .meta').innerText());

    // pressing the row anywhere selects the cut for the arrow keys, its axis segment included
    await page.click('#cutList li:first-child .seg label:has-text("X")');
    await page.keyboard.press('ArrowRight');
    await idle();
    check(JSON.stringify(await cutState()) === '[0,"41"]', 'a cut selected by its axis segment moves with the arrow keys', JSON.stringify(await cutState()));
    await page.keyboard.press('Control+z');
    await idle();
    check(JSON.stringify(await cutState()) === '[0,"40"]', 'and Ctrl+Z undoes the move', JSON.stringify(await cutState()));
    await page.click('#cutList li:first-child .seg label:has-text("Y")');
    await idle();
    check((await cutState())[0] === 1, 'clicking another axis still turns the cut', JSON.stringify(await cutState()));
    await page.keyboard.press('Control+z');
    await idle();
    check(JSON.stringify(await cutState()) === '[0,"40"]', 'and Ctrl+Z turns it back', JSON.stringify(await cutState()));
    // a position box left empty shows where the cut is again
    await page.fill('#cutList input[data-cut-at]', '');
    await page.keyboard.press('Tab');
    await idle();
    check((await page.inputValue('#cutList input[data-cut-at]')) === '40', 'a cut position cleared and left shows the position again', JSON.stringify(await page.inputValue('#cutList input[data-cut-at]')));

    // the fit test is made from the split as it stands: the pin size Auto picks for a 20 mm bar
    await page.waitForTimeout(1000);
    const pinTest = await fitTest('long-bar-fit-test.stl');
    const pinShell = pinTest.shells.filter((e) => Math.abs(e[0] - 5.54) < 0.05 && Math.abs(e[1] - 5.54) < 0.05);
    check(/the Ø6 mm pin slides into both holes/.test(pinTest.status) && !/tab/.test(pinTest.status) && pinShell.length === 1, 'the fit test has the Ø6 pin the pieces use, not a Ø5 one', `${pinTest.shells.map((e) => e.map((v) => v.toFixed(1)).join('×')).join(', ')} | ${pinTest.status}`);
    // Glue only: nothing is drilled or engraved, so what is about holes and labels is off
    await page.click('#splitSettings label:has(input[data-split="joint"][value="none"])');
    await idle();
    const glueOff = await page.evaluate(() => ['labels', 'clearance', 'diameter'].map((k) => document.querySelector(`[data-split="${k}"]`).disabled).concat(document.querySelector('#splitFitTestBtn').disabled));
    check(glueOff.every(Boolean), 'Glue only turns off the labels, the clearance and the fit test', String(glueOff));
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await idle();
    await page.click('#itemList li:first-child');
    await idle();
    await setText(''); // the bar alone again, for the download without the split

    await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
    await page.click('#splitClearBtn');
    await idle();
    check((await page.locator('#cutList li').count()) === 0 && (await page.locator('#downloadBtn').innerText()) === 'Download STL', '"Remove split" takes the cuts away');
    const again = await download('long-bar-unsplit.stl');
    check(Math.abs(again.volume - 240000) < 1 && again.sizeOk, 'without the split the bar downloads whole again', `${again.volume?.toFixed(1)} mm³`);
    // typing in the cut's position box selected the cut, which let go of the text: pick the text again
    await page.click('#itemList li:first-child');
    await idle();

    // a fit still being planned when another model is opened was for the model before: the new one gets none of it
    const ell = Manifold.union(Manifold.cube([300, 40, 10]), Manifold.cube([40, 300, 10]));
    const ellFile = writeFixture('ell.stl', soupOf(ell));
    ell.delete();
    await page.evaluate(() => (window.__engine.hold = true));
    await page.click('#splitFitBtn');
    await page.waitForFunction(() => window.__engine.held.length > 0, null, { timeout: 60000 });
    await page.setInputFiles('#stlFile', ellFile);
    await page.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('ell:'), null, { timeout: 60000 });
    await releasePlans();
    await idle();
    const raced = { cuts: await page.locator('#cutList li').count(), shown: await page.isChecked('#resultToggle'), label: await page.locator('#downloadBtn').innerText() };
    check(
      raced.cuts === 0 && !raced.shown && raced.label === 'Download STL',
      'a fit planned for the model before is not put on one opened while it ran',
      JSON.stringify(raced),
    );
    // the box round an L is four boxes on this bed, but the corner one holds nothing: the note offers the pieces Fit makes
    const ellOffer = await offered();
    check(ellOffer === 'Split into 3 pieces', 'an L is offered the 3 pieces Fit makes of it, not the 4 boxes round it', ellOffer);

    // an L-shape cut into four boxes leaves the corner one empty: three pieces, before they are worked out too
    await page.click('#addCutBtn');
    await idle();
    await page.click('#addCutBtn');
    await measured();
    const ellRows = await page.locator('#pieceList li.predicted').allInnerTexts();
    check(
      (await page.locator('#downloadBtn').innerText()) === 'Download 3 pieces (.zip)' && ellRows.length === 3,
      'an L cut into four boxes counts the three with something in them',
      `${await page.locator('#downloadBtn').innerText()} / ${ellRows.join(' / ')}`,
    );

    // the toast's Undo takes back the removal it names, and goes once something else is changed (its Undo would take that back instead)
    const cutCount = () => page.locator('#cutList li').count();
    await page.click('#cutList li:nth-child(2) .cut-remove');
    await idle();
    check(/Removed cut B/.test(await page.locator('#toastText').innerText()) && !(await page.locator('#toast').isHidden()), 'removing a cut offers to undo it in a toast');
    await page.click('#toastAction');
    await idle();
    check((await cutCount()) === 2, "the toast's Undo brings the cut back", `${await cutCount()} cuts`);
    await page.click('#cutList li:nth-child(2) .cut-remove');
    await idle();
    const atBefore = await page.inputValue('#cutList input[data-cut-at]');
    await page.click('#cutList li:first-child .badge');
    await page.keyboard.press('ArrowRight');
    await idle();
    check(
      (await page.locator('#toast').isHidden()) && (await page.inputValue('#cutList input[data-cut-at]')) !== atBefore,
      'moving the other cut takes the "Removed cut B" toast away',
      `toast ${(await page.locator('#toast').isHidden()) ? 'hidden' : `shown: ${await page.locator('#toastText').innerText()}`}`,
    );
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await idle();
    check((await cutCount()) === 2 && (await page.inputValue('#cutList input[data-cut-at]')) === atBefore, 'and Ctrl+Z twice undoes the move, then the removal', `${await cutCount()} cuts`);
    await page.click('#splitClearBtn');
    await idle();

    // a solid cube cut in three every way has a box in its middle that no surface reaches: it is a piece all the same
    const cube = Manifold.cube([60, 60, 60], true);
    const cubeFile = writeFixture('cube.stl', soupOf(cube));
    cube.delete();
    await openStl(cubeFile, 'cube');
    for (let i = 0; i < 6; i++) {
      await page.click('#addCutBtn');
      await idle();
    }
    await measured();
    const cubeRows = await page.locator('#pieceList li.predicted').count();
    check(
      (await page.locator('#downloadBtn').innerText()) === 'Download 27 pieces (.zip)' && cubeRows === 27,
      'a cube cut in three every way counts its middle box too: 27 pieces',
      `${await page.locator('#downloadBtn').innerText()} / ${cubeRows} boxes`,
    );
    await page.click('#splitClearBtn');
    await idle();

    // a model with unrepaired triangles (two open sheets over a bar) keeps them amber in the coloured preview of the pieces
    const amberBar = Manifold.cube([160, 40, 10], true);
    const sheets = [];
    for (const x0 of [-75, 35]) sheets.push(x0, -15, 7, x0 + 40, -15, 7, x0 + 40, 15, 7, x0, -15, 7, x0 + 40, 15, 7, x0, 15, 7);
    const amberFile = writeFixture('unrepaired.stl', new Float32Array([...soupOf(amberBar), ...sheets]));
    amberBar.delete();
    await openStl(amberFile, 'unrepaired');
    const amberWhole = await amberPixels();
    await page.click('#addCutBtn');
    await idle();
    await page.keyboard.press('Escape'); // let go of the cut: only its plane stays on screen
    await idle();
    const amberCut = await amberPixels();
    await page.screenshot({ path: path.join(out, '8-split-unrepaired.png') });
    check(
      !(await page.locator('#legendPass').isHidden()) && amberWhole > 2000 && amberCut > amberWhole / 2,
      'unrepaired triangles stay amber once the model is cut',
      `${amberWhole} amber pixels whole, ${amberCut} cut`,
    );
    await page.click('#splitClearBtn');
    await idle();

    // a cone's box would take four pieces on this bed, but those would stand on a point or an edge: Fit makes more, each
    // standing on a cut face, and the model's note offers what Fit makes – and no number at all while the plan is not in
    const cone = Manifold.cylinder(260, 110, 0, 48);
    const coneFile = writeFixture('cone.stl', soupOf(cone));
    cone.delete();
    await page.evaluate(() => (window.__engine.hold = true));
    await page.setInputFiles('#stlFile', coneFile);
    await page.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('cone:'), null, { timeout: 60000 });
    await page.waitForFunction(() => window.__engine.held.length > 0, null, { timeout: 60000 }).catch(() => null); // the plan is asked a moment after
    const coneUnknown = (await page.locator('#modelNotes button').allInnerTexts()).join();
    await releasePlans();
    await idle();
    const coneOffer = await offered();
    await page.click('#modelNotes button');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const conePieces = await page.locator('#pieceList li').count();
    check(
      coneUnknown === 'Split to fit' && coneOffer === `Split into ${conePieces} pieces` && conePieces > 4,
      'a cone is offered no number until Fit has planned it, then the pieces Fit makes, not the 4 of its box',
      `"${coneUnknown}", then "${coneOffer}"; Fit made ${conePieces}`,
    );
    await page.click('#splitClearBtn');
    await idle();
    const coneAgain = (await page.locator('#modelNotes button').allInnerTexts()).join();
    check(coneAgain === coneOffer, 'with the split removed the note offers those pieces again at once', coneAgain);
    // retyping the text plans nothing ahead: a plan builds the whole result, which the next keystroke's preview would wait for
    await page.click('#itemList li:first-child');
    await idle();
    const plansBefore = await page.evaluate(() => window.__engine.fits.size);
    await setText('Hi');
    await page.waitForTimeout(2000);
    await idle();
    const retyped = { plans: (await page.evaluate(() => window.__engine.fits.size)) - plansBefore, offer: (await page.locator('#modelNotes button').allInnerTexts()).join() };
    check(retyped.plans === 0 && retyped.offer === 'Split to fit', 'retyping the text starts no plan: the note offers "Split to fit" until clicked', JSON.stringify(retyped));
    await setText('');

    // a taller cone: Fit moves its cuts off the axis, which leaves the boxes round its tip empty though its long sides
    // span them. The note offers the pieces the cuts make, not the boxes
    const spire = Manifold.cylinder(320, 120, 0, 96);
    const spireFile = writeFixture('spire.stl', soupOf(spire));
    spire.delete();
    await openStl(spireFile, 'spire');
    const spireOffer = await offered();
    await page.click('#modelNotes button');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const spirePieces = await page.locator('#pieceList li').count();
    check(
      spireOffer === `Split into ${spirePieces} pieces` && (await page.locator('#downloadBtn').innerText()) === `Download ${spirePieces} pieces (.zip)`,
      'a cone whose cuts leave the boxes round its tip empty is offered the pieces Fit makes, not the boxes its sides span',
      `offered "${spireOffer}", Fit made ${spirePieces}`,
    );
    await page.click('#splitClearBtn');
    await idle();

    // a bookcase lying on its back: the middle box's shelves would be held over the bed, so they print as a piece of
    // their own. The offer, the download button and the zip all count it, before the pieces are worked out too
    const bookcase = Manifold.union([
      Manifold.cube([600, 200, 15]), Manifold.cube([600, 200, 15]).translate([0, 0, 110]), Manifold.cube([600, 200, 15]).translate([0, 0, 225]),
      Manifold.cube([15, 200, 240]), Manifold.cube([15, 200, 240]).translate([585, 0, 0]),
    ]);
    const bookcaseFile = writeFixture('bookcase.stl', soupOf(bookcase));
    bookcase.delete();
    await openStl(bookcaseFile, 'bookcase');
    const shelfOffer = await offered();
    await page.click('#modelNotes button');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const shelfPieces = await page.locator('#pieceList li').count();
    check(shelfOffer === 'Split into 4 pieces' && shelfPieces === 4, 'a bookcase on its back is offered the 4 pieces Fit makes, its loose shelves counted', `offered "${shelfOffer}", Fit made ${shelfPieces}`);
    await page.uncheck('#resultToggle');
    await idle();
    const shelfAt = Number.parseFloat(await page.inputValue('#cutList li:first-child input[data-cut-at]'));
    await page.fill('#cutList li:first-child input[data-cut-at]', String(shelfAt + 2));
    await page.press('#cutList li:first-child input[data-cut-at]', 'Tab');
    await measured();
    const shelfRows = await page.locator('#pieceList li.predicted').allInnerTexts();
    const shelfLabel = await page.locator('#downloadBtn').innerText();
    check(
      shelfLabel === 'Download 4 pieces (.zip)' && shelfRows.length === 3 && shelfRows.filter((r) => /prints as 2 pieces/.test(r)).length === 1,
      'with a cut moved and the pieces not shown, the download button counts the shelves that print apart, and their box says so',
      `${shelfLabel} / ${shelfRows.join(' / ')}`,
    );
    const shelfZip = await downloadZip();
    const shelfFiles = Object.keys(shelfZip.entries).filter((e) => /-piece-\d+-of-\d+\.stl$/.test(e));
    check(
      shelfFiles.length === 4 && shelfFiles.every((e) => /-of-4\.stl$/.test(e)) && (await page.locator('#downloadBtn').innerText()) === 'Download 4 pieces (.zip)',
      'and the zip holds those 4 pieces, the button still saying so after the download',
      `${shelfZip.name}: ${shelfFiles.join(', ')} / ${await page.locator('#downloadBtn').innerText()}`,
    );
    await page.click('#splitClearBtn');
    await idle();

    // a thin sign prints lying flat, with dovetail tabs that make its pieces longer: the model's note offers as many pieces as Fit makes
    const sign = Manifold.cube([400, 100, 5], true);
    const signFile = writeFixture('sign.stl', soupOf(sign));
    sign.delete();
    await openStl(signFile, 'sign');
    const offer = await offered();
    await page.click('#modelNotes button');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const signPieces = await page.locator('#pieceList li').count();
    check(offer === `Split into ${signPieces} pieces` && signPieces === 3, 'a thin sign is offered the pieces Fit makes of it lying flat', `offered "${offer}", Fit made ${signPieces}`);
    // dragging a dovetail cut's handle: the readout gives the pieces either side as long as they come out, tabs and all,
    // so a side turns red only once its number is more than the bed takes
    const grip = await findHandle();
    const readout = { text: '', sides: [] };
    if (grip) {
      await page.mouse.move(...grip);
      await page.mouse.down();
      for (let i = 1; i <= 80 && !readout.sides.some((s) => s.red); i++) {
        await page.mouse.move(grip[0] - 4 * i, grip[1]);
        await page.waitForTimeout(30);
        const now = await page.evaluate(() => ({
          text: document.querySelector('#cutReadout').textContent,
          sides: [...document.querySelectorAll('#cutReadout span')].map((s) => ({ length: Number(s.textContent), red: s.classList.contains('err') })),
        }));
        Object.assign(readout, now);
      }
      await page.mouse.up();
      await idle();
      await page.waitForFunction(() => !document.querySelector('#pieceList').classList.contains('stale') && !document.querySelector('#pieceList li.predicted'), null, { timeout: 60000 });
      await idle();
    }
    const red = readout.sides.filter((s) => s.red);
    check(red.length > 0 && red.every((s) => s.length > 210), 'dragging a dovetail cut, the readout turns a side red only when it reads more than the 210 mm the bed takes', readout.text || 'no handle found');
    const dropped = (await page.locator('#pieceList li').allInnerTexts()).map((r) => Number(r.match(/· ([\d.]+) ×/)?.[1]));
    // its tabs are those measured before the drag, which the pieces may re-plan a tenth or two longer or shorter
    // (a readout without them is 12 mm short for each tab)
    check(
      readout.sides.length === 2 && readout.sides.every((s) => dropped.some((v) => Math.abs(v - s.length) < 0.5)),
      'and its two lengths are those of the pieces either side once the cut is dropped, tabs counted',
      `${readout.text} | pieces ${dropped.join(' / ')} mm`,
    );
    // Joints: Pins on a 5 mm sign: no pin fits through it, and once the fit test finds that the cut rows say glue only
    await page.uncheck('#resultToggle');
    await page.click('#splitSettings label:has(input[data-split="joint"][value="dowels"])');
    await measured();
    const noPinTest = await fitTest('sign-fit-test.stl');
    const signMeta = await page.locator('#cutList .meta').allInnerTexts();
    check(
      /only glue/.test(noPinTest.status) && signMeta.length === signPieces - 1 && signMeta.every((m) => /glue only/.test(m) && !/pins/.test(m)),
      'Pins on a sign no pin fits: after the fit test finds nothing to try, every cut row says glue only, not pins',
      `${signMeta.join(' / ')} | ${noPinTest.status}`,
    );
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await idle();
    await page.click('#splitClearBtn');
    await idle();

    // a tube whose wall no pin fits: once the split is worked out, for the pieces or the download, its cut row says glue only
    const tube = Manifold.cylinder(40, 30, 30, 64, true).subtract(Manifold.cylinder(42, 28, 28, 64, true));
    const tubeFile = writeFixture('tube.stl', soupOf(tube));
    tube.delete();
    await openStl(tubeFile, 'tube');
    await page.click('#addCutBtn');
    await measured();
    await page.check('#resultToggle');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const tubeMeta = await page.locator('#cutList .meta').innerText();
    check(
      /in 2 parts · glue only/.test(tubeMeta) && /No pin fits on 2 of 2 faces at cut A/.test(await splitNotes()),
      'a cut through a tube whose wall no pin fits says glue only in its row once the pieces are worked out, as its note does',
      `${tubeMeta} | ${await splitNotes()}`,
    );
    await page.uncheck('#resultToggle');
    await page.fill('#cutList input[data-cut-at]', '5');
    await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
    await measured();
    await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
    const tubeZip = await downloadZip();
    const tubeMetaAfter = await page.locator('#cutList .meta').innerText();
    check(
      /glue only/.test(tubeMetaAfter) && !Object.keys(tubeZip.entries).some((n) => /pins/.test(n)),
      'and after the cut is moved, the download of pieces with no pins file says so in the row too',
      `${tubeMetaAfter} | ${Object.keys(tubeZip.entries).join(', ')}`,
    );
    // nor does a built-in peg fit it, and the joint never falls back to pins: once the fit test finds nothing to try,
    // the row planned for pegs says glue only
    await page.click('#splitSettings label:has(input[data-split="joint"][value="pegs"])');
    await measured();
    const tubePegMeta = await page.locator('#cutList .meta').innerText();
    // nothing is saved, so no download to wait for: the status line says why
    await page.click('#splitFitTestBtn');
    await page.waitForFunction(() => /^Nothing to try/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }).catch(() => null);
    await idle();
    const tubePegStatus = await status();
    const tubePegMetaAfter = await page.locator('#cutList .meta').innerText();
    check(
      /· pegs$/.test(tubePegMeta) && tubePegStatus === 'Nothing to try: these cuts get no pegs or tabs, only glue.' && /· glue only$/.test(tubePegMetaAfter),
      'with Built-in pegs the tube has nothing to try either, and its row goes from pegs to glue only',
      `${tubePegMeta} | ${tubePegStatus} | ${tubePegMetaAfter}`,
    );
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await idle();
    await page.click('#splitClearBtn');
    await idle();

    // Built-in pegs on a plate with a thin tube standing on it: the cut through the plate gets dovetail tabs, the one
    // through the tube has no room for a peg. The fit test is the dovetail alone, and the tube's row then says glue only
    const stand = Manifold.union(
      Manifold.cube([200, 60, 5], true).translate([0, 0, 2.5]),
      Manifold.cylinder(75, 20, 20, 64).subtract(Manifold.cylinder(77, 18, 18, 64).translate([0, 0, -1])).translate([50, 0, 4]),
    );
    const standFile = writeFixture('plate-and-tube.stl', soupOf(stand));
    stand.delete();
    await openStl(standFile, 'plate-and-tube');
    await page.click('#addCutBtn');
    await idle();
    await page.click('#addCutBtn');
    await idle();
    await page.click('#cutList li >> nth=1 >> .seg label:has-text("Z")');
    await idle();
    for (const [n, at] of [[0, '-50'], [1, '40']]) {
      await page.fill(`#cutList li >> nth=${n} >> input[data-cut-at]`, at);
      await page.dispatchEvent(`#cutList li >> nth=${n} >> input[data-cut-at]`, 'change');
    }
    await page.click('#splitSettings label:has(input[data-split="joint"][value="pegs"])');
    await measured();
    const standMeta = await page.locator('#cutList .meta').allInnerTexts();
    await page.waitForTimeout(1000);
    const standTest = await fitTest('plate-and-tube-fit-test.stl');
    const standMetaAfter = await page.locator('#cutList .meta').allInnerTexts();
    check(
      /· dovetails$/.test(standMeta[0]) && /· pegs$/.test(standMeta[1]) && /the tab drops into its socket/.test(standTest.status) && !/peg/.test(standTest.status) &&
        /· dovetails$/.test(standMetaAfter[0]) && /· glue only$/.test(standMetaAfter[1]),
      'a fit test with a dovetail but no peg turns the row of the cut planned for pegs to glue only',
      `${standMeta.join(' / ')} | ${standTest.status} | ${standMetaAfter.join(' / ')}`,
    );
    await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
    await idle();
    await page.click('#splitClearBtn');
    await idle();

    // a thin plate is joined with dovetails (Joints: Auto), with an O cut right through it whose middle falls out
    const plate = Manifold.cube([120, 40, 2], true);
    const plateFile = writeFixture('plate.stl', soupOf(plate));
    plate.delete();
    await openStl(plateFile, 'plate');
    await page.click('#itemList li:first-child');
    await idle();
    await setText('O');
    const sizeBefore = await page.inputValue('#lineList .line-size >> nth=0');
    await setLineSize(0, 4);
    await page.check('input[name="mode"][value="engrave"]');
    await idle();
    await setNumber('depth', 3);
    await page.click('[data-side="top"]');
    await idle();
    await page.fill('#posX', '30');
    await page.dispatchEvent('#posX', 'change');
    await idle();
    await page.click('#addCutBtn');
    await measured();
    const lengthsOf = async () => (await page.locator('#pieceList li').allInnerTexts()).map((r) => Number(r.match(/· ([\d.]+) ×/)?.[1]));
    const predicted = await lengthsOf();
    await page.check('#resultToggle');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await idle();
    const computed = await lengthsOf();
    check(
      predicted.length === 2 && computed.length === 2 && predicted.every((v, i) => Math.abs(v - computed[i]) < 0.5) && Math.max(...computed) > 61,
      'before the pieces are worked out, their boxes already count the dovetail tabs',
      `${predicted.join(' + ')} mm predicted, ${computed.join(' + ')} mm worked out`,
    );
    // the loose middle is the text's business, not the split's: it stays on the status line
    check(
      !/loose fragments/.test(await splitNotes()) && /Removed 1 tiny loose fragments/.test(await status()),
      "the note about the O's loose middle stays on the status line, out of the split's card",
      `card: ${await splitNotes()} | status: ${(await status()).replace(/\n/g, ' | ')}`,
    );
    await page.waitForTimeout(1000);
    const tabTest = await fitTest('plate-fit-test.stl');
    check(/the tab drops into its socket/.test(tabTest.status) && !/pin/.test(tabTest.status), 'its fit test is a dovetail, with no pin the pieces do not use', tabTest.status);
    await page.uncheck('#resultToggle');
    await page.click('#splitClearBtn');
    await idle();
    await page.click('#itemList li:first-child');
    await idle();
    await page.check('input[name="mode"][value="emboss"]');
    await idle();
    await setLineSize(0, sizeBefore);
    await setText('');

    console.log('\na lantern whose top comes apart');
    {
      // a lantern: its top comes off to change the light inside, so the cut under the roof is one that comes apart
      const lantern = lanternSolid();
      const lanternFile = writeFixture('lantern.stl', soupOf(lantern));
      lantern.delete();
      await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
      await openStl(lanternFile, 'lantern');
      check(
        (await page.locator('#splitHint').innerText()) === "Too big for your printer, or want the top to come off – a lantern's, a box's lid? Cut it into pieces that print one by one.",
        "the split card's hint offers a top that comes off as well",
        await page.locator('#splitHint').innerText(),
      );
      /** Pixels of the view in the cut planes' colours, unlit as the handles are: violet (glued) and teal (comes apart). */
      const cutColours = () =>
        page.evaluate(() => {
          const c = document.querySelector('#stage canvas');
          const probe = document.createElement('canvas');
          probe.width = c.width;
          probe.height = c.height;
          const ctx = probe.getContext('2d');
          ctx.drawImage(c, 0, 0);
          const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
          const near = (i, [r, g, b]) => Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30;
          let violet = 0;
          let teal = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (near(i, [139, 92, 246])) violet++;
            else if (near(i, [13, 148, 136])) teal++;
          }
          return { violet, teal };
        });
      /** The first cut row's state: its classes, the box, the hold chosen and what it says it cuts. */
      const apartRow = async () =>
        page.evaluate(() => {
          const li = document.querySelector('#cutList li');
          return {
            apart: li.classList.contains('apart'),
            ticked: li.querySelector('[data-cut-apart]').checked,
            hold: li.querySelector('[data-cut-hold]:checked')?.value ?? null,
            holds: !li.querySelector('.cut-hold').hidden,
            meta: li.querySelector('.meta').textContent,
          };
        });
      /** Wait for the pieces worked out again after a change: the list is current and the engine idle. */
      const piecesAgain = async () => {
        await idle();
        await page.waitForFunction(() => !document.querySelector('#pieceList').classList.contains('stale') && !document.querySelector('#pieceList li.predicted'), null, { timeout: 60000 });
        await idle();
      };
      await page.click('#addCutBtn');
      await idle();
      check(JSON.stringify(await cutState()) === '[2,"145.5"]', '+ Cut cuts the 291 mm lantern across Z in the middle', JSON.stringify(await cutState()));
      await page.fill('#cutList input[data-cut-at]', '190');
      await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
      await measured();
      const glued = await cutColours();
      await page.click('#cutList li:first-child label.cut-apart');
      await measured();
      const ticked = await apartRow();
      const holdChoices = await page.evaluate(() => [...document.querySelectorAll('#cutList li:first-child .cut-hold label')].map((l) => [l.textContent, l.title]));
      check(
        ticked.apart && ticked.ticked && ticked.holds && ticked.hold === 'lock' && /^1,728 mm² · comes apart$/.test(ticked.meta) &&
          JSON.stringify(holdChoices) === JSON.stringify([
            ['Locks', 'Holds firmly – comes off only with a firm pull'],
            ['Clicks on', 'Holds when carried – pulls off by hand'],
            ['Light click', 'A gentle click'],
            ['Lifts off', 'No clips – just sits on'],
          ]),
        'ticking Comes apart: the row turns teal, Locks – first of the holds, each with its tooltip – is chosen and the row says the cut comes apart',
        `${JSON.stringify(ticked)} ${JSON.stringify(holdChoices)}`,
      );
      const teal = await cutColours();
      const legend = { apart: !(await page.locator('#legendApart').isHidden()), cut: !(await page.locator('#legendCut').isHidden()) };
      check(
        glued.violet > 100 && glued.teal === 0 && teal.teal > 100 && teal.violet === 0 && legend.apart && !legend.cut,
        'its plane and handle turn from violet to teal, and the legend says "comes apart"',
        `${JSON.stringify(glued)} → ${JSON.stringify(teal)}, ${JSON.stringify(legend)}`,
      );
      const settings = await page.evaluate(() => ({
        hint: document.querySelector('#splitJointsHint').hidden ? null : document.querySelector('#splitJointsHint').textContent,
        off: ['joint', 'diameter', 'pins', 'labels', 'depth', 'count'].every((k) => [...document.querySelectorAll(`[data-split="${k}"]`)].every((e) => e.disabled)),
        on: ['clearance', 'orient'].every((k) => !document.querySelector(`[data-split="${k}"]`).disabled) && !document.querySelector('#splitFitTestBtn').disabled,
      }));
      check(
        settings.hint === 'Every cut here comes apart – Joints are for glued cuts.' && settings.off && settings.on,
        'with every cut coming apart the joint settings are off and say why; the clearance, how pieces lie and the fit test stay on',
        JSON.stringify(settings),
      );
      // the box clicked keeps the keys for the cut, as its axis does: Ctrl+Z undoes the tick, Ctrl+Y does it again
      await page.keyboard.press('Control+z');
      await idle();
      const undone = await apartRow();
      await page.keyboard.press('Control+y');
      await idle();
      const redone = await apartRow();
      check(
        !undone.apart && !undone.ticked && !undone.holds && redone.apart && redone.ticked && redone.hold === 'lock',
        'Ctrl+Z unticks it and Ctrl+Y ticks it again, locking',
        `${JSON.stringify(undone)} / ${JSON.stringify(redone)}`,
      );
      // its handle in the view lights up under the pointer in a lighter teal, as a glued cut's does in a lighter violet
      const hovered = await page.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const rect = c.getBoundingClientRect();
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const found = [];
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 2) {
            const i = (y * c.width + x) * 4;
            if (Math.abs(d[i] - 13) + Math.abs(d[i + 1] - 148) + Math.abs(d[i + 2] - 136) < 30) found.push([rect.left + (x * rect.width) / c.width, rect.top + (y * rect.height) / c.height]);
          }
        }
        return found;
      });
      let lit = 0;
      for (const [x, y] of hovered.filter((_, i) => i % 7 === 0).slice(0, 120)) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(40);
        if ((await page.evaluate(() => document.querySelector('#stage canvas').style.cursor)) !== 'grab') continue;
        // the hover sets the cursor in one frame and draws the lighter handle in the next: wait for it
        lit = await page.evaluate(async () => {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const c = document.querySelector('#stage canvas');
          const probe = document.createElement('canvas');
          probe.width = c.width;
          probe.height = c.height;
          const ctx = probe.getContext('2d');
          ctx.drawImage(c, 0, 0);
          const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 45) + Math.abs(d[i + 1] - 212) + Math.abs(d[i + 2] - 191) < 30) n++;
          return n;
        });
        break;
      }
      await page.mouse.move(700, 800);
      check(lit > 50, "the handle of a cut that comes apart turns a lighter teal under the pointer", `${lit} pixels`);
      await page.locator('#splitCard').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '8-split-apart-row.png') });

      // the pieces: the body carries the lip and its clips, the top comes off it
      await page.check('#resultToggle');
      await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
      await piecesAgain();
      const lidRows = await page.locator('#pieceList li').allInnerTexts();
      check(
        lidRows.length === 2 && /^1 · 108 × 108 × 196 mm · .*· lip at A, 4 clips$/.test(lidRows[0]) && /^2 · 110 × 110 × 101 mm · .*· comes off at A$/.test(lidRows[1]),
        'piece 1 has the lip and its 4 clips, 6 mm taller for it, and piece 2 comes off at A',
        lidRows.join(' / '),
      );
      check(
        /Cut A comes apart – don't glue it\./.test(await splitNotes()) &&
          (await splitNotes()).includes('Cut A comes apart: the top (piece 2) locks onto a 6 mm lip – 4 clips hold it firmly. Press it on until it clicks; to take it off, pull hard.') &&
          !/may not hold up|lever|gap/.test(await splitNotes()),
        'the notes say the top locks onto a 6 mm lip with 4 clips, that a hard pull takes it off (nothing to lever at), and not to glue it',
        await splitNotes(),
      );
      check(/· comes apart: locks \(4 clips\)$/.test((await apartRow()).meta), 'the row says how it holds once the pieces are worked out', (await apartRow()).meta);
      // the lid lifted well off the lip, for the screenshot, with the offer made when the lantern was opened out of the way
      await page.fill('#spreadRange', '2');
      await page.dispatchEvent('#spreadRange', 'input');
      await page.evaluate(() => (document.querySelector('#toast').hidden = true));
      await page.mouse.move(700, 800);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(out, '8-split-apart-pieces.png') });
      await page.fill('#spreadRange', '1');
      await page.dispatchEvent('#spreadRange', 'input');

      const lidZip = await downloadZip();
      const lidNames = Object.keys(lidZip.entries).sort();
      const sheet = lidZip.entries['lantern-text-how-to-glue.txt'] ?? '';
      check(
        lidNames.join() === 'lantern-text-how-to-glue.txt,lantern-text-piece-1-of-2.stl,lantern-text-piece-2-of-2.stl' &&
          lidNames.filter((n) => n.endsWith('.stl')).every((n) => lidZip.entries[n].volume > 0 && lidZip.entries[n].sizeOk),
        'the zip holds the two pieces, both solid, and the sheet, with no pins',
        lidNames.join(', '),
      );
      check(
        sheet.includes('Do not glue cut A: it comes apart. Press the top on until it clicks – it locks; pull hard to open it. It goes on one way round only – turn it until it drops onto the lip.') &&
          sheet.includes('Clips are 30 mm bridges over a slot') && /PUT TOGETHER/.test(sheet) && !/GLUE –|lever/.test(sheet),
        'the sheet says not to glue cut A but press the top on until it locks and pull hard to open it, with nothing glued',
        sheet.split('\n').filter((l) => /PUT TOGETHER|Do not glue|GLUE|bridges/.test(l)).join(' | '),
      );
      await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
      const lockTest = await fitTest('lantern-lock-fit-test.stl');
      check(
        lockTest.shells.length === 2 &&
          /Print it: the lid should lock onto the box and come off only with a firm pull – too stiff to open, raise the clearance by 0\.05 mm; too loose, lower it\.$/.test(lockTest.status),
        "its fit test's lid locks on, and the status says it should take a firm pull to come off",
        lockTest.status,
      );

      // Clicks on instead, and back with Ctrl+Z
      await page.click('#cutList li:first-child .cut-hold label:has-text("Clicks on")');
      await piecesAgain();
      const clicking = { row: await apartRow(), notes: await splitNotes() };
      await page.keyboard.press('Control+z');
      await piecesAgain();
      const relocked = await apartRow();
      await page.keyboard.press('Control+y');
      await piecesAgain();
      const reclicked = await apartRow();
      check(
        clicking.row.hold === 'snap' && /· comes apart: clicks on \(4 clips\)$/.test(clicking.row.meta) &&
          clicking.notes.includes('Cut A comes apart: the top (piece 2) clicks onto a 6 mm lip on piece 1 – 4 clips hold it, and it pulls off again by hand.') &&
          relocked.hold === 'lock' && /· comes apart: locks \(4 clips\)$/.test(relocked.meta) &&
          reclicked.hold === 'snap' && /· comes apart: clicks on \(4 clips\)$/.test(reclicked.meta),
        'Clicks on: the row and the notes say the top clicks on and pulls off by hand; Ctrl+Z locks it again, Ctrl+Y clicks it on',
        `${JSON.stringify(clicking.row)} / ${relocked.meta} / ${reclicked.meta}`,
      );

      // 2 mm higher the roof leaves room for a 4.5 mm lip only, with no clips: the note offers to move the cut back
      await page.fill('#cutList input[data-cut-at]', '192');
      await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
      await piecesAgain();
      const move = page.locator('#splitNotes li', { hasText: 'only 4.5 mm tall' });
      const moveText = (await move.count()) ? await move.locator('.text').innerText() : await splitNotes();
      const moveLabel = (await move.count()) ? await move.locator('button').innerText() : '';
      check(
        moveText ===
          "Cut A's lip is only 4.5 mm tall, so it has no clips and the top just lifts off: a lip that clicks on needs 9.4 mm of plain wall in piece 2 past the cut. Move the cut to 190.5 mm." &&
          moveLabel === 'Move cut A to 190.5 mm' &&
          /· comes apart: lifts off$/.test((await apartRow()).meta),
        'at 192 mm the lip is 4.5 mm with no clips, and its note offers to move the cut to 190.5 mm',
        `${moveText} [${moveLabel}] ${(await apartRow()).meta}`,
      );
      if (moveLabel) await move.locator('button').click();
      await piecesAgain();
      check(
        (await cutState())[1] === '190.5' && /· comes apart: clicks on \(4 clips\)$/.test((await apartRow()).meta),
        'its button moves the cut there, and the lip has its 4 clips again',
        `${(await cutState())[1]} · ${(await apartRow()).meta}`,
      );

      // Light click: smaller catches, which may not hold up the body hanging from the top; the note offers the full click
      await page.click('#cutList li:first-child .cut-hold label:has-text("Light click")');
      await piecesAgain();
      const heavy = page.locator('#splitNotes li', { hasText: 'may not hold up' });
      const heavyText = (await heavy.count()) ? await heavy.locator('.text').innerText() : await splitNotes();
      const heavyLabel = (await heavy.locator('button').count()) ? await heavy.locator('button').innerText() : '';
      check(
        /· comes apart: light click \(4 clips\)$/.test((await apartRow()).meta) &&
          /^Cut A's clips may not hold up what hangs below it \(about \d+ g\) – carry the model by its base, not its top\.$/.test(heavyText) &&
          heavyLabel === 'Use Clicks on',
        'with Light click the row says so, and a note warns that the clips may not hold the body up, offering Clicks on',
        `${(await apartRow()).meta} | ${heavyText}`,
      );
      await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
      const lightTest = await fitTest('lantern-light-fit-test.stl');
      check(
        lightTest.shells.length === 2 && /check that the lid clicks lightly onto the box and pulls off again by hand/.test(lightTest.status),
        "its fit test's lid clicks on lightly",
        lightTest.status,
      );
      if (heavyLabel) await heavy.locator('button').click();
      await piecesAgain();
      check(
        (await apartRow()).hold === 'snap' && /clicks on \(4 clips\)$/.test((await apartRow()).meta) && !/may not hold up/.test(await splitNotes()),
        'its button sets the cut to Clicks on, and the warning goes',
        `${(await apartRow()).hold} · ${(await apartRow()).meta}`,
      );
      await page.click('#cutList li:first-child .cut-hold label:has-text("Lifts off")');
      await piecesAgain();
      const lifts = await apartRow();
      const liftRows = await page.locator('#pieceList li').allInnerTexts();
      check(
        lifts.hold === 'lift' && /· comes apart: lifts off$/.test(lifts.meta) && /· lip at A$/.test(liftRows[0]),
        'Lifts off: no clips, and the row says the top lifts off',
        `${lifts.meta} | ${liftRows[0]}`,
      );
      await page.waitForTimeout(1000);
      const liftTest = await fitTest('lantern-lift-fit-test.stl');
      check(
        liftTest.shells.length === 2 && /check that the lid drops onto the box and lifts off freely by hand – too tight: raise Clearance by 0\.05 mm\.$/.test(liftTest.status),
        "and its fit test's lid lifts off freely",
        liftTest.status,
      );
      await page.click('#cutList li:first-child .cut-hold label:has-text("Clicks on")');
      await piecesAgain();

      // its fit test: a small box and its lid with the same lip and clips
      await page.waitForTimeout(1000);
      const lidTest = await fitTest('lantern-fit-test.stl');
      const sizes = lidTest.shells.map((e) => e.map((v) => Math.round(v * 10) / 10).join('×')).sort();
      check(
        sizes.join() === '12×30×60,18×30×60' && /the lid clicks onto the box and pulls off again by hand/.test(lidTest.status),
        'the fit test is a 60 × 30 × 18 mm box and its 60 × 30 × 12 mm lid, and the status says how the lid should go on',
        `${sizes.join(', ')} | ${lidTest.status}`,
      );

      // Fit to my printer keeps a cut that comes apart: on this printer it is all the lantern needs
      await page.click('#splitFitBtn');
      await idle();
      await piecesAgain();
      const kept = { cuts: await page.locator('#cutList li').count(), row: await apartRow(), at: (await cutState())[1], notes: await splitNotes() };
      check(
        kept.cuts === 1 && kept.row.ticked && kept.at === '190.5' && /This model fits your printer with cut A as it is – no more cuts needed\./.test(kept.notes),
        'Fit to my printer keeps the cut that comes apart, and says the lantern needs no more',
        JSON.stringify({ ...kept, row: kept.row.meta }),
      );

      // on an A1 mini the body is too tall: Fit cuts it again below the lip and keeps cut A where it is – even when A was
      // ticked while the plan was being worked out, which plans it again
      await page.evaluate(() => (document.querySelector('#bedPreset').closest('details').open = true));
      await page.selectOption('#bedPreset', 'a1mini');
      await idle();
      await page.click('#cutList li:first-child label.cut-apart');
      await idle();
      await page.evaluate(() => (window.__engine.hold = true));
      await page.click('#splitFitBtn');
      await page.waitForFunction(() => window.__engine.held.length > 0, null, { timeout: 60000 });
      await page.click('#cutList li:first-child label.cut-apart');
      await releasePlans();
      await idle();
      await piecesAgain();
      const mini = {
        cuts: await page.locator('#cutList li').count(),
        first: await apartRow(),
        at: await cutState(0),
        second: (await page.locator('#cutList li').count()) > 1 ? await cutState(1) : null,
        rows: await page.locator('#pieceList li').allInnerTexts(),
        notes: await splitNotes(),
      };
      check(
        mini.cuts === 2 && mini.first.ticked && mini.at[1] === '190.5' && mini.second?.[0] === 2 && Number(mini.second[1]) < 190.5 &&
          mini.rows.length === 3 && mini.rows.every((r) => /· fits/.test(r)) &&
          mini.notes.includes('Cut A comes apart, so Fit to my printer kept it where it is and planned the other cuts around it.'),
        'on an A1 mini Fit keeps cut A ticked at 190.5 mm, adds a cut below it, every piece fits and the notes say A was kept',
        JSON.stringify({ ...mini, first: mini.first.meta }),
      );
      await page.locator('#splitCard').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '8-split-apart.png') });
      await page.selectOption('#bedPreset', 'generic');
      await idle();

      // through the windows the faces are posts too small for a lip: there is nothing to try, and the row then says so
      await page.uncheck('#resultToggle');
      await page.click('#cutList li:nth-child(2) .cut-remove');
      await idle();
      await page.fill('#cutList input[data-cut-at]', '100');
      await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
      await measured();
      // nothing is saved, so no download to wait for: the status line says why
      await page.click('#splitFitTestBtn');
      await page.waitForFunction(() => /^Nothing to try/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }).catch(() => null);
      await idle();
      check(
        (await status()) === 'Nothing to try: these cuts get no lip or tabs, so the pieces just rest on each other.' && /· comes apart: no lip$/.test((await apartRow()).meta),
        'a cut through the windows comes apart with no lip: the fit test has nothing to try, and the row says no lip',
        `${await status()} | ${(await apartRow()).meta}`,
      );
      // a glued cut and one that comes apart in the same place are one cut, which comes apart: the glued one's row says
      // so, not pins
      await page.click('#cutList li:first-child label.cut-apart');
      await page.fill('#cutList input[data-cut-at]', '190');
      await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
      await measured();
      await page.click('#addCutBtn');
      await idle();
      await page.fill('#cutList li >> nth=1 >> input[data-cut-at]', '190');
      await page.dispatchEvent('#cutList li >> nth=1 >> input[data-cut-at]', 'change');
      await measured();
      await page.click('#cutList li:nth-child(2) label.cut-apart');
      await measured();
      const merged = { metas: await page.locator('#cutList .meta').allInnerTexts(), states: [await cutState(0), await cutState(1)] };
      check(
        merged.states.every((c) => c[0] === 2 && c[1] === '190') && /^1,728 mm² · comes apart$/.test(merged.metas[0]) && merged.metas[1] === 'in the same place as cut A',
        'a glued cut with one that comes apart in the same place: its row says it comes apart, not pins',
        JSON.stringify(merged),
      );
      await page.click('#splitClearBtn');
      await idle();

      // a lantern with a solid base, about 650 g below the cut: Clicks on may not hold it up, and the note's button sets
      // the cut to Locks, which does
      const base = boxAt([-46, -46, 3], [46, 46, 40]);
      const plain = lanternSolid();
      const weighted = plain.add(base);
      const heavyFile = writeFixture('lantern-heavy.stl', soupOf(weighted));
      [base, plain, weighted].forEach((m) => m.delete());
      await page.waitForTimeout(1000);
      await openStl(heavyFile, 'lantern-heavy');
      await page.click('#addCutBtn');
      await idle();
      await page.fill('#cutList input[data-cut-at]', '190');
      await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
      await measured();
      await page.click('#cutList li:first-child label.cut-apart');
      await measured();
      await page.check('#resultToggle');
      await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
      await piecesAgain();
      const lockedHeavy = { row: await apartRow(), notes: await splitNotes() };
      await page.click('#cutList li:first-child .cut-hold label:has-text("Clicks on")');
      await piecesAgain();
      const tooHeavy = page.locator('#splitNotes li', { hasText: 'may not hold up' });
      const tooHeavyText = (await tooHeavy.count()) ? await tooHeavy.locator('.text').innerText() : await splitNotes();
      const tooHeavyLabel = (await tooHeavy.locator('button').count()) ? await tooHeavy.locator('button').innerText() : '';
      check(
        lockedHeavy.row.hold === 'lock' && !/may not hold up/.test(lockedHeavy.notes) &&
          /^Cut A's clips may not hold up what hangs below it \(about 650 g\) – carry the model by its base, not its top\.$/.test(tooHeavyText) &&
          tooHeavyLabel === 'Use Locks',
        'with a heavy base Locks holds it up, but Clicks on may not, and its note offers Locks',
        `${lockedHeavy.row.hold} | ${tooHeavyText} [${tooHeavyLabel}]`,
      );
      if (tooHeavyLabel) await tooHeavy.locator('button').click();
      await piecesAgain();
      check(
        (await apartRow()).hold === 'lock' && /· comes apart: locks \(4 clips\)$/.test((await apartRow()).meta) && !/may not hold up/.test(await splitNotes()),
        'its button sets the cut to Locks, and the warning goes',
        `${(await apartRow()).hold} · ${(await apartRow()).meta} | ${await splitNotes()}`,
      );
      await page.uncheck('#resultToggle');
      await page.click('#splitClearBtn');
      await idle();

      // a round lantern's top twist-locks where its round wall takes no clips: its fit test is the twist-lock on two
      // rings, and trying it leaves the row saying it twist-locks
      const round = roundLanternSolid();
      const roundFile = writeFixture('round-lantern.stl', soupOf(round));
      round.delete();
      await page.waitForTimeout(1000);
      await openStl(roundFile, 'round-lantern');
      await page.click('#addCutBtn');
      await idle();
      await page.fill('#cutList input[data-cut-at]', '150');
      await page.dispatchEvent('#cutList input[data-cut-at]', 'change');
      await measured();
      await page.click('#cutList li:first-child label.cut-apart');
      await measured();
      await page.check('#resultToggle');
      await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
      await piecesAgain();
      const twisting = (await apartRow()).meta;
      await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
      const twistTest = await fitTest('round-twist-fit-test.stl');
      await idle();
      const afterTest = (await apartRow()).meta;
      check(
        /· comes apart: twist-lock \(turn 10°\)$/.test(twisting) && twistTest.shells.length === 2 &&
          /Two rings Ø \d+ mm with the twist-lock at this size \(about \d+ g\): they should twist together with a click and hold when pulled\./.test(twistTest.status) &&
          afterTest === twisting,
        "a round lantern's twist-lock has its own fit test, two rings, and the row still says it twist-locks after it",
        `${twisting} | ${twistTest.shells.length} bodies | ${twistTest.status} | ${afterTest}`,
      );
      await page.uncheck('#resultToggle');
      await page.click('#splitClearBtn');
      await idle();

      // a plate with a thin tube standing on it, closed at the top: the plate's cut has dovetail tabs, and the tube's,
      // which comes apart, is too thin for a lip (an open tube's top twist-locks, as its lock needs no such wall; this
      // one's would print on its cut face, its roof hung over its inside). The fit test is the dovetail alone, and the
      // tube's row then says it has no lip
      const capped = Manifold.union(
        Manifold.cube([200, 60, 5], true).translate([0, 0, 2.5]),
        Manifold.cylinder(75, 20, 20, 64).subtract(Manifold.cylinder(73, 18, 18, 64).translate([0, 0, -1])).translate([50, 0, 4]),
      );
      const cappedFile = writeFixture('plate-and-capped-tube.stl', soupOf(capped));
      capped.delete();
      await page.waitForTimeout(1000);
      await openStl(cappedFile, 'plate-and-capped-tube');
      await page.click('#addCutBtn');
      await idle();
      await page.click('#addCutBtn');
      await idle();
      await page.click('#cutList li >> nth=1 >> .seg label:has-text("Z")');
      await idle();
      for (const [n, at] of [[0, '-50'], [1, '40']]) {
        await page.fill(`#cutList li >> nth=${n} >> input[data-cut-at]`, at);
        await page.dispatchEvent(`#cutList li >> nth=${n} >> input[data-cut-at]`, 'change');
      }
      await measured();
      await page.click('#cutList li:nth-child(2) label.cut-apart');
      await measured();
      const tubeMixed = {
        hint: await page.locator('#splitJointsHint').innerText(),
        joints: await page.isDisabled('[data-split="joint"][value="auto"]'),
        meta: await page.locator('#cutList .meta').allInnerTexts(),
      };
      // with the glued cut glue only, the clearance is still the lip's, and its fit test can still be tried
      await page.click('#splitSettings label:has(input[data-split="joint"][value="none"])');
      await idle();
      const glueOnly = await page.evaluate(() => ({
        labels: document.querySelector('[data-split="labels"]').disabled,
        clearance: document.querySelector('[data-split="clearance"]').disabled,
        test: document.querySelector('#splitFitTestBtn').disabled,
      }));
      check(
        glueOnly.labels && !glueOnly.clearance && !glueOnly.test,
        'Glue only beside a cut that comes apart leaves its clearance and the fit test on',
        JSON.stringify(glueOnly),
      );
      await page.click('#splitSettings label:has(input[data-split="joint"][value="auto"])');
      await measured();
      await page.waitForTimeout(1000);
      const tubeTest = await fitTest('plate-and-capped-tube-fit-test.stl');
      const tubeMeta = await page.locator('#cutList .meta').allInnerTexts();
      check(
        tubeMixed.hint === 'Joints are for the glued cuts; cut B comes apart.' && !tubeMixed.joints && /· comes apart$/.test(tubeMixed.meta[1]) &&
          /the tab drops into its socket/.test(tubeTest.status) && !/lid/.test(tubeTest.status) && /· dovetails$/.test(tubeMeta[0]) && /· comes apart: no lip$/.test(tubeMeta[1]),
        'with a glued cut beside it the joints stay on for that one; the fit test is its dovetail alone, and the tube\'s row then says no lip',
        `${JSON.stringify(tubeMixed)} | ${tubeTest.status} | ${tubeMeta.join(' / ')}`,
      );
      await page.check('#resultToggle');
      await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
      await piecesAgain();
      const thin = page.locator('#splitNotes li', { hasText: 'no room for a lip' });
      check(
        (await thin.count()) === 1 &&
          (await thin.locator('.text').innerText()) === 'Cut B has no room for a lip – its walls are under 2.7 mm thick – so the top just rests on piece 2, with nothing to line it up or hold it.' &&
          (await thin.locator('button').innerText()) === 'Select cut B',
        'its note says the walls are too thin for a lip, and selects the cut',
        await splitNotes(),
      );
      await page.uncheck('#resultToggle');
      await page.click('#splitClearBtn');
      await idle();

      console.log('\nplacing a removable part on the lantern');
      await page.waitForTimeout(1000); // Chromium lets a page start about ten downloads a second
      await openStl(lanternFile, 'lantern');
      await page.evaluate(() => (document.querySelector('#toast').hidden = true));
      const textsBefore = await page.locator('#itemList li').count();
      /** The readout by the pointer: its lines and the lip's verdict that colours it and the section, or null when hidden. */
      const readout = () =>
        page.evaluate(() => {
          const el = document.querySelector('#cutReadout');
          return el.hidden ? null : { lines: [...el.children].map((c) => c.textContent), verdict: el.dataset.verdict };
        });
      /** Pixels of the view in one colour, unlit as the section is drawn: teal (a full lip), red (none). */
      const viewPixels = ([r, g, b]) =>
        page.evaluate(([r, g, b]) => {
          const c = document.querySelector('#stage canvas');
          const probe = document.createElement('canvas');
          probe.width = c.width;
          probe.height = c.height;
          const ctx = probe.getContext('2d');
          ctx.drawImage(c, 0, 0);
          const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30) n++;
          return n;
        }, [r, g, b]);
      const TEAL = [13, 148, 136];
      const RED = [214, 41, 75];
      /** Every cut row: where it is, across which axis, whether it comes apart and how it holds, and whether it is selected. */
      const rows = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('#cutList li')].map((li) => ({
            axis: li.querySelector('[data-cut-axis]:checked')?.value,
            at: li.querySelector('[data-cut-at]').value,
            apart: li.querySelector('[data-cut-apart]').checked,
            hold: li.querySelector('[data-cut-hold]:checked')?.value ?? null,
            selected: li.classList.contains('selected'),
          })),
        );
      const pressed = (selector) => page.getAttribute(selector, 'aria-pressed');
      const view = await page.locator('#stage canvas').boundingBox();
      const mx = view.x + view.width / 2 + 10;
      /** Rest the pointer at row y of the line down the middle of the view, until the engine has said what lip it gets there. */
      const rest = async (y) => {
        await page.mouse.move(mx, y + 2);
        await page.mouse.move(mx, y);
        await page.waitForTimeout(250); // the lip is asked about 150 ms after the pointer rests
        await idle();
        await page.waitForTimeout(60);
      };

      await page.click('#addApartBtn');
      await idle();
      const started = {
        pressed: await pressed('#addApartBtn'),
        status: await status(),
        spots: await page.locator('#spotList .spot').allInnerTexts(),
        note: await page.locator('#spotsNote').innerText(),
      };
      check(
        started.pressed === 'true' &&
          /^Click the model where it should come apart – it snaps to ledges and good spots; hold Alt to place it freely\. Shift\+click to place more\. Esc stops\.$/.test(started.status) &&
          started.spots.length === 3 &&
          /^Z 190\.5 mm – top 100\.5 mm comes off · locks with 4 clips · under a ledge where the shape widens$/.test(started.spots[0]) &&
          started.note === 'Best first – click one to add a cut that comes apart there.',
        '+ Removable part: the button stays pressed, the status says to click the model, and the spots come up, 190.5 mm first',
        JSON.stringify(started),
      );
      // with Alt held the plane follows the pointer freely: the height under each row down the middle of the view
      await page.keyboard.down('Alt');
      const heights = [];
      let snappedFreely = 0;
      for (let y = view.y + 40; y < view.y + view.height - 30; y += 6) {
        await page.mouse.move(mx, y);
        await page.waitForTimeout(40);
        const r = await readout();
        const m = r?.lines[0].match(/^Z (-?[\d.]+) mm/);
        if (m) heights.push([y, Number(m[1])]);
        if (r?.lines.some((l) => l.startsWith('snapped'))) snappedFreely++;
      }
      await page.keyboard.up('Alt');
      const yAt = (z) => heights.reduce((best, h) => (Math.abs(h[1] - z) < Math.abs(best[1] - z) ? h : best), [0, Infinity])[0];
      check(
        heights.length > 30 && snappedFreely === 0 && heights.some(([, z]) => z > 250) && heights.some(([, z]) => z < 40) && heights.some(([, z]) => z % 0.5 !== 0),
        'with Alt held the plane follows the pointer freely, top to bottom of the lantern, never snapping',
        `${heights.length} rows, ${snappedFreely} snapped`,
      );
      // over the roof's edge it snaps to the ledge where the roof meets the body: no room for a lip there
      await rest(yAt(201));
      const edge = await readout();
      const red = await viewPixels(RED);
      check(
        edge?.lines[0] === 'Z 200 mm · no room for a lip – move down to 190.5' && edge.lines[1] === 'snapped to the ledge at 200 mm' && edge.verdict === 'none' && red > 100,
        "over the roof's edge the plane snaps to the ledge at 200 mm: the readout says there is no room for a lip and to move down to 190.5, and the section is red",
        `${JSON.stringify(edge)}, ${red} red pixels`,
      );
      await page.screenshot({ path: path.join(out, '9-place-roof-edge.png') });
      // a little lower it snaps to the best spot, where the lip locks with 4 clips
      const below = yAt(191);
      await rest(below);
      const spotRead = await readout();
      const tealSection = await viewPixels(TEAL);
      check(
        spotRead?.lines[0] === 'Z 190.5 mm · locks with 4 clips · top 100.5 mm comes off' &&
          spotRead.lines[1] === 'snapped to a good spot at 190.5 mm – under a ledge where the shape widens' && spotRead.verdict === 'full' && tealSection > 100,
        'just under the roof it snaps to the spot at 190.5 mm: it locks with 4 clips, the top comes off, and the section is teal',
        `${JSON.stringify(spotRead)}, ${tealSection} teal pixels`,
      );
      await page.screenshot({ path: path.join(out, '9-place-readout.png') });
      await page.mouse.click(mx, below);
      await idle();
      const placed = { rows: await rows(), pressed: await pressed('#addApartBtn'), readout: await readout(), texts: await page.locator('#itemList li').count() };
      await measured();
      const placedMeta = await page.locator('#cutList li .meta').allInnerTexts();
      check(
        JSON.stringify(placed.rows) === JSON.stringify([{ axis: '2', at: '190.5', apart: true, hold: 'lock', selected: true }]) &&
          placed.pressed === 'false' && placed.readout === null && placed.texts === textsBefore && placedMeta[0] === '1,728 mm² · comes apart',
        'a click puts a cut across Z there, ticked Comes apart (Locks), selected and measured; placing stops, and no text is made',
        JSON.stringify({ ...placed, placedMeta }),
      );
      await page.keyboard.press('Control+z');
      await idle();
      const unplaced = await rows();
      await page.keyboard.press('Control+y');
      await idle();
      const replaced = await rows();
      check(
        unplaced.length === 0 && replaced.length === 1 && replaced[0].at === '190.5' && replaced[0].apart,
        'Ctrl+Z takes the placed cut away in one step, Ctrl+Y puts it back',
        `${JSON.stringify(unplaced)} / ${JSON.stringify(replaced)}`,
      );
      // Escape stops placing, as does the button pressed again
      await page.click('#addApartBtn');
      await rest(yAt(120));
      const beforeEscape = await readout();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      const escaped = { pressed: await pressed('#addApartBtn'), readout: await readout(), cuts: (await rows()).length };
      await page.click('#addApartBtn');
      await page.click('#addApartBtn');
      const twice = await pressed('#addApartBtn');
      // taking up something else stops it too: a text, or the pieces
      await page.click('#addApartBtn');
      await page.click('#itemList li:first-child');
      await idle();
      const tookText = await pressed('#addApartBtn');
      await page.click('#addApartBtn');
      await page.check('#resultToggle');
      await idle();
      const tookPieces = await pressed('#addApartBtn');
      await page.uncheck('#resultToggle');
      await idle();
      await page.click('#frameBtn'); // the pieces were framed pulled apart: the view as it was when the lantern opened
      check(
        !!beforeEscape && escaped.pressed === 'false' && escaped.readout === null && escaped.cuts === 1 && twice === 'false' && tookText === 'false' && tookPieces === 'false',
        'Escape stops placing (the plane and readout go, no cut is added), and so do the button pressed again, a text taken up and the pieces shown',
        JSON.stringify({ beforeEscape, escaped, twice, tookText, tookPieces }),
      );
      // Alt places it freely, between the spot and the ledge
      await page.click('#addApartBtn');
      await page.keyboard.down('Alt');
      const freeY = yAt(197);
      await rest(freeY);
      const free = await readout();
      await page.mouse.click(mx, freeY);
      await page.keyboard.up('Alt');
      await idle();
      const freeAt = free?.lines[0].match(/^Z ([\d.]+) mm/)?.[1];
      const afterFree = await rows();
      check(
        !!freeAt && Number(freeAt) > 193.5 && Number(freeAt) < 199 && free.lines.length === 1 && afterFree.length === 2 && afterFree[1].at === freeAt && afterFree[1].apart,
        'with Alt held the cut goes where the pointer is, not snapped',
        `${JSON.stringify(free)} → ${JSON.stringify(afterFree)}`,
      );
      // the crosshair in cut B's row places it again, along its own axis
      await page.click('#cutList li:nth-child(2) [data-cut-place]');
      const rowPick = { pressed: await pressed('#cutList li:nth-child(2) [data-cut-place]'), status: await status() };
      await rest(yAt(161));
      const rowRead = await readout();
      await page.mouse.click(mx, yAt(161));
      await idle();
      const moved = await rows();
      await page.keyboard.press('Control+z');
      await idle();
      const movedBack = await rows();
      await page.keyboard.press('Control+y');
      await idle();
      check(
        rowPick.pressed === 'true' && /^Click the model where cut B should go/.test(rowPick.status) &&
          rowRead?.lines[1] === 'snapped to a good spot at 160.5 mm – above the openings' && moved.length === 2 && moved[1].at === '160.5' && moved[1].apart &&
          moved[0].at === '190.5' && movedBack[1].at === freeAt && (await rows())[1].at === '160.5' && (await pressed('#cutList li:nth-child(2) [data-cut-place]')) === 'false',
        "the crosshair in cut B's row places it again on the model – snapped to the spot at 160.5 mm – as one undo step",
        JSON.stringify({ rowPick, rowRead, moved, movedBack }),
      );
      // Shift+click places one and keeps placing
      await page.click('#addApartBtn');
      await rest(yAt(31));
      await page.keyboard.down('Shift');
      await page.mouse.click(mx, yAt(31));
      await page.keyboard.up('Shift');
      await idle();
      const keptOn = { rows: await rows(), pressed: await pressed('#addApartBtn') };
      await page.keyboard.press('Escape');
      check(
        keptOn.rows.length === 3 && keptOn.rows[2].at === '30.5' && keptOn.rows[2].apart && keptOn.pressed === 'true' && (await pressed('#addApartBtn')) === 'false',
        'Shift+click places a cut (at the spot at 30.5 mm) and keeps placing until Escape',
        JSON.stringify(keptOn),
      );
      // Suggest spots for the selected cut: hovering one shows its plane and section, a click moves the cut there
      await page.click('#cutList li:first-child .cut-remove');
      await idle();
      await page.click('#suggestSpotsBtn');
      await idle();
      const suggested = { spots: await page.locator('#spotList .spot').allInnerTexts(), note: await page.locator('#spotsNote').innerText(), rows: await rows() };
      await page.mouse.move(view.x + 30, view.y + view.height - 30);
      await page.waitForTimeout(200);
      const plainTeal = await viewPixels(TEAL);
      await page.hover('#spotList li:first-child .spot');
      await page.waitForTimeout(300);
      const previewTeal = await viewPixels(TEAL);
      await page.screenshot({ path: path.join(out, '9-place-spots.png') });
      await page.click('#spotList li:first-child .spot');
      await idle();
      const spotMoved = await rows();
      await page.keyboard.press('Control+z');
      await idle();
      const spotUndone = await rows();
      await page.keyboard.press('Control+y');
      await idle();
      const spotRedone = await rows();
      check(
        /^Z 190\.5 mm – /.test(suggested.spots[0] ?? '') && suggested.note === 'Best first – click one to move cut B there.' &&
          JSON.stringify(suggested.rows.map((r) => [r.at, r.selected])) === JSON.stringify([['160.5', false], ['30.5', true]]) &&
          previewTeal > plainTeal + 300 && spotMoved[1].at === '190.5' && spotMoved[0].at === '160.5' && spotUndone[1].at === '30.5' && spotRedone[1].at === '190.5',
        'Suggest spots lists 190.5 mm first; hovering it draws its plane and section, and a click moves the selected cut there as one undo step',
        JSON.stringify({ suggested, plainTeal, previewTeal, spotMoved, spotUndone, spotRedone }),
      );
      // a handle dragged snaps and reads the same way: up from 190.5 to the ledge at 200, where there is no room for a lip
      const handles = await page.evaluate(([r, g, b]) => {
        const c = document.querySelector('#stage canvas');
        const rect = c.getBoundingClientRect();
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const found = [];
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 2) {
            const i = (y * c.width + x) * 4;
            if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30) found.push([rect.left + (x * rect.width) / c.width, rect.top + (y * rect.height) / c.height]);
          }
        }
        return found;
      }, TEAL);
      let grip = null;
      for (const [x, y] of handles.filter((_, i) => i % 5 === 0)) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(40);
        if ((await page.evaluate(() => document.querySelector('#stage canvas').style.cursor)) !== 'grab') continue;
        grip = [x, y];
        break;
      }
      const dragged = [];
      let pastTop = null;
      if (grip) {
        await page.mouse.down();
        let ledge = 0;
        for (let dy = 0; dy >= -90; dy -= 3) {
          ledge = dy;
          await page.mouse.move(grip[0], grip[1] + dy);
          await page.waitForTimeout(30);
          const r = await readout();
          if (r && r.lines.some((l) => l === 'snapped to the ledge at 200 mm')) break;
        }
        await page.waitForTimeout(250);
        await idle();
        await page.waitForTimeout(60);
        dragged.push(await readout());
        await page.keyboard.down('Alt');
        await page.waitForTimeout(100);
        dragged.push(await readout());
        await page.keyboard.up('Alt');
        await page.waitForTimeout(100);
        dragged.push(await readout());
        // on up past the top of the model, and back to the ledge to drop it there
        await page.mouse.move(grip[0], grip[1] + ledge - 400, { steps: 8 });
        await page.waitForTimeout(300);
        await idle();
        await page.waitForTimeout(60);
        pastTop = await readout();
        await page.mouse.move(grip[0], grip[1] + ledge, { steps: 8 });
        await page.waitForTimeout(100);
        await page.mouse.up();
        await idle();
      }
      const draggedRows = await rows();
      const dropped = draggedRows.find((r) => r.selected)?.at;
      check(
        !!grip && /^[AB] · Z = 200 mm · /.test(dragged[0]?.lines[0] ?? '') && dragged[0].lines[1] === 'no room for a lip – move down to 190.5' &&
          dragged[0].lines[2] === 'snapped to the ledge at 200 mm' && dragged[0].verdict === 'none' &&
          !dragged[1]?.lines.some((l) => l.startsWith('snapped')) && dragged[2]?.lines[2] === 'snapped to the ledge at 200 mm' && dropped === '200',
        "a cut's handle dragged snaps to the ledge at 200 mm and its readout says there is no room for a lip; Alt lets it go freely, and it lands where it snapped",
        JSON.stringify({ grip, dragged, draggedRows }),
      );
      check(
        /^[AB] · Z = [\d.]+ mm · misses the model$/.test(pastTop?.lines[0] ?? '') && pastTop.lines.filter((l) => /misses the model/.test(l)).length === 1,
        'dragged on past the top of the model, its readout says once that it misses the model',
        JSON.stringify(pastTop),
      );
      check((await page.locator('#itemList li').count()) === textsBefore, 'no text was made by any of the clicks on the model while placing', String(await page.locator('#itemList li').count()));
      await page.click('#splitClearBtn');
      await idle();
      // selecting the cuts let go of the text: pick it again for what follows
      await page.click('#itemList li:first-child');
      await idle();
    }
  }

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
  {
    // a sign of raised text alone, too long for the printer: the cuts go between the letters, and follow the text as it changes
    const measured = async () => {
      await idle();
      await page.waitForTimeout(1400); // a text edit is measured once the typing stops
      await idle();
    };
    const lengths = async () => (await page.locator('#pieceList li').allInnerTexts()).map((r) => Number(r.match(/· ([\d.]+) ×/)?.[1]));
    await page.click('#itemList li:first-child');
    await idle();
    const sizeBefore = await page.inputValue('#lineList .line-size >> nth=0');
    await lineFont(0).selectOption('inter');
    await idle();
    await setText('HELLO');
    await setLineSize(0, 80);
    await page.click('#splitFitBtn');
    await page.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await measured();
    const meta = await page.locator('#cutList .meta').innerText();
    check(/nothing to join/.test(meta) && !/pins/.test(meta), 'a cut between the letters of a sign says there is nothing to join, not pins', meta);
    const statusBefore = await status();
    await page.click('#splitFitTestBtn');
    await page.waitForFunction((was) => document.querySelector('#status').innerText !== was, statusBefore, { timeout: 60000 });
    check(/nothing is joined/.test(await status()), 'and its fit test says there is nothing to try: nothing is joined', await status());
    const maxBefore = Number(await page.locator('#cutList input[data-cut-at]').getAttribute('max'));
    await page.click('#itemList li:first-child');
    await idle();
    await setText('HELLO WORLD');
    await measured();
    const maxAfter = Number(await page.locator('#cutList input[data-cut-at]').getAttribute('max'));
    const longer = await lengths();
    check(
      maxAfter > maxBefore + 100 && longer.length === 2 && longer[0] + longer[1] > 600,
      'longer text moves the bounds of the cuts and the sizes of the pieces with it',
      `cut box max ${maxBefore} → ${maxAfter}, pieces ${longer.join(' + ')} mm`,
    );
    await page.click('#addCutBtn');
    await measured();
    const halved = await lengths();
    check(halved.length === 3 && Math.min(...halved) > 150, '"+ Cut" then halves the longest piece of the new text', `${halved.join(' / ')} mm`);
    await page.click('#splitClearBtn');
    await idle();
    await page.click('#itemList li:first-child');
    await idle();
    await setLineSize(0, sizeBefore);
    await setText('ALONE');
  }

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

  console.log('\nplacing a removable part: the place shown is the place given, and the spots follow the cut');
  {
    // a page of its own, its spots' answers held back when asked (window.__spots.hold), as on a dense model where they
    // take seconds
    const aimContext = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    await aimContext.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
      const Native = window.Worker;
      const spots = (window.__spots = { ids: new Set(), asked: 0, hold: false, held: [] });
      window.Worker = class extends Native {
        postMessage(message, transfer) {
          if (message?.type === 'split.plan' && message.mode === 'spots') {
            spots.ids.add(message.id);
            spots.asked++;
          }
          return super.postMessage(message, transfer);
        }
        set onmessage(listener) {
          super.onmessage =
            listener &&
            ((event) => {
              const { id, type } = event.data ?? {};
              if (spots.hold && spots.ids.has(id) && type !== 'progress') spots.held.push(() => listener.call(this, event));
              else listener.call(this, event);
            });
        }
        get onmessage() {
          return super.onmessage;
        }
      };
    });
    const p = await aimContext.newPage();
    const aimProblems = [];
    p.on('pageerror', (e) => aimProblems.push(`pageerror: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && aimProblems.push(`console: ${m.text()}`));
    const settle = async () => {
      await p.waitForTimeout(80);
      await p.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
      await p.waitForTimeout(80);
      await p.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    };
    const read = () =>
      p.evaluate(() => {
        const el = document.querySelector('#cutReadout');
        return el.hidden ? null : { lines: [...el.children].map((c) => c.textContent), verdict: el.dataset.verdict };
      });
    const zOf = (r) => r?.lines[0].match(/^Z (-?[\d.]+) mm/)?.[1] ?? null;
    const cutRows = () =>
      p.evaluate(() =>
        [...document.querySelectorAll('#cutList li')].map((li) => ({
          axis: li.querySelector('[data-cut-axis]:checked')?.value,
          at: li.querySelector('[data-cut-at]').value,
          hold: li.querySelector('[data-cut-hold]:checked')?.value ?? null,
          selected: li.classList.contains('selected'),
        })),
      );
    const spotTexts = () => p.locator('#spotList .spot').allInnerTexts();
    const asked = () => p.evaluate(() => window.__spots.asked);
    const holdSpots = () => p.evaluate(() => (window.__spots.hold = true));
    const releaseSpots = () =>
      p.evaluate(() => {
        window.__spots.hold = false;
        window.__spots.held.splice(0).forEach((deliver) => deliver());
      });
    const saying = (re) => p.waitForFunction((src) => [...document.querySelectorAll('#cutReadout > *')].some((c) => new RegExp(src).test(c.textContent)), re.source, { timeout: 8000 }).catch(() => null);
    await p.goto(url);
    await p.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await p.setInputFiles('#stlFile', path.join(out, 'lantern.stl'));
    await p.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('lantern:'), null, { timeout: 60000 });
    await settle();
    await p.evaluate(() => (document.querySelector('#toast').hidden = true));
    const stage = await p.locator('#stage canvas').boundingBox();
    const x = stage.x + stage.width / 2 + 10;
    const restAt = async (y) => {
      await p.mouse.move(x, y + 2);
      await p.mouse.move(x, y);
      await p.waitForTimeout(250);
      await settle();
      await p.waitForTimeout(60);
    };

    // the heights down the middle of the view, the spots held back; Alt held, the plane follows the pointer freely
    await holdSpots();
    await p.click('#addApartBtn');
    await p.waitForTimeout(300);
    await p.keyboard.down('Alt');
    const heights = [];
    for (let y = stage.y + 40; y < stage.y + stage.height - 30; y += 6) {
      await p.mouse.move(x, y);
      await p.waitForTimeout(40);
      const z = zOf(await read());
      if (z) heights.push([y, Number(z)]);
    }
    await p.keyboard.up('Alt');
    const yAt = (z) => heights.reduce((best, h) => (Math.abs(h[1] - z) < Math.abs(best[1] - z) ? h : best), [0, Infinity])[0];

    // a little over the best spot, where nothing snaps: the lip there is worked out, where a full one fits becomes a target
    // and the plane snaps to it at once, and a click places the cut where the readout says
    const over = yAt(194.5);
    await p.mouse.move(x, over + 2);
    await p.mouse.move(x, over);
    await saying(/^snapped to where a full lip fits/);
    await p.waitForTimeout(300);
    const lipShown = await read();
    await p.mouse.click(x, over);
    await p.waitForTimeout(400);
    const lipPlaced = await cutRows();
    check(
      !!zOf(lipShown) && lipShown.lines.some((l) => /^snapped to where a full lip fits, at [\d.]+ mm$/.test(l)) && lipPlaced.length === 1 && lipPlaced[0].at === zOf(lipShown),
      'where the lip is moved to, worked out while the pointer rests, pulls the plane there, and a click places the cut where the readout says',
      JSON.stringify({ lipShown, lipPlaced }),
    );
    await releaseSpots();
    await settle();
    await p.keyboard.press('Control+z');
    await settle();

    // the view zoomed with the wheel, or turned, under a still pointer: the plane and the readout go where the pointer now
    // is, and a click places the cut there
    const body = yAt(120);
    const moved = [];
    for (const how of ['wheel', 'turn']) {
      await p.click('#addApartBtn');
      await settle();
      await restAt(body);
      const before = zOf(await read());
      let [cx, cy] = [x, body];
      if (how === 'wheel') {
        for (let k = 0; k < 4; k++) {
          await p.mouse.wheel(0, -200);
          await p.waitForTimeout(120);
        }
      } else {
        await p.mouse.down();
        [cx, cy] = [x + 40, body + 60];
        await p.mouse.move(cx, cy, { steps: 8 });
        await p.mouse.up();
      }
      await p.waitForTimeout(600);
      await settle();
      const after = await read();
      await p.mouse.click(cx, cy);
      await settle();
      moved.push({ how, before, after: zOf(after), placed: (await cutRows()).map((r) => r.at) });
      await p.keyboard.press('Control+z');
      await settle();
      await p.click('#frameBtn');
      await p.waitForTimeout(400);
    }
    check(
      moved.every((m) => !!m.before && !!m.after && m.after !== m.before && JSON.stringify(m.placed) === JSON.stringify([m.after])),
      'zoomed or turned under a still pointer, the plane and its readout follow the pointer, and a click places the cut where they say',
      JSON.stringify(moved),
    );

    // the placing hint, three lines long, has its room in the card
    await p.click('#addApartBtn');
    await settle();
    const hintRoom = await p.evaluate(() => {
      const el = document.querySelector('#status');
      return { height: el.clientHeight, needs: el.scrollHeight, text: el.textContent };
    });
    check(/Shift\+click to place more/.test(hintRoom.text) && hintRoom.needs <= hintRoom.height + 1, 'the placing hint has the room its lines need, never drawn over the footer', JSON.stringify(hintRoom));

    // a small solid face, the top of the handle (the text standing on it named after it): too small for a lip, not
    // "openings"
    await p.keyboard.down('Alt');
    await restAt(yAt(287));
    const handleTop = await read();
    await p.keyboard.up('Alt');
    check(/^Z 2[89]\d(\.\d)? mm · face too small for a lip( · through “Hello”)?$/.test(handleTop?.lines[0] ?? ''), "over the handle's top the readout says the face is too small for a lip", JSON.stringify(handleTop));

    // Shift+click near a cut already placed snaps onto it: no second cut there, and the readout and the status say so
    await restAt(yAt(191));
    await p.keyboard.down('Shift');
    await p.mouse.click(x, yAt(191));
    await p.keyboard.up('Shift');
    await settle();
    const once = await cutRows();
    await restAt(yAt(189.5));
    const onIt = await read();
    await p.keyboard.down('Shift');
    await p.mouse.click(x, yAt(189.5));
    await p.keyboard.up('Shift');
    await settle();
    const twice = { rows: await cutRows(), status: await p.locator('#status').innerText() };
    await p.keyboard.press('Escape');
    check(
      once.length === 1 && once[0].at === '190.5' && !!onIt?.lines.includes('cut A is already here') && twice.rows.length === 1 && /^Cut A is already at 190\.5 mm/.test(twice.status),
      'a Shift+click onto a cut already placed adds none: the readout says the cut is already there, and so does the page',
      JSON.stringify({ once, onIt, twice }),
    );

    // a spot cut A already takes says so, and a click on it selects cut A rather than adding another
    await p.keyboard.press('Escape'); // and let go of cut A
    await settle();
    const taken = await spotTexts();
    await p.click('#spotList li:first-child .spot');
    await settle();
    const tookIt = { rows: await cutRows(), status: await p.locator('#status').innerText() };
    check(
      /^Z 190\.5 mm – .* · cut A is here$/.test(taken[0] ?? '') && tookIt.rows.length === 1 && tookIt.rows[0].selected && tookIt.status === 'Cut A is already there.',
      'a spot a cut already takes says so, and a click on it selects that cut instead of adding one',
      JSON.stringify({ taken, tookIt }),
    );

    // cut A held another way: the spots are looked for again, for Lifts off
    await holdSpots();
    const askedBefore = await asked();
    await p.click('#cutList li:first-child .cut-hold label:has-text("Lifts off")');
    await p.waitForTimeout(300);
    const holdBusy = { note: await p.locator('#spotsNote').innerText(), asked: (await asked()) - askedBefore };
    await releaseSpots();
    await settle();
    const lifting = await spotTexts();
    check(
      holdBusy.asked === 1 && holdBusy.note === 'Looking for good spots…' && lifting.length > 0 && lifting.every((t) => /6 mm lip – lifts off/.test(t)) &&
        lifting.some((t) => /^Z 39\.5 mm/.test(t)),
      "the selected cut held another way asks for its spots again: Lifts off's own, each a 6 mm lip that lifts off",
      JSON.stringify({ holdBusy, lifting }),
    );

    // Suggest spots pressed from the keyboard keeps the focus while it looks, and so does a spot chosen from it
    await p.keyboard.press('Escape'); // let go of cut A: the spots for a new cut, along Z for Locks
    await settle();
    await holdSpots();
    await p.focus('#suggestSpotsBtn');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    const looking = await p.evaluate(() => ({ focus: document.activeElement?.id, note: document.querySelector('#spotsNote').textContent }));
    await releaseSpots();
    await settle();
    const listed = await p.evaluate(() => document.activeElement?.id);
    // the second spot (the first is cut A's): Enter adds cut B there, and the list, laid out again, keeps the focus
    await p.keyboard.press('Tab');
    await p.keyboard.press('Tab');
    const tabbed = await p.evaluate(() => document.activeElement?.className);
    await p.keyboard.press('Enter');
    await settle();
    const chosen = await p.evaluate(() => ({ focus: document.activeElement?.className, cuts: document.querySelectorAll('#cutList li').length }));
    check(
      looking.focus === 'suggestSpotsBtn' && looking.note === 'Looking for good spots…' && listed === 'suggestSpotsBtn' && tabbed === 'spot' && chosen.focus === 'spot' && chosen.cuts === 2,
      'Suggest spots pressed from the keyboard keeps the focus while it looks, and a spot chosen with Enter keeps it in the list',
      JSON.stringify({ looking, listed, tabbed, chosen }),
    );

    // cut A turned across X: the spots are looked for again along X, and a click on one keeps it across X
    await p.click('#cutList li:first-child .seg label:has-text("X")');
    await settle();
    const across = await spotTexts();
    if (across.length) {
      await p.click('#spotList li:first-child .spot');
      await settle();
    }
    const stillX = await cutRows();
    check(
      across.length > 0 && across.every((t) => /^X /.test(t)) && stillX.length === 2 && stillX[0].axis === '0' && stillX[0].selected,
      'a cut turned across X has its spots looked for along X, and a click on one never turns it back',
      JSON.stringify({ across, stillX }),
    );
    await p.click('#splitClearBtn');
    await settle();

    // letters where the cut would go: the readout names them
    await p.click('#frameBtn');
    await p.waitForTimeout(400);
    await p.mouse.click(x, yAt(191)); // the text: placed there, or moved there
    await settle();
    await p.fill('#lineList .line-text >> nth=0', 'LIGHT');
    await p.dispatchEvent('#lineList .line-text >> nth=0', 'change');
    await settle();
    await p.click('#addApartBtn');
    await settle();
    await p.keyboard.down('Alt');
    await restAt(yAt(191));
    const lettered = await read();
    await p.keyboard.up('Alt');
    await p.keyboard.press('Escape');
    check(/ · through “LIGHT”$/.test(lettered?.lines[0] ?? ''), 'the readout names the letters a cut there would run through', JSON.stringify(lettered));

    // a block with nothing to suggest: the note never says to click the model, which would move the text, and its button
    // starts placing
    const blockFile = writeFixture('block.stl', soupOf(Manifold.cube([60, 60, 60], true)));
    await p.setInputFiles('#stlFile', blockFile);
    await p.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('block:'), null, { timeout: 60000 });
    await settle();
    await p.click('#suggestSpotsBtn');
    await settle();
    const none = { note: await p.locator('#spotsNote').innerText(), button: await p.locator('#spotsNote button').innerText().catch(() => null) };
    await p.click('#spotsNote button').catch(() => {});
    const startedPlacing = await p.getAttribute('#addApartBtn', 'aria-pressed');
    await p.keyboard.press('Escape');
    check(
      /^No good spot found – pick one on the model yourself:/.test(none.note) && !/click the model/.test(none.note) && none.button === 'Place on model' && startedPlacing === 'true',
      'with nothing to suggest, the note offers to place a cut on the model with its button, never a click that would move the text',
      JSON.stringify({ none, startedPlacing }),
    );
    check(aimProblems.length === 0, 'no page errors while placing on its own page', aimProblems.join(' | '));
    await aimContext.close();
  }

  console.log('\nplacing: glued cuts, handles dragged, and the pieces view');
  {
    // a page of its own that notes the split.plan requests sent (window.__plans: their modes, in order) and every
    // progress message shown
    const glueContext = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    await glueContext.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
      const plans = (window.__plans = { sent: [], stages: [] });
      const Native = window.Worker;
      window.Worker = class extends Native {
        postMessage(message, transfer) {
          if (message?.type === 'split.plan') plans.sent.push(message.mode);
          return super.postMessage(message, transfer);
        }
      };
      setInterval(() => {
        const el = document.querySelector('#progress');
        const text = document.querySelector('#progressText')?.textContent;
        if (el && !el.hidden && text && plans.stages.at(-1) !== text) plans.stages.push(text);
      }, 10);
    });
    const g = await glueContext.newPage();
    const glueProblems = [];
    g.on('pageerror', (e) => glueProblems.push(`pageerror: ${e.message}`));
    g.on('console', (m) => m.type() === 'error' && glueProblems.push(`console: ${m.text()}`));
    const settle = async () => {
      await g.waitForTimeout(80);
      await g.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
      await g.waitForTimeout(80);
      await g.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    };
    const read = () =>
      g.evaluate(() => {
        const el = document.querySelector('#cutReadout');
        return el.hidden ? null : { lines: [...el.children].map((c) => c.textContent), verdict: el.dataset.verdict };
      });
    const cutRows = () =>
      g.evaluate(() =>
        [...document.querySelectorAll('#cutList li')].map((li) => ({
          at: li.querySelector('[data-cut-at]').value,
          apart: li.querySelector('[data-cut-apart]').checked,
          selected: li.classList.contains('selected'),
        })),
      );
    const plans = () => g.evaluate(() => ({ sent: [...window.__plans.sent], stages: [...window.__plans.stages] }));
    const forget = () => g.evaluate(() => window.__plans.sent.splice(0) && window.__plans.stages.splice(0));
    const teal = ([r, gr, b]) => g.evaluate(([r, gr, b]) => {
      const c = document.querySelector('#stage canvas');
      const probe = document.createElement('canvas');
      probe.width = c.width;
      probe.height = c.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gr) + Math.abs(d[i + 2] - b) < 30) n++;
      return n;
    }, [r, gr, b]);
    /** Every place on a cut's handle in the view – a pixel in its colour where the pointer gets the grab cursor – lowest on screen last. */
    const handles = async (colors) => {
      const found = await g.evaluate((colors) => {
        const c = document.querySelector('#stage canvas');
        const rect = c.getBoundingClientRect();
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const out = [];
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 2) {
            const i = (y * c.width + x) * 4;
            if (colors.some(([r, gr, b]) => Math.abs(d[i] - r) + Math.abs(d[i + 1] - gr) + Math.abs(d[i + 2] - b) < 30)) out.push([rect.left + (x * rect.width) / c.width, rect.top + (y * rect.height) / c.height]);
          }
        }
        return out;
      }, colors);
      const tried = [];
      const grips = [];
      for (const [x, y] of found) {
        if (tried.some(([a, b]) => Math.hypot(a - x, b - y) < 10)) continue;
        tried.push([x, y]);
        if (tried.length > 200) break;
        await g.mouse.move(x, y);
        await g.waitForTimeout(30);
        if ((await g.evaluate(() => document.querySelector('#stage canvas').style.cursor)) === 'grab' && !grips.some(([a, b]) => Math.hypot(a - x, b - y) < 12)) grips.push([x, y]);
      }
      return grips.sort((p, q) => p[1] - q[1]);
    };
    const VIOLET = [139, 92, 246];
    const TEAL = [13, 148, 136];
    /** A point on cut `letter`'s handle (teal: it comes apart): one where a press and a little drag read that letter. */
    const gripOf = async (letter) => {
      for (const grip of await handles([TEAL, [45, 212, 191]])) {
        await g.mouse.move(...grip);
        await g.mouse.down();
        await g.mouse.move(grip[0], grip[1] - 6, { steps: 3 });
        await g.waitForTimeout(40);
        const who = (await read())?.lines[0]?.[0];
        await g.keyboard.press('Escape');
        await g.mouse.up();
        await settle();
        if (who === letter) return grip;
      }
      return null;
    };
    const setAt = async (row, v) => {
      await g.fill(`#cutList li:nth-child(${row}) [data-cut-at]`, String(v));
      await g.press(`#cutList li:nth-child(${row}) [data-cut-at]`, 'Enter');
      await settle();
    };
    await g.goto(url);
    await g.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await g.setInputFiles('#stlFile', path.join(out, 'lantern.stl'));
    await g.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('lantern:'), null, { timeout: 60000 });
    await settle();
    await g.evaluate(() => (document.querySelector('#toast').hidden = true));
    const stage = await g.locator('#stage canvas').boundingBox();
    const x = stage.x + stage.width / 2 + 10;
    // the height under each row down the middle of the view, Alt held, while a removable part is placed
    await g.click('#addApartBtn');
    await settle();
    await g.keyboard.down('Alt');
    const heights = [];
    for (let y = stage.y + 40; y < stage.y + stage.height - 30; y += 6) {
      await g.mouse.move(x, y);
      await g.waitForTimeout(40);
      const z = (await read())?.lines[0].match(/^Z (-?[\d.]+) mm/)?.[1];
      if (z) heights.push([y, Number(z)]);
    }
    await g.keyboard.up('Alt');
    await g.keyboard.press('Escape');
    await settle();
    const yAt = (z) => heights.reduce((best, h) => (Math.abs(h[1] - z) < Math.abs(best[1] - z) ? h : best), [0, Infinity])[0];

    // a glued cut added, and turned across X and Y: nothing reads the shape for snapping, its measure only
    await forget();
    await g.click('#addCutBtn');
    await settle();
    for (const axis of ['X', 'Y', 'Z']) {
      await g.click(`#cutList li:first-child .seg label:has-text("${axis}")`);
      await settle();
    }
    await g.waitForFunction(() => window.__plans.sent.includes('measure'), null, { timeout: 10000 }).catch(() => null);
    await settle();
    const glued = await plans();
    check(
      glued.sent.length > 0 && glued.sent.every((m) => m === 'measure') && !glued.stages.includes('Reading the shape…'),
      'a glued cut added and turned asks the engine for its measure only, and nothing says the shape is being read',
      JSON.stringify(glued),
    );

    // its handle dragged goes by the step, onto every millimetre: never pulled onto a ledge or a spot of a cut that
    // comes apart
    await setAt(1, 140);
    const [violetGrip] = await handles([VIOLET, [167, 139, 250]]);
    const gluedAt = [];
    let gluedSnapped = 0;
    if (violetGrip) {
      await g.mouse.move(...violetGrip);
      await g.mouse.down();
      for (let dy = 0; dy >= -140; dy -= 2) {
        await g.mouse.move(violetGrip[0], violetGrip[1] + dy);
        await g.waitForTimeout(25);
        const r = await read();
        const z = r?.lines[0].match(/^A · Z = ([\d.]+) mm/)?.[1];
        if (z) gluedAt.push(Number(z));
        if (r?.lines.some((l) => l.startsWith('snapped'))) gluedSnapped++;
        if (Number(z) >= 165) break;
      }
      await g.mouse.up();
      await settle();
    }
    const reached = [...new Set(gluedAt)];
    check(
      !!violetGrip && gluedSnapped === 0 && [...Array(15).keys()].map((k) => 145 + k).every((z) => reached.includes(z)),
      "a glued cut's handle dragged goes by the step onto every height, never snapping to the ledges or spots of a cut that comes apart",
      JSON.stringify({ violetGrip, reached, gluedSnapped }),
    );

    // a glued cut where a spot is: clicking the spot makes that cut come apart, as the list offers
    await setAt(1, 190.5);
    await g.click('#suggestSpotsBtn');
    await settle();
    const gluedSpot = (await g.locator('#spotList .spot').allInnerTexts())[0] ?? '';
    await g.click('#spotList li:first-child .spot');
    await settle();
    const madeApart = { rows: await cutRows(), status: await g.locator('#status').innerText() };
    check(
      /^Z 190\.5 mm – .* · cut A is here$/.test(gluedSpot) && JSON.stringify(madeApart.rows) === JSON.stringify([{ at: '190.5', apart: true, selected: true }]) &&
        madeApart.status === 'Cut A is there: it comes apart now.',
      'a click on a spot where a glued cut is makes that cut come apart there, as the list says it will',
      JSON.stringify({ gluedSpot, madeApart }),
    );

    // cut B placed freely under it; dragged up past cut A, it never snaps onto A's spot, where it would do nothing
    await g.click('#addApartBtn');
    await settle();
    await g.keyboard.down('Alt');
    await g.mouse.move(x, yAt(174.5) + 2);
    await g.mouse.move(x, yAt(174.5));
    await g.waitForTimeout(100);
    await g.mouse.click(x, yAt(174.5));
    await g.keyboard.up('Alt');
    await settle();
    const bAt = (await cutRows())[1]?.at;
    const bGrip = await gripOf('B');
    const bReadouts = [];
    if (bGrip) {
      await g.mouse.move(...bGrip);
      await g.mouse.down();
      for (let dy = 0; dy >= -80; dy -= 1) {
        await g.mouse.move(bGrip[0], bGrip[1] + dy);
        await g.waitForTimeout(20);
        const r = await read();
        if (r) bReadouts.push(r.lines.join(' | '));
      }
      await g.keyboard.press('Escape');
      await g.mouse.up();
      await settle();
    }
    const onA = bReadouts.filter((l) => /^B · Z = 190\.5 mm/.test(l));
    const afterEscape = await cutRows();
    check(
      !!bGrip && bReadouts.length > 30 && bReadouts.some((l) => /^B · Z = (19[1-9]|2\d\d)/.test(l)) && onA.length === 0,
      "a handle dragged past another cut never snaps onto it, though that cut sits on a spot",
      JSON.stringify({ bAt, onA, last: bReadouts.slice(-3) }),
    );
    check(
      afterEscape.length === 2 && afterEscape[1].at === bAt,
      'Escape while a handle is dragged puts the cut back where it was, and the drop that follows moves nothing',
      JSON.stringify({ bAt, afterEscape }),
    );

    // dragged, Alt held, onto the very place of another cut: the readout says so, and dropped there it stays put
    await setAt(1, 192);
    const bGrip2 = await gripOf('B');
    let onTop = null;
    if (bGrip2) {
      await g.mouse.move(...bGrip2);
      await g.mouse.down();
      await g.keyboard.down('Alt');
      for (let dy = 0; dy >= -120 && !onTop; dy -= 1) {
        await g.mouse.move(bGrip2[0], bGrip2[1] + dy);
        await g.waitForTimeout(20);
        const r = await read();
        if (r && /^B · Z = 192 mm/.test(r.lines[0])) onTop = r;
      }
      await g.mouse.up();
      await g.keyboard.up('Alt');
      await settle();
    }
    const stayed = { rows: await cutRows(), status: await g.locator('#status').innerText() };
    check(
      !!onTop?.lines.includes('cut A is already here') && stayed.rows.length === 2 && stayed.rows[0].at === '192' && stayed.rows[1].at === bAt &&
        stayed.status === `Cut A is already at 192 mm – cut B stays where it was.`,
      'a handle dropped where another cut already is: its readout said so, and the cut stays where it was',
      JSON.stringify({ onTop, stayed }),
    );

    // where a full lip fits, worked out while a part was being placed, is no target once placing stops: B dragged up to
    // A's spot snaps to the spot, not to it
    await g.click('#addApartBtn');
    await settle();
    await g.keyboard.down('Alt');
    await g.mouse.move(x, yAt(218.7) + 2);
    await g.mouse.move(x, yAt(218.7));
    await g.waitForTimeout(300);
    await settle();
    const lipMove = (await read())?.lines[0] ?? '';
    await g.keyboard.up('Alt');
    await g.keyboard.press('Escape');
    await settle();
    const moveTo = lipMove.match(/move down to ([\d.]+)/)?.[1];
    const bGrip3 = await gripOf('B');
    const toSpot = [];
    if (bGrip3) {
      await g.mouse.move(...bGrip3);
      await g.mouse.down();
      for (let dy = 0; dy >= -70; dy -= 1) {
        await g.mouse.move(bGrip3[0], bGrip3[1] + dy);
        await g.waitForTimeout(20);
        const r = await read();
        if (r?.lines.some((l) => l.startsWith('snapped'))) toSpot.push(r.lines.find((l) => l.startsWith('snapped')));
      }
      await g.keyboard.press('Escape');
      await g.mouse.up();
      await settle();
    }
    check(
      !!moveTo && moveTo !== '190.5' && toSpot.length > 0 && !toSpot.some((l) => l.includes(`where a full lip fits, at ${moveTo} mm`)),
      'where a full lip fits, found while a removable part was placed, is no target for a handle dragged after',
      JSON.stringify({ lipMove, toSpot: [...new Set(toSpot)] }),
    );

    // "Show the pieces" under the piece list stops placing, as the Show pieces box does: in the pieces view the pointer
    // says nothing and a click places nothing
    await g.click('#addApartBtn');
    await settle();
    await g.mouse.move(x, yAt(120));
    await g.waitForTimeout(200);
    const hintShown = await g.isVisible('#showPiecesBtn');
    await g.click('#showPiecesBtn');
    await g.waitForSelector('#pieceList li:not(.predicted)', { timeout: 60000 });
    await settle();
    const rowsBefore = await cutRows();
    await g.mouse.move(x, yAt(150));
    await g.waitForTimeout(150);
    await g.mouse.move(x, yAt(150) + 4);
    await g.waitForTimeout(150);
    const piecesRead = await read();
    await g.mouse.click(x, yAt(150));
    await settle();
    check(
      hintShown && (await g.getAttribute('#addApartBtn', 'aria-pressed')) === 'false' && (await g.isChecked('#resultToggle')) && piecesRead === null &&
        JSON.stringify(await cutRows()) === JSON.stringify(rowsBefore),
      '"Show the pieces" stops placing: in the pieces view the pointer reads nothing and a click places nothing',
      JSON.stringify({ hintShown, piecesRead, rowsBefore }),
    );

    // with the pieces shown, a spot hovered draws its plane and section on the model, and the pieces come back after
    const canvasNow = () => g.evaluate(() => {
      const c = document.querySelector('#stage canvas');
      const probe = document.createElement('canvas');
      probe.width = c.width;
      probe.height = c.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(c, 0, 0);
      return Array.from(ctx.getImageData(0, 0, probe.width, probe.height).data.filter((_, i) => i % 16 === 0));
    });
    const changed = (a, b) => a.filter((v, i) => Math.abs(v - b[i]) > 30).length;
    await g.mouse.move(stage.x + 30, stage.y + stage.height - 30);
    await g.waitForTimeout(200);
    const piecesShown = await canvasNow();
    await g.hover('#spotList li:first-child .spot');
    await g.waitForTimeout(300);
    const hovered = await canvasNow();
    const hoverTeal = await teal(TEAL);
    await g.mouse.move(stage.x + 30, stage.y + stage.height - 30);
    await g.waitForTimeout(300);
    const left = await canvasNow();
    check(
      changed(piecesShown, hovered) > 2000 && hoverTeal > 2000 && changed(piecesShown, left) < 50,
      'with the pieces shown, hovering a spot draws its plane and section on the model, and the pieces come back after',
      JSON.stringify({ hoverChanged: changed(piecesShown, hovered), hoverTeal, leftChanged: changed(piecesShown, left) }),
    );
    await g.uncheck('#resultToggle');
    await settle();
    await g.click('#frameBtn'); // the pieces were framed pulled apart: the view as it was when the lantern opened
    await g.waitForTimeout(400);

    // a box with a lid, which fits the printer, so nothing builds its final result unasked: the spots listed are found
    // on the model alone; the final result then built, they are found again once a place tried says so – quietly, the
    // list staying as it is meanwhile
    await g.click('#splitClearBtn');
    await settle();
    await g.setInputFiles('#stlFile', writeFixture('lidbox.stl', soupOf(lidBoxSolid())));
    await g.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('lidbox:'), null, { timeout: 60000 });
    await settle();
    await g.click('#frameBtn');
    await g.waitForTimeout(400);
    await g.click('#suggestSpotsBtn');
    await settle();
    await g.check('#resultToggle');
    await settle();
    await g.uncheck('#resultToggle');
    await settle();
    await forget();
    await g.click('#addApartBtn');
    await settle();
    await g.keyboard.down('Alt'); // free: a place not tried before, so the engine answers it on the final result
    const boxY = stage.y + stage.height * 0.5;
    await g.mouse.move(x, boxY + 2);
    await g.mouse.move(x, boxY);
    await g.waitForTimeout(300);
    await settle();
    const notes = [];
    for (let k = 0; k < 20; k++) {
      notes.push(await g.locator('#spotsNote').innerText());
      await g.waitForTimeout(25);
    }
    await settle();
    const whilePlacing = { read: await read(), plans: await plans() };
    await g.keyboard.up('Alt');
    await g.keyboard.press('Escape');
    check(
      !!whilePlacing.read?.lines[0].includes(' · ') && whilePlacing.plans.sent.includes('probe') && whilePlacing.plans.sent.includes('spots') &&
        notes.every((n) => /^Best first/.test(n)) && !whilePlacing.plans.stages.includes('Looking for good spots…'),
      'spots found on the model alone are found again on the final result, quietly, the list staying as it is meanwhile',
      JSON.stringify({ whilePlacing, notes: [...new Set(notes)] }),
    );
    check(glueProblems.length === 0, 'no page errors on the glued cuts and drags page', glueProblems.join(' | '));
    await glueContext.close();
  }

  console.log('\nplacing a removable part with a touch');
  {
    // a phone: nothing hovers, so a touch on the model puts the plane there, a slide moves it, and a button places the cut
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await touch.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
    });
    const phone = await touch.newPage();
    const phoneProblems = [];
    phone.on('pageerror', (e) => phoneProblems.push(e.message));
    phone.on('console', (m) => m.type() === 'error' && phoneProblems.push(m.text()));
    const phoneIdle = async () => {
      await phone.waitForTimeout(80);
      await phone.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
      await phone.waitForTimeout(80);
      await phone.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    };
    await phone.goto(url);
    await phone.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await phone.setInputFiles('#stlFile', path.join(out, 'lantern.stl'));
    await phone.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('lantern:'), null, { timeout: 60000 });
    await phoneIdle();
    const texts = await phone.locator('#itemList li').count();
    await phone.locator('#addApartBtn').scrollIntoViewIfNeeded();
    await phone.locator('#addApartBtn').tap();
    await phoneIdle();
    const hint = await phone.locator('#status').innerText();
    await phone.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    await phone.waitForTimeout(300);
    const stage = await phone.locator('#stage canvas').boundingBox();
    const cdp = await touch.newCDPSession(phone);
    const finger = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const fx = stage.x + stage.width / 2;
    const fy = stage.y + stage.height * 0.45;
    await finger('touchStart', fx, fy);
    for (let k = 1; k <= 6; k++) {
      await phone.waitForTimeout(40);
      await finger('touchMove', fx, fy + 4 * k);
    }
    const sliding = await phone.evaluate(() => document.querySelector('#cutReadout').textContent);
    await finger('touchEnd', fx, fy + 24);
    await phone.waitForTimeout(300);
    await phoneIdle();
    const pinned = await phone.evaluate(() => {
      const el = document.querySelector('#cutReadout');
      return { hidden: el.hidden, first: el.firstElementChild?.textContent, buttons: [...el.querySelectorAll('button')].map((b) => b.textContent), pinned: el.classList.contains('pinned') };
    });
    await phone.screenshot({ path: path.join(out, '9-place-touch.png') });
    // pinned along the top of the view, the readout sits under the view's own controls: Reset view is still there to tap
    const controls = await phone.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const [r, f, v] = [box(document.querySelector('#cutReadout')), box(document.querySelector('#frameBtn')), box(document.querySelector('#stage'))];
      const hits = [0.15, 0.5, 0.85].map((u) => document.elementFromPoint(f.left + u * f.width, f.top + f.height / 2)?.closest('#frameBtn') !== null);
      return { top: r.top < v.top + 0.4 * v.height, overlap: !(r.top >= f.bottom || r.bottom <= f.top || r.left >= f.right || r.right <= f.left), hits };
    });
    check(
      controls.top && !controls.overlap && controls.hits.every(Boolean),
      "a readout pinned along the top of the view sits under the view's own controls, and Reset view is still there to tap",
      JSON.stringify(controls),
    );
    // the spots listed say what comes off as the readout does, once both are worked out on the final result (the spots
    // asked for as the model opened were found on the model alone, without the text on top)
    const firstSpot = await phone.locator('#spotList .spot').first().innerText();
    const offList = firstSpot.match(/^Z 190\.5 mm – top ([\d.]+) mm comes off/)?.[1];
    const offRead = pinned.first?.match(/^Z 190\.5 mm · .* top ([\d.]+) mm comes off$/)?.[1];
    const at = pinned.first?.match(/^Z ([\d.]+) mm/)?.[1];
    if (pinned.buttons.includes('Place cut here')) await phone.locator('#cutReadout button', { hasText: 'Place cut here' }).tap();
    await phoneIdle();
    const after = await phone.evaluate(() => [...document.querySelectorAll('#cutList li')].map((li) => [li.querySelector('[data-cut-at]').value, li.querySelector('[data-cut-apart]').checked]));
    check(
      /^Touch the model where it should come apart and slide to move the plane, then tap Place cut here\./.test(hint) && /^Z [\d.]+ mm/.test(sliding) &&
        !pinned.hidden && pinned.pinned && JSON.stringify(pinned.buttons) === JSON.stringify(['Place cut here', 'Cancel']) && / · /.test(pinned.first) &&
        JSON.stringify(after) === JSON.stringify([[at, true]]) && (await phone.locator('#itemList li').count()) === texts && (await phone.getAttribute('#addApartBtn', 'aria-pressed')) === 'false',
      'on a touch screen a touch and a slide on the model move the plane; lifted, it stays with the lip it gets there and a button that places the cut',
      JSON.stringify({ hint, sliding, pinned, after }),
    );
    check(
      !!offRead && offList === offRead,
      'the spots listed and the readout give the same length coming off at 190.5 mm, the text on top counted',
      `list: ${firstSpot} | readout: ${pinned.first}`,
    );
    // a finger slid up past the model's edge and lifted there leaves the plane where it last was on the model
    const pinnedReadout = () =>
      phone.evaluate(() => {
        const el = document.querySelector('#cutReadout');
        return { hidden: el.hidden, first: el.firstElementChild?.textContent ?? null, buttons: [...el.querySelectorAll('button')].map((b) => b.textContent) };
      });
    await phone.locator('#addApartBtn').scrollIntoViewIfNeeded();
    await phone.locator('#addApartBtn').tap();
    await phoneIdle();
    await phone.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    await phone.waitForTimeout(300);
    await finger('touchStart', fx, fy);
    const slid = [];
    for (let k = 1; k <= 45; k++) {
      await phone.waitForTimeout(30);
      await finger('touchMove', fx, fy - 6 * k);
      if (k % 5 === 0) slid.push(await pinnedReadout());
    }
    await finger('touchEnd', fx, fy - 6 * 45);
    await phone.waitForTimeout(300);
    await phoneIdle();
    const offEdge = await pinnedReadout();
    check(
      slid.some((r) => r.hidden === false) && !offEdge.hidden && /^Z [\d.]+ mm/.test(offEdge.first ?? '') && JSON.stringify(offEdge.buttons) === JSON.stringify(['Place cut here', 'Cancel']),
      "a finger slid past the model's edge and lifted there leaves the plane where it last was on the model, ready to place",
      JSON.stringify({ offEdge, slid: slid.map((r) => r.first) }),
    );
    // two fingers on the model zoom the view, and leave the plane as it was
    const drawn = () =>
      phone.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const [r0, g0, b0] = [d[0], d[1], d[2]]; // the background, in the corner
        let n = 0;
        for (let i = 0; i < d.length; i += 16) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 30) n++;
        return n;
      });
    const pinch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const unzoomed = await drawn();
    const [px, py] = [stage.x + stage.width / 2, stage.y + stage.height * 0.5];
    await pinch('touchStart', [[px - 20, py - 20], [px + 20, py + 20]]);
    for (let k = 1; k <= 12; k++) {
      await phone.waitForTimeout(35);
      await pinch('touchMove', [[px - 20 - 6 * k, py - 20 - 6 * k], [px + 20 + 6 * k, py + 20 + 6 * k]]);
    }
    await pinch('touchEnd', []);
    await phone.waitForTimeout(400);
    await phoneIdle();
    const zoomed = await drawn();
    const pinched = await pinnedReadout();
    check(
      Math.abs(zoomed - unzoomed) > 0.3 * unzoomed && pinched.first === offEdge.first && JSON.stringify(pinched.buttons) === JSON.stringify(['Place cut here', 'Cancel']),
      'while placing, two fingers on the model zoom the view, and the plane stays where it was',
      JSON.stringify({ unzoomed, zoomed, pinched: pinched.first, was: offEdge.first }),
    );
    if (pinched.buttons.includes('Cancel')) await phone.locator('#cutReadout button', { hasText: 'Cancel' }).tap();
    await phoneIdle();
    // a cut that comes apart placed again with its crosshair, the plane pinned: its hold changed meanwhile, the readout
    // says what it gets now
    await phone.evaluate(() => document.querySelector('#addCutBtn').click());
    await phoneIdle();
    await phone.evaluate(() => document.querySelector('#cutList li:last-child [data-cut-apart]').click());
    await phoneIdle();
    await phone.evaluate(() => document.querySelector('#cutList li:last-child [data-cut-place]').click());
    await phoneIdle();
    await phone.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    await phone.waitForTimeout(300);
    await finger('touchStart', fx, fy);
    for (let k = 1; k <= 6; k++) {
      await phone.waitForTimeout(40);
      await finger('touchMove', fx, fy + 4 * k);
    }
    await finger('touchEnd', fx, fy + 24);
    await phone.waitForTimeout(300);
    await phoneIdle();
    const locking = await pinnedReadout();
    await phone.evaluate(() => [...document.querySelectorAll('#cutList li:last-child .cut-hold label')].find((l) => l.textContent.includes('Lifts off')).click());
    await phone.waitForTimeout(300);
    await phoneIdle();
    const lifting = await pinnedReadout();
    check(
      /locks with \d clips?|lip without clips/.test(locking.first ?? '') && /^Z [\d.]+ mm · 6 mm lip – lifts off/.test(lifting.first ?? '') && lifting.first.match(/^Z [\d.]+/)[0] === locking.first.match(/^Z [\d.]+/)[0] &&
        lifting.buttons.includes('Cancel'),
      "with the plane pinned, the cut's hold changed: the readout says the lip it gets now, at the same place",
      JSON.stringify({ locking, lifting }),
    );
    if (lifting.buttons.includes('Cancel')) await phone.locator('#cutReadout button', { hasText: 'Cancel' }).tap();
    check(phoneProblems.length === 0, 'no page errors on the touch screen', phoneProblems.join(' | '));
    await touch.close();
  }

  console.log('\na cut row on the narrowest phone');
  {
    const narrow = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const n = await narrow.newPage();
    await n.goto(url);
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await n.setInputFiles('#stlFile', path.join(out, 'lantern.stl'));
    await n.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('lantern:'), null, { timeout: 60000 });
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await n.evaluate(() => document.querySelector('#addCutBtn').click());
    await n.waitForTimeout(500);
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await n.evaluate(() => document.querySelector('[data-cut-apart]').click());
    await n.waitForTimeout(500);
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    const fits = await n.evaluate(() => {
      const box = document.querySelector('[data-cut-at]');
      const was = box.value;
      const cs = getComputedStyle(box);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const out = [was, '190.5', '-38.25'].map((v) => ({ v, need: Math.round(ctx.measureText(v).width * 10) / 10, room }));
      box.value = was;
      return out;
    });
    check(fits.every((f) => f.need <= f.room), "on a 320 px phone a cut row's position box shows its number in full beside the crosshair", JSON.stringify(fits));
    await narrow.close();
  }

  check(problems.length === 0, 'no console errors or exceptions (page or worker)', problems.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
