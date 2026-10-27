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
import { batLanternSolid, box as boxAt, lanternSolid, lidBoxSolid, roundLanternSolid } from '../tests/lanternFixture.js';

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
  /** The line editor moves the focus to a line in the next frame, which a busy machine can be slow to draw: wait for it
   * (two seconds at most; the checks after it say whether it came) before typing on */
  const lineFocused = (index) =>
    page.waitForFunction((i) => document.activeElement === document.querySelectorAll('#lineList .line-text')[i], index, { timeout: 2000 }).catch(() => {});
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
  const keyed = () => page.evaluate(() => [...document.querySelectorAll('.legend > span')].filter((x) => !x.hidden).map((x) => x.textContent.trim()));
  const base = await (async () => {
    await setText('');
    return download('plaque.stl');
  })();
  check(base.triangles > 100 && base.sizeOk && base.volume > 0, 'plain plaque downloads as a valid watertight STL', `${base.triangles} triangles`);
  const plainKeys = await keyed();
  await setText('Hello\nWorld');
  const textKeys = await keyed();
  check(
    plainKeys.includes('model') && !plainKeys.includes('raised text') && textKeys.includes('raised text') && !textKeys.includes('cut text'),
    'the legend keys raised text once there is some, and no cut text where there is none',
    JSON.stringify({ plainKeys, textKeys }),
  );
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
  await lineFocused(2);
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
  await lineFocused(1);
  await page.keyboard.press('Backspace'); // remove the empty line again
  await idle();
  await lineFocused(0);
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
  await lineFocused(1);
  check((await page.locator('#lineList .line').count()) === 2 && (await page.inputValue('#lineList .line-text >> nth=1')) === 'Birthday', 'pasting multi-line text makes lines', `${await page.locator('#lineList .line').count()} lines`);
  await page.click('#lineList .line-remove >> nth=1');
  await idle();
  await lineFocused(0);
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
  /** The selected item's glyph in the list, and the legend's chips for raised and cut text: the key to the view. */
  const glyphColours = () =>
    page.evaluate(() => {
      const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
      return { glyph: bg('#itemList li[aria-selected="true"] .glyph'), raised: bg('.legend .dot.emboss'), cut: bg('.legend .dot.engrave') };
    });
  const partRaised = await glyphColours();
  await page.check('input[name="mode"][value="engrave"]');
  await idle();
  const partCutter = await glyphColours();
  check(
    partRaised.glyph === partRaised.raised && partCutter.glyph === partCutter.cut && partCutter.cut !== partCutter.raised,
    "a part's glyph in the list is the colour the view draws it: the raised text's, and the cut text's as a cutter",
    JSON.stringify({ partRaised, partCutter }),
  );
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
    const pieceKeys = await page.evaluate(() => [...document.querySelectorAll('.legend > span')].filter((x) => !x.hidden).map((x) => x.textContent.trim()));
    check(
      pieceKeys.includes('pieces') && !pieceKeys.includes('model') && !pieceKeys.includes('raised text'),
      'in the pieces view the legend keys the pieces, not the model or its text, which are drawn in the pieces\' colours',
      JSON.stringify(pieceKeys),
    );
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
        (await page.locator('#splitHint').innerText()) === "Too big for your printer, or want a part to come off – a lantern's top or base, a box's lid? Cut it into pieces that print one by one.",
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
        off: ['joint', 'diameter', 'pins', 'labels', 'depth', 'count'].every((k) => [...document.querySelectorAll(`[data-split="${k}"]`)].every((e) => e.disabled && !!e.closest('[hidden]'))),
        joints: !document.querySelector('#splitJointsLabel').hidden,
        on: ['clearance', 'orient'].every((k) => !document.querySelector(`[data-split="${k}"]`).disabled && !document.querySelector(`[data-split="${k}"]`).closest('[hidden]')) &&
          !document.querySelector('#splitFitTestBtn').disabled,
      }));
      check(
        settings.hint === null && !settings.joints && settings.off && settings.on,
        'with every cut coming apart the joint settings go – nothing is glued; the clearance, how pieces lie and the fit test stay',
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
        (await status()) === 'Nothing to try: these cuts get no lip or tabs, so the pieces just rest on each other.' && /· comes apart: no lip · no lock fits here$/.test((await apartRow()).meta),
        'a cut through the windows comes apart with no lip: the fit test has nothing to try, and the row says no lip, and no lock',
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
          /the tab drops into its socket/.test(tubeTest.status) && !/lid/.test(tubeTest.status) && /· dovetails$/.test(tubeMeta[0]) && /· comes apart: no lip · no lock fits here$/.test(tubeMeta[1]),
        'with a glued cut beside it the joints stay on for that one; the fit test is its dovetail alone, and the tube\'s row then says no lip, and no lock',
        `${JSON.stringify(tubeMixed)} | ${tubeTest.status} | ${tubeMeta.join(' / ')}`,
      );
      // its Locks, which got no lock, is struck through, and says what would hold the top
      const struck = await page.evaluate(() => {
        const label = [...document.querySelectorAll('#cutList li:nth-child(2) .cut-hold label')].find((l) => l.textContent === 'Locks');
        return { struck: label.classList.contains('struck'), checked: label.querySelector('input').checked, title: label.title, line: getComputedStyle(label.querySelector('span')).textDecorationLine };
      });
      check(
        struck.struck && struck.checked && struck.line === 'line-through' && struck.title === 'No clip or twist-lock fits this cut here – try a removable part (+ Removable part)',
        "a cut asked to lock that got no lock has its Locks struck through, saying a removable part would hold",
        JSON.stringify(struck),
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

  console.log('\na newer version out while the page is open');
  {
    // the page asks for the build the site has now, never from a cache: one other than its own says so, with Reload;
    // its own says nothing
    const newer = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    const n = await newer.newPage();
    let asked = 0;
    await n.route('**/version.json*', (route) => {
      asked++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ build: 'a-newer-build' }) });
    });
    await n.goto(url);
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await n.waitForFunction(() => !document.querySelector('#toast').hidden && /newer version/.test(document.querySelector('#toastText').textContent), null, { timeout: 30000 }).catch(() => null);
    const said = await n.evaluate(() => ({ hidden: document.querySelector('#toast').hidden, text: document.querySelector('#toastText').textContent, action: document.querySelector('#toastAction').textContent }));
    const own = await newer.newPage();
    await own.goto(url);
    await own.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    const served = await own.evaluate(async () => (await (await fetch('./version.json', { cache: 'no-store' })).json()).build);
    await own.waitForTimeout(500);
    const quiet = await own.evaluate(() => /newer version/.test(document.querySelector('#toastText').textContent));
    check(
      asked > 0 && !said.hidden && said.text === 'A newer version of STL Text is out – reload to use it (download what you have made first).' && said.action === 'Reload' &&
        typeof served === 'string' && served.length > 0 && !quiet,
      'a page older than the site says a newer version is out, with Reload; the build itself serves its version and says nothing',
      JSON.stringify({ asked, said, served, quiet }),
    );
    await newer.close();
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
    // the second spot (the first is cut A's): Enter adds cut B there, and the list, laid out again, keeps the focus. The
    // parts card's buttons come first (the lantern's base could twist off underneath at a bigger size)
    const partButtons = await p.locator('#partsCard button').count();
    for (let k = 0; k < partButtons + 2; k++) await p.keyboard.press('Tab');
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
    const solidCard = { shown: !(await p.locator('#partsCard').isHidden()), note: await p.locator('#partsNote').innerText().catch(() => ''), parts: await p.locator('#partList li').count() };
    await p.click('#spotsNote button').catch(() => {});
    const startedPlacing = await p.getAttribute('#addApartBtn', 'aria-pressed');
    await p.keyboard.press('Escape');
    check(
      /^No good spot found – pick one on the model yourself:/.test(none.note) && !/click the model/.test(none.note) && none.button === 'Place on model' && startedPlacing === 'true',
      'with nothing to suggest, the note offers to place a cut on the model with its button, never a click that would move the text',
      JSON.stringify({ none, startedPlacing }),
    );
    check(
      solidCard.shown && solidCard.note === "This model is solid all through – there's no inside to open." && solidCard.parts === 0,
      'Suggest spots on a solid block: the parts card says there is no inside to open',
      JSON.stringify(solidCard),
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
    // the parts card was scrolled into view under the button as it listed: the button is brought out from under the
    // view, which stays over the top of the page, as a finger would
    await phone.evaluate(() => {
      const b = document.querySelector('#addApartBtn').getBoundingClientRect();
      const under = document.querySelector('#stage').getBoundingClientRect().bottom;
      if (b.top < under + 8) window.scrollBy(0, b.top - under - 40);
    });
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

  console.log("\nparts that come off: the bat lantern's dome and cap twist-lock inside its handle");
  {
    // the fixture modelled on the user's lantern, 25 × 25 × 50 mm as downloaded: at 100 % no lock fits its dome
    const batFile = writeFixture('batlantern.stl', soupOf(batLanternSolid()));
    const batContext = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
    await batContext.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
      // what the page asks the engine, in order: the split's modes ('parts', 'targets', …) and the previews; and the
      // parts table's answers held back while window.__holdParts (the seconds a dense model takes to find them)
      const Native = window.Worker;
      const posts = (window.__posts = []);
      const partsAsked = new Set();
      window.__heldParts = [];
      window.Worker = class extends Native {
        postMessage(message, transfer) {
          if (message?.type) posts.push(message.type === 'split.plan' ? `split.plan:${message.mode}` : message.type);
          if (message?.type === 'split.plan' && message.mode === 'parts') partsAsked.add(message.id);
          return super.postMessage(message, transfer);
        }
        set onmessage(listener) {
          super.onmessage =
            listener &&
            ((event) => {
              const { id, type } = event.data ?? {};
              if (window.__holdParts && partsAsked.has(id) && type !== 'progress') window.__heldParts.push(() => listener.call(this, event));
              else listener.call(this, event);
            });
        }
        get onmessage() {
          return super.onmessage;
        }
      };
    });
    const posts = () => b.evaluate(() => window.__posts.slice());
    const clearPosts = () => b.evaluate(() => (window.__posts.length = 0));
    const b = await batContext.newPage();
    const batProblems = [];
    b.on('pageerror', (e) => batProblems.push(`pageerror: ${e.message}`));
    b.on('console', (m) => m.type() === 'error' && batProblems.push(`console: ${m.text()}`));
    const settle = async () => {
      await b.waitForTimeout(80);
      await b.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
      await b.waitForTimeout(80);
      await b.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
    };
    const card = () =>
      b.evaluate(() => ({
        hidden: document.querySelector('#partsCard').hidden,
        note: document.querySelector('#partsNote').hidden ? '' : document.querySelector('#partsNote').textContent,
        parts: [...document.querySelectorAll('#partList li')].map((li) => ({
          title: li.querySelector('.part-title').textContent.replace(/\u00a0/g, ' '),
          detail: li.querySelector('.part-detail')?.textContent.replace(/\u00a0/g, ' ') ?? '',
          badge: li.querySelector('.part-badge')?.textContent ?? '',
          buttons: [...li.querySelectorAll('button')].map((x) => x.textContent),
        })),
      }));
    const listed = () => b.waitForFunction(() => !document.querySelector('#partsCard').hidden && !document.querySelector('#partsNote').classList.contains('busy') && document.querySelectorAll('#partList li').length > 0, null, { timeout: 120000 });
    const partRows = () =>
      b.evaluate(() =>
        [...document.querySelectorAll('#cutList > li')].map((li) => ({
          part: li.classList.contains('part'),
          name: li.querySelector('.part-name')?.textContent ?? null,
          z: li.querySelector('[data-part-z]')?.value ?? null,
          zShown: li.querySelector('[data-part-z]') ? !li.querySelector('[data-part-z]').closest('label').hidden : null,
          d: li.querySelector('[data-part-d]')?.value ?? null,
          holds: [...li.querySelectorAll('[data-cut-hold]')].map((r) => ({ value: r.value, checked: r.checked, disabled: r.disabled, title: r.parentElement.title })),
          seat: (() => {
            const box = li.querySelector('[data-part-seat]');
            const label = box?.closest('label');
            return box && !label.hidden ? { checked: box.checked, disabled: box.disabled, text: label.textContent, title: label.title } : null;
          })(),
          meta: li.querySelector('.meta').textContent,
        })),
      );
    const size = () => b.evaluate(() => document.querySelector('#modelInfo').textContent.match(/: ([\d.]+ × [\d.]+ × [\d.]+) mm/)?.[1] ?? null);
    const teal = () =>
      b.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 13) + Math.abs(d[i + 1] - 148) + Math.abs(d[i + 2] - 136) < 40) n++;
        return n;
      });
    // the model's blue-grey with a part's amber mixed in, or the amber itself
    const amberTint = () =>
      b.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 50 && d[i] - d[i + 2] > 40 && d[i + 1] > 0.75 * d[i] && d[i + 1] < d[i]) n++;
        return n;
      });
    await b.goto(url);
    await b.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await b.setInputFiles('#stlFile', batFile);
    await b.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('batlantern:'), null, { timeout: 60000 });
    await settle();
    await b.evaluate(() => (document.querySelector('#toast').hidden = true));
    await b.click('#itemList li:first-child');
    await b.keyboard.press('Delete');
    await settle();

    // + Removable part lists the parts that come off: at 100 % neither locks, each says from what size one does. The
    // engine is asked for the parts first – the card – and only then for what a plane snaps to; and what the page
    // says to do while placing is there to read, at the foot of the panel, not scrolled away under the buttons
    await clearPosts();
    await b.click('#addApartBtn');
    await listed();
    await settle();
    const asked = (await posts()).filter((x) => x.startsWith('split.plan:'));
    const hint = await b.evaluate(() => {
      const el = document.querySelector('#status');
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2);
      return { text: el.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight, onTop: !!top && el.contains(top) };
    });
    check(
      asked[0] === 'split.plan:parts' && asked.includes('split.plan:targets') && hint.text.startsWith('Click a part that lights up') && hint.bottom <= hint.height && hint.onTop,
      "+ Removable part asks for the parts first, and what to do shows at the foot of the panel, over what scrolls under it",
      JSON.stringify({ asked, hint }),
    );
    // the card opens at the foot of the panel, under the bar that holds that hint: it is scrolled into view, whole, the
    // base's row and its button where a click lands on them
    const shownWhole = await b.evaluate(() => {
      const r = document.querySelector('#partsCard').getBoundingClientRect();
      const bar = document.querySelector('.panel .actions').getBoundingClientRect();
      const panel = document.querySelector('.panel').getBoundingClientRect();
      const button = [...document.querySelectorAll('#partList li')].at(-1)?.querySelector('button');
      const br = button?.getBoundingClientRect();
      const hit = br ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) : null;
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), bar: Math.round(bar.top), panel: Math.round(panel.top), button: button?.textContent ?? null, hit: !!hit && hit === button };
    });
    check(
      shownWhole.top >= shownWhole.panel && shownWhole.bottom <= shownWhole.bar && shownWhole.button === 'Make it 300 %' && shownWhole.hit,
      "+ Removable part scrolls the card into view above the bar, whole: the base's Make it 300 % is there to click",
      JSON.stringify(shownWhole),
    );
    // at this size the base is too small for its lock: over it the readout says so, and a click there cuts nothing –
    // a cut across there would take the rest of the lantern off it as its top – but shows its row, lit, its size to press
    const st0 = await b.locator('#stage canvas').boundingBox();
    const readoutLines = () => b.evaluate(() => {
      const el = document.querySelector('#cutReadout');
      return el.hidden ? null : [...el.children].map((c) => c.textContent);
    });
    let smallY = null;
    for (let y = st0.y + st0.height - 12; y > st0.y + st0.height / 2 && smallY == null; y -= 4) {
      await b.mouse.move(st0.x + st0.width / 2, y);
      await b.waitForTimeout(40);
      if ((await readoutLines())?.[0]?.startsWith('Base · too small')) smallY = y - 8;
    }
    await b.mouse.move(st0.x + st0.width / 2, smallY + 1);
    await b.mouse.move(st0.x + st0.width / 2, smallY);
    await b.waitForTimeout(300);
    const overSmall = await readoutLines();
    await b.mouse.click(st0.x + st0.width / 2, smallY);
    await settle();
    const smallClick = {
      rows: (await partRows()).length, pressed: await b.getAttribute('#addApartBtn', 'aria-pressed'), status: await b.locator('#status').innerText(),
      lit: await b.evaluate(() => document.querySelector('#partList li[data-part-kind="plug"]')?.classList.contains('flash') ?? false),
    };
    check(
      smallY != null && overSmall?.[0] === 'Base · too small for a lock at this size – twists off from 215 %' && overSmall?.[1] === 'make it 300 % to take it out – click for its row' &&
        smallClick.rows === 0 && smallClick.pressed === 'true' && smallClick.lit &&
        smallClick.status === 'The base is too small for its twist-lock at this size – it twists off underneath from 215 %. Make it 300 % (in Parts that come off), then click it again.',
      'a click on the base while it is too small for its lock places no cut across – it would take the top off – but says why and lights its row, its size offered',
      JSON.stringify({ smallY, overSmall, smallClick }),
    );
    await b.keyboard.press('Escape');
    await settle();
    const small = await card();
    const [dome, base] = small.parts;
    check(
      !small.hidden && small.parts.length === 2 &&
        dome.title === 'Dome and cap – comes off inside the handle; the handle stays on the lantern.' &&
        dome.detail === 'Too small for a lock at this size: its roof is 0.7 mm thick. A twist-lock fits from 275 % (a 24 mm opening); a 38 mm tea light fits through it from 365 %.' &&
        JSON.stringify(dome.buttons) === JSON.stringify(['Make it 300 %', 'Make it 400 %', 'Use – it just lifts off']) &&
        base.title === 'Base – twists off underneath once the model is 215 % or bigger.' &&
        base.detail === 'Too small for its twist-lock at this size: its bottom is Ø 19 mm across, and the lock needs Ø 39 mm. A 38 mm tea light fits through it from 275 %; at 300 % it twists off and takes a tea light.' &&
        JSON.stringify(base.buttons) === JSON.stringify(['Make it 300 %']),
      '+ Removable part lists the dome and cap inside the handle and the base, each too small to lock at 100 % and from what size one fits',
      JSON.stringify(small),
    );
    check(
      /^No good place for a cut across the whole model – use a part above, or pick a place on the model yourself:/.test(await b.locator('#spotsNote').innerText()),
      "with parts listed, the spots' note points to them where no cut across the whole model does well",
      await b.locator('#spotsNote').innerText(),
    );
    check(
      await b.evaluate(() => document.querySelector('#partList .part-detail').textContent.includes('from 275\u00a0% (a 24\u00a0mm opening)')),
      'a number in the card keeps its unit on its line',
    );
    // the card's [Make it 300 %]: the model three times as big, framed in the view as it was, and the card lists the
    // parts at that size; an undo brings back 100 %
    const modelPixels = () =>
      b.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 40) n++;
        return n;
      });
    const shown100 = await modelPixels();
    // pressed while a part is being picked on the model: picking goes on, among the parts at the new size
    await b.click('#addApartBtn');
    await settle();
    await b.locator('#partList li').nth(1).locator('button', { hasText: 'Make it 300 %' }).click();
    await settle();
    await listed();
    await settle();
    const shown300 = await modelPixels();
    const at300 = { size: await size(), first: (await card()).parts[0]?.title, picking: await b.getAttribute('#addApartBtn', 'aria-pressed') };
    await b.keyboard.press('Escape');
    await settle();
    check(
      at300.size === '75.0 × 75.0 × 150.0' && /^Dome and cap – twist-lock/.test(at300.first ?? '') && shown300 > 0.5 * shown100 && shown300 < 2 * shown100 && at300.picking === 'true',
      "the card's Make it 300 % scales the model, shows it whole at its new size, and lists the dome and cap's twist-lock; picking a part goes on",
      JSON.stringify({ at300, shown100, shown300 }),
    );
    await b.click('#undoBtn');
    await settle();
    await listed();
    await settle();
    check((await size()) === '25.0 × 25.0 × 50.0' && (await card()).parts[0].title === dome.title, 'undo brings back 100 % and the card lists the parts at that size', await size());

    // Use – it just lifts off: a part row, its circle on the model; Twist-lock struck through and saying from what size
    const before = await teal();
    await b.locator('#partList li').first().locator('button', { hasText: 'Use – it just lifts off' }).click();
    await settle();
    const [lifting] = await partRows();
    const lockRadio = lifting?.holds.find((h) => h.value === 'lock');
    check(
      lifting?.part && lifting.name === 'Dome and cap' && lifting.z === '29' && lifting.d === '15.7' && lockRadio.disabled && !lockRadio.checked &&
        lockRadio.title === 'No twist-lock fits at this size – from 275 %' && lifting.holds.find((h) => h.value === 'lift').checked &&
        lifting.meta === 'lifts off – too small for a lock here (twist-lock from 275 %)',
      "Use – it just lifts off adds the part's row: Z, Ø, Twist-lock struck through with the size that fits one, lifting off",
      JSON.stringify(lifting),
    );
    // amber, as it only lifts off at this size: its outline, and its material from its face up to its cap tinted
    const drawn = await teal();
    const tinted = await amberTint();
    check(drawn < before + 50 && tinted > 1000, "the part's circle is drawn on the model in amber, its material tinted: at this size it only lifts off", JSON.stringify({ before, drawn, tinted }));
    check(
      (await b.locator('#downloadBtn').innerText()) === 'Download 2 pieces (.zip)' && /2 · Dome and cap · Ø 15\.7 mm · comes off at A/.test(await b.locator('#pieceList').innerText()),
      'the part is a piece of its own before it is cut: the download and the pieces list count it',
      `${await b.locator('#downloadBtn').innerText()} | ${await b.locator('#pieceList').innerText()}`,
    );
    check(
      (await card()).parts[0].buttons.join('|') === 'Make it 300 %|Make it 400 %|Cut A takes it out',
      'the card offers the cut that takes the part out, not a second one, and still the sizes its lock and a tea light fit from',
      JSON.stringify((await card()).parts[0]),
    );
    // nothing holds it at this size: the fit test has no rings to try, and says why
    await b.click('#splitFitTestBtn');
    await settle();
    check(
      (await b.locator('#status').innerText()) === 'Nothing to try: the dome and cap lift off at this size – a twist-lock fits from 275 %.',
      'Download fit test with only a part that lifts off says it lifts off at this size and from what size a twist-lock fits',
      await b.locator('#status').innerText(),
    );

    // its pieces at 100 %: the note says why no lock fits and from what size one does, and offers that size
    await b.click('#showPiecesBtn');
    await settle();
    const smallNote = await b.locator('#splitNotes').innerText();
    const noteSizes = await b.locator('#splitNotes button').allInnerTexts();
    check(
      smallNote.includes('Cut A: the dome is 0.7 mm thick here and slopes 30° – too thin for a twist-lock at 100 %. A twist-lock fits from 275 % (a 24 mm opening); a 38 mm tea light needs 365 %. The base can twist off from 215 %. At this size the dome and cap just lift off.') &&
        noteSizes.filter((t) => /^Make it/.test(t)).join('|') === 'Make it 300 %|Make it 400 %',
      'its note at 100 % says the dome is too thin for a twist-lock, from what size one fits and a tea light does, and offers both sizes',
      `${smallNote} | ${JSON.stringify(noteSizes)}`,
    );
    // the note's Make it 300 %: the part placed again by the finder for that size – its face on the layers at 86, not
    // 87 – and now it twist-locks, its hold never touched; one undo takes back both
    await b.locator('#splitNotes button', { hasText: 'Make it 300 %' }).click();
    await settle();
    await listed();
    await settle();
    const big = await card();
    const [locking] = await partRows();
    const stillPieces = { shown: await b.isChecked('#resultToggle'), pieces: (await b.locator('#pieceList').innerText()).split('\n').filter(Boolean) };
    check(
      (await size()) === '75.0 × 75.0 × 150.0' && locking.z === '86' && locking.d === '47.3' && locking.holds.find((h) => h.value === 'lock').checked &&
        !locking.holds.find((h) => h.value === 'lock').disabled && locking.meta === 'twist-lock, 3 lugs, 3 clicks – turn 27° · the handle stays',
      'Make it 300 % scales the model and places the part again for it: at Z 86 it twist-locks, 3 lugs and 3 clicks, the handle staying',
      JSON.stringify({ size: await size(), locking }),
    );
    check(
      stillPieces.shown && stillPieces.pieces.length === 2 && /twist-lock socket, 3 clicks$/.test(stillPieces.pieces[1]),
      "the note's Make it 300 % stays in the pieces view: the pieces at the new size, the lid with its twist-lock",
      JSON.stringify(stillPieces),
    );
    check(
      big.parts[0].title === 'Dome and cap – twist-lock · Ø 29 mm opening · the handle stays · a 38 mm tea light fits through the base, not the lid' &&
        big.parts[0].badge === "the lantern's collar needs the dome's support" &&
        big.parts[1].title === "Base – twists off underneath · twist-lock · Ø 43 mm opening, takes a 38 mm tea light · a seat for it on top, in place of the model's own detail there" &&
        big.parts[1].badge === 'no extra support' && JSON.stringify(big.parts[1].buttons) === JSON.stringify(['Use']),
      "at 300 % the card lists the dome and cap with its twist-lock and the base with its own and a tea-light seat in place of its cup, each with its print badge",
      JSON.stringify(big),
    );
    await b.click('#undoBtn');
    await settle();
    const undone = { size: await size(), rows: await partRows() };
    await b.click('#redoBtn');
    await settle();
    check(
      undone.size === '25.0 × 25.0 × 50.0' && undone.rows.length === 1 && undone.rows[0].z === '29' && (await size()) === '75.0 × 75.0 × 150.0' && (await partRows())[0].z === '86',
      'one undo takes back the Scale and the part placed again for it, one redo brings both',
      JSON.stringify(undone),
    );

    // the base as well: its row has no Z (its face is the model's bottom), and three pieces
    await b.locator('#partList li').nth(1).locator('button', { hasText: /^Use$/ }).click();
    await settle();
    const withBase = await partRows();
    check(
      withBase.length === 2 && withBase[1].name === 'Base' && withBase[1].zShown === false && withBase[1].meta.startsWith('twist-lock, 3 lugs – turn 23° · coin slot · ') &&
        (await b.locator('#downloadBtn').innerText()) === 'Download 3 pieces (.zip)',
      "Use on the base adds its row – no Z, its twist-lock with its coin slot – and a third piece",
      JSON.stringify(withBase),
    );
    // its own cup stands in the middle of its top, where the light is to go: the tea-light seat takes its place, and the
    // row says so, and how to keep the cup
    check(
      withBase[1].meta === "twist-lock, 3 lugs – turn 23° · coin slot · tea-light seat Ø 39.5 mm in place of the model's own detail" && !withBase[1].seat?.disabled &&
        withBase[1].seat.checked && withBase[1].seat.text === 'Tea-light seat Ø 39.5 mm' &&
        /, in place of the model's own detail there \(5\.\d mm proud, Ø 26 mm across\) – untick it to keep that$/.test(withBase[1].seat.title) &&
        withBase[0].seat === null,
      "the base's row has its Tea-light seat on in place of its own cup, saying so and how to keep the cup; the lid's has none",
      JSON.stringify(withBase),
    );
    await b.click('#undoBtn');
    await settle();
    check((await partRows()).length === 1, 'undo takes the base out again', JSON.stringify(await partRows()));

    // Show pieces: the lantern with its neck and the dome and cap with its socket, and the notes that say how it
    // twists on, how it prints and the fit test first (worked out already at this size: the box shows them)
    await b.check('#resultToggle');
    await settle();
    await b.waitForTimeout(500);
    await settle();
    const pieces = (await b.locator('#pieceList').innerText()).split('\n').filter(Boolean);
    const notes = await b.locator('#splitNotes').innerText();
    check(
      pieces.length === 2 && /^1 · Lantern, with the handle · 75 × 75 × 150 mm · .* · twist-lock neck, 3 lugs$/.test(pieces[0]) &&
        /^2 · Dome and cap · .* · comes off at A · twist-lock socket, 3 clicks$/.test(pieces[1]),
      'Show pieces lists the lantern with the twist-lock neck and the dome and cap with its socket',
      JSON.stringify(pieces),
    );
    check(
      notes.includes('Cut A: the dome and cap (piece 2) twist-lock onto piece 1 and the handle stays on piece 1. To fit it: set it on turned 27° to the left') &&
        notes.includes('its slots and click tabs are bridged (10.5 mm or less)') && notes.includes('Print the fit test first (Download fit test): two rings Ø 40 mm, about 5 g.'),
      "the notes say how the dome and cap twist-lock on, that its 10.5 mm bridges need no support, and to print the fit test first",
      notes,
    );
    const metaShown = (await partRows())[0].meta;
    check(metaShown === 'twist-lock, 3 lugs, 3 clicks – turn 27° · the handle stays', "the row says what the pieces got", metaShown);
    // nothing is glued: the glued cuts' settings are not there to puzzle over, the legend keys only what is drawn (no
    // text, and the pieces in their own colours), and the button and the box say the same
    const tidy = await b.evaluate(() => {
      // in the panel, folded away or not: not hidden itself, nor in something hidden
      const shown = (el) => !!el && !el.closest('[hidden]');
      return {
        glued: ['joint', 'diameter', 'pins', 'labels', 'depth', 'count'].filter((k) => [...document.querySelectorAll(`[data-split="${k}"]`)].some(shown)),
        kept: ['clearance', 'orient'].filter((k) => shown(document.querySelector(`[data-split="${k}"]`))),
        joints: shown(document.querySelector('#splitJointsLabel')),
        legend: [...document.querySelectorAll('.legend > span')].filter((x) => !x.hidden).map((x) => x.textContent.trim()),
        button: document.querySelector('#showPiecesBtn').textContent,
        box: document.querySelector('#resultLabel').textContent,
      };
    });
    check(
      tidy.glued.length === 0 && tidy.kept.length === 2 && !tidy.joints && JSON.stringify(tidy.legend) === JSON.stringify(['comes apart', 'pieces', 'lock', 'lugs']) &&
        tidy.button === tidy.box,
      "with only a part taken out, the pieces panel shows no glue settings, and the legend keys the pieces, the lock and its lugs, nothing else",
      JSON.stringify(tidy),
    );

    // the lock in the view: painted orange on the pieces, the lid moving out along its way on the Spread slider and ▶,
    // looked at close, and as printed. What the canvas shows, by colour: the lock's orange, the lid's gold (where its
    // middle is), the red and yellow of an overhang and a bridge as printed, the teal and amber of a part's circle
    const view = () =>
      b.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const out = { orange: 0, gold: 0, x: 0, y: 0, red: 0, yellow: 0, tealish: 0, amber: 0, blue: 0, label: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, bl] = [d[i], d[i + 1], d[i + 2]];
          // a piece's number: its dark disc over the lantern's blue, or over the lid's gold
          const overBlue = r >= 26 && r <= 46 && g >= 42 && g <= 62 && bl >= 64 && bl <= 88;
          const overGold = r >= 42 && r <= 62 && g >= 42 && g <= 62 && bl >= 38 && bl <= 58 && Math.abs(r - g) < 10;
          if (d[i + 3] > 200 && (overBlue || overGold)) out.label++;
          // the lantern's own blue, solid (faded round a lock, the view behind shows through: the canvas is clear there)
          if (bl > 150 && bl - r > 100 && d[i + 3] > 230) out.blue++;
          if (r > 150 && bl < 70 && g < 0.62 * r && g > 0.25 * r) out.orange++;
          if (bl > 50 && r - bl > 40 && g > 0.75 * r && g < r) {
            out.gold++;
            out.x += (i / 4) % probe.width;
            out.y += Math.floor(i / 4 / probe.width);
          }
          if (r > 150 && g < 80 && bl > 40 && bl < 130) out.red++;
          if (r > 200 && g > 170 && bl < 90) out.yellow++;
          if (g - r > 55 && bl > r) out.tealish++;
          if (r > 200 && g > 120 && g < 190 && bl < 60) out.amber++;
        }
        out.x = out.gold ? Math.round(out.x / out.gold) : null;
        out.y = out.gold ? Math.round(out.y / out.gold) : null;
        return out;
      });
    const lockUi = () =>
      b.evaluate(() => ({
        panel: !document.querySelector('#lockPanel').hidden,
        play: !document.querySelector('#playWayBtn').hidden,
        look: !document.querySelector('#lookLockBtn').hidden,
        chip: !document.querySelector('#legendLock').hidden,
        lugs: !document.querySelector('#legendLugs').hidden,
        over: !document.querySelector('#legendOver').hidden,
        printed: document.querySelector('#asPrintedToggle').checked,
        spreadShown: !document.querySelector('#spreadField').hidden,
        spread: Number(document.querySelector('#spreadRange').value),
        caption: document.querySelector('#wayCaption').hidden ? null : document.querySelector('#wayCaption').textContent,
      }));
    const spreadTo = async (f) => {
      await b.locator('#spreadRange').fill(String(f));
      await b.waitForTimeout(150);
      return { ...(await view()), caption: (await lockUi()).caption };
    };
    await b.mouse.move(700, 840); // nothing pointed at
    const apart = await view();
    const ui = await lockUi();
    check(
      ui.panel && ui.play && ui.look && ui.chip && !ui.over && apart.orange > 800,
      "the pieces view paints the twist-lock's own faces orange – the lantern's neck, out from under the lid – with a lock chip in the legend, ▶ and Look at the lock",
      JSON.stringify({ ui, apart }),
    );
    // its lugs in a colour of their own, standing out of the neck they are on, with their own chip
    check(ui.lugs && apart.yellow > 20, "the lugs are painted yellow on the orange neck, and the legend says which are the lugs", JSON.stringify({ ui, yellow: apart.yellow }));
    // Spread: seated at 0 (the neck hidden under the lid); the first third turns it (nothing moves off the axis), the
    // second lifts it, the last slides it out under the handle; the view says which step it is on
    const seated = await spreadTo(0);
    const turned = await spreadTo(0.3);
    const rising = await spreadTo(0.5);
    const lifted = await spreadTo(0.65);
    const sliding = await spreadTo(0.85);
    const out1 = await spreadTo(1);
    check(
      seated.orange < 50 && seated.caption === null && Math.abs(turned.x - seated.x) <= 2 && Math.abs(turned.y - seated.y) <= 2 &&
        turned.caption === 'Dome and cap: 1 of 3 · Turn it 27° to the left – it clicks free' && rising.caption === 'Dome and cap: 2 of 3 · Lift it 4.5 mm' &&
        lifted.y <= seated.y - 6 && Math.abs(lifted.x - seated.x) <= 3 && sliding.caption === 'Dome and cap: 3 of 3 · Slide it out under the handle, square to it' &&
        Math.hypot(out1.x - seated.x, out1.y - seated.y) > 80 && out1.caption === null && out1.orange > 800,
      'on the Spread slider the lid turns free in place, lifts, then slides out under the handle, and the view says each step',
      JSON.stringify({ seated, turned, rising, lifted, sliding, out1 }),
    );
    // ▶ plays it from seated to out, the slider following, seen across the slide – here, looking along it, the view
    // turns square to it so the lid is seen passing under the handle, not into the view through a leg; Shift+▶ plays
    // it going on again, its words the steps the other way round
    await b.click('#playWayBtn');
    await b.waitForTimeout(120);
    const early = { ...(await view()), spread: (await lockUi()).spread };
    await b.waitForTimeout(2900);
    const played = { ...(await view()), ...(await lockUi()) };
    const goingOn = [];
    await b.click('#playWayBtn', { modifiers: ['Shift'] });
    for (let t = 0; t < 3000; t += 40) {
      const c = (await lockUi()).caption;
      if (c && goingOn.at(-1) !== c) goingOn.push(c);
      await b.waitForTimeout(40);
    }
    const back = { ...(await view()), ...(await lockUi()) };
    const across = { dx: played.x - early.x, dy: played.y - early.y };
    check(
      early.spread < 0.3 && played.spread === 1 && Math.abs(across.dx) > 80 && Math.abs(across.dx) > 2 * Math.abs(across.dy) && played.caption === null &&
        back.spread === 0 && back.orange <= early.orange + 20 && back.orange < 0.2 * played.orange,
      '▶ shows the lid coming apart, from seated to out, the slider following, the view turned to see it slide across, under the handle',
      JSON.stringify({ early, played, across, back }),
    );
    check(
      JSON.stringify(goingOn) === JSON.stringify([
        'Dome and cap: 1 of 3 · Slide it in under the handle, square to it',
        'Dome and cap: 2 of 3 · Lower it 4.5 mm into place',
        'Dome and cap: 3 of 3 · Turn it 27° to the right – it clicks shut',
      ]),
      'Shift+▶ says how it goes on, step by step: slide it in, lower it, turn it right until it clicks shut',
      JSON.stringify(goingOn),
    );
    await spreadTo(1);
    // pointing at the part's row lights its lock
    const unlit = await view();
    await b.hover('#cutList li.part .part-name');
    await b.waitForTimeout(150);
    const lit = await view();
    await b.mouse.move(700, 840);
    await b.waitForTimeout(150);
    const after = await view();
    // (the lugs' yellow against the neck's orange leaves an edge of amber unlit)
    const glow = Math.max(unlit.amber, 10);
    check(lit.amber > 4 * glow && after.amber < 2 * glow, "pointing at the part's row makes its lock glow", JSON.stringify({ unlit: unlit.amber, lit: lit.amber, after: after.amber }));
    check(lit.blue < 0.5 * unlit.blue, "and the pieces fade round it, so all of the lock shows", JSON.stringify({ unlit, lit }));
    // Look at the lock: close on the neck, the lid set down beside it, the lock glowing
    await b.click('#lookLockBtn');
    await b.waitForTimeout(200);
    const close = { ...(await view()), spread: (await lockUi()).spread };
    check(close.orange > 5 * apart.orange && close.spread === 1, 'Look at the lock brings the camera close on it: its orange fills the view', JSON.stringify({ close, apart: apart.orange }));
    // close on it, what is what: a lug on the neck, a slot and a click tab in the lid, each named over it in the view
    const words = await b.evaluate(() => {
      const stage = document.querySelector('#stage').getBoundingClientRect();
      return [...document.querySelectorAll('#stage .lock-word')].filter((x) => !x.hidden).map((x) => {
        const r = x.getBoundingClientRect();
        return { text: x.textContent, inside: r.left >= stage.left && r.right <= stage.right && r.top >= stage.top && r.bottom <= stage.bottom };
      });
    });
    check(
      words.map((x) => x.text).sort().join('|') === 'click tab|lug|slot' && words.every((x) => x.inside) && close.yellow > 5 * apart.yellow && close.label < 120,
      'Look at the lock names a lug, a slot and a click tab on the pieces, the lugs yellow close up, with no piece number over them',
      JSON.stringify({ words, yellow: close.yellow }),
    );
    // As printed: each piece on the bed as it prints; the collar's 60° underside red, the lid's bridged ceilings outlined
    await b.click('#frameBtn');
    await b.click('#asPrintedToggle');
    await b.waitForTimeout(200);
    const printed = { ...(await view()), ...(await lockUi()) };
    await b.click('#asPrintedToggle');
    await b.waitForTimeout(200);
    const unprinted = await view();
    check(
      printed.red > 500 && printed.yellow > 200 && printed.over && !printed.spreadShown && unprinted.red < 20 && unprinted.yellow < 20 + 2 * apart.yellow,
      'As printed shows what the lock adds that overhangs in red – the collar under the face – and outlines its bridges',
      JSON.stringify({ printed, unprinted: { red: unprinted.red, yellow: unprinted.yellow } }),
    );
    // ▶ from As printed: the pieces spread along their ways again, and the box, its chips and the Spread slider say so
    // from the start, and after
    await b.click('#asPrintedToggle');
    await b.waitForTimeout(200);
    await b.click('#playWayBtn');
    await b.waitForTimeout(1200);
    const playing = await lockUi();
    await b.waitForTimeout(2000);
    const playedOut = await lockUi();
    check(
      !playing.printed && !playing.over && playing.spreadShown && !playedOut.printed && playedOut.spreadShown && playedOut.spread === 1,
      '▶ pressed as printed plays the pieces spread along their ways, As printed off and the Spread slider there throughout',
      JSON.stringify({ playing, playedOut }),
    );
    // As printed goes with the pieces: shown again, they are spread, never laid out with nothing on screen to undo it
    await b.click('#asPrintedToggle');
    await b.waitForTimeout(200);
    await b.click('#resultToggle');
    await settle();
    await b.click('#resultToggle');
    await settle();
    await b.waitForTimeout(200);
    const shownAgain = await lockUi();
    check(!shownAgain.printed && shownAgain.spreadShown && shownAgain.panel, 'the pieces shown again after As printed are spread apart, the Spread slider back', JSON.stringify(shownAgain));
    // on the model: the part tinted teal from its face to its cap, its lugs marked; the row's ▶ shows the pieces and plays
    await b.click('#resultToggle');
    await settle();
    await b.waitForTimeout(200);
    const onModel = await view();
    check(onModel.tealish > 1000 && onModel.amber < 10, "on the model the part that locks is tinted teal, inside its circle", JSON.stringify(onModel));
    check(await b.isVisible('#cutList li.part [data-part-play]'), "the part's row has ▶");
    await b.click('#cutList li.part [data-part-play]');
    await settle();
    await b.waitForTimeout(3000);
    const fromRow = await lockUi();
    check((await b.isChecked('#resultToggle')) && fromRow.spread === 1 && fromRow.panel, "the row's ▶ shows the pieces and plays the lid coming out", JSON.stringify(fromRow));

    // on a laptop's width the legend's chips – the lock's colours among them – wrap beside the view's tools, never
    // under them, as printed too
    const covered = () =>
      b.evaluate(() => {
        const tools = [...document.querySelectorAll('.stage-tools > *')].filter((x) => !x.hidden).map((x) => x.getBoundingClientRect());
        return [...document.querySelectorAll('.legend > span')].filter((x) => !x.hidden).flatMap((x) => {
          const r = x.getBoundingClientRect();
          return tools.some((t) => Math.min(r.right, t.right) - Math.max(r.left, t.left) > 0 && Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top) > 0) ? [x.textContent.trim()] : [];
        });
      });
    const under = {};
    for (const width of [1024, 1180]) {
      await b.setViewportSize({ width, height: 850 });
      await b.waitForTimeout(250);
      under[width] = await covered();
      await b.click('#asPrintedToggle');
      await b.waitForTimeout(250);
      under[`${width} as printed`] = await covered();
      await b.click('#asPrintedToggle');
      await b.waitForTimeout(150);
    }
    check(Object.values(under).every((x) => x.length === 0), "at 1024 and 1180 px no chip of the legend lies under the view's tools", JSON.stringify(under));

    // the download: two pieces, each one solid, the dome and cap lying on its face; the glue sheet says to twist it on.
    // At 1024 px, what the engine is doing shows over the lock's tools, never on them
    await b.setViewportSize({ width: 1024, height: 850 });
    await b.waitForTimeout(250);
    await b.evaluate(() => {
      const watch = (window.__pill = { seen: 0, over: [] });
      watch.timer = setInterval(() => {
        const pill = document.querySelector('#progress');
        if (pill.hidden) return;
        watch.seen++;
        const a = pill.getBoundingClientRect();
        for (const el of [...document.querySelectorAll('#lockPanel button, #lockPanel label')].filter((x) => !x.closest('[hidden]'))) {
          const r = el.getBoundingClientRect();
          const w = Math.min(a.right, r.right) - Math.max(a.left, r.left);
          const h = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
          if (w > 0 && h > 0) watch.over.push(el.textContent.trim());
        }
      }, 15);
    });
    const [dl] = await Promise.all([b.waitForEvent('download', { timeout: 120000 }), b.click('#downloadBtn')]);
    const zipFile = path.join(out, 'batlantern.zip');
    await dl.saveAs(zipFile);
    await settle();
    const pill = await b.evaluate(() => {
      clearInterval(window.__pill.timer);
      return { seen: window.__pill.seen, over: [...new Set(window.__pill.over)] };
    });
    await b.setViewportSize({ width: 1400, height: 850 });
    await b.waitForTimeout(250);
    check(pill.seen > 0 && pill.over.length === 0, "the progress shows over the lock's tools while the pieces are saved, not on them", JSON.stringify(pill));
    const zip = unzipSync(new Uint8Array(fs.readFileSync(zipFile)));
    const stls = Object.keys(zip).filter((n) => n.endsWith('.stl')).sort();
    const shells = stls.map((n) => {
      const m = geometryToManifold(parseSTL(zip[n].buffer.slice(zip[n].byteOffset, zip[n].byteOffset + zip[n].byteLength)));
      const parts = m.decompose();
      const bb = m.boundingBox();
      const out = { n: parts.length, min: bb.min[2], h: bb.max[2] - bb.min[2] };
      parts.forEach((x) => x.delete());
      m.delete();
      return out;
    });
    const glue = strFromU8(zip[Object.keys(zip).find((n) => n.endsWith('.txt'))]);
    check(
      stls.length === 2 && shells.every((x) => x.n === 1) && Math.abs(shells[0].h - 150) < 0.01 && shells[1].min === 0 && shells[1].h < 31,
      'the zip holds the lantern and the dome and cap, each one solid, the lid lying on its cut face',
      JSON.stringify({ stls, shells }),
    );
    check(
      glue.includes('turn it right until it clicks') && glue.includes('twist-lock neck for cut A') &&
        glue.includes("The dome and cap (cut A) should twist on with a click and twist off again by hand. Try the fit test first"),
      'the glue sheet says the lantern carries the neck, how to twist the dome and cap on, and to try the fit test first',
      glue,
    );
    // the fit test: the twist-lock on two rings, as the note says
    const [fit] = await Promise.all([b.waitForEvent('download', { timeout: 120000 }), b.click('#splitFitTestBtn')]);
    await fit.saveAs(path.join(out, 'batlantern-fit-test.stl'));
    await settle();
    check(/Two rings Ø 40 mm with the twist-lock at this size \(about 5 g\)/.test(await b.locator('#status').innerText()), 'Download fit test gives the twist-lock on two rings, Ø 40 mm as the note says', await b.locator('#status').innerText());

    // Lifts off chosen: nothing holds it, and the row says so
    await b.evaluate(() => [...document.querySelectorAll('#cutList li.part .cut-hold label')].find((l) => l.textContent === 'Lifts off').click());
    await settle();
    check((await partRows())[0].meta === 'lifts off – sits on its cut face', 'Lifts off chosen: the row says it sits on its cut face', (await partRows())[0].meta);
    // no lock is painted, nor offered to look at, and the part on the model is amber
    await b.waitForTimeout(400);
    await settle();
    const plain = { ...(await view()), ...(await lockUi()) };
    check(plain.orange < 20 && !plain.chip && !plain.look && plain.play, 'lifting off, the pieces show no lock and offer none to look at; ▶ still shows how it comes off', JSON.stringify(plain));
    await b.click('#resultToggle');
    await settle();
    await b.waitForTimeout(200);
    const amberModel = { ...(await view()), tint: await amberTint() };
    check(amberModel.tint > 3000 && amberModel.tealish < 300, 'on the model a part that only lifts off is tinted amber', JSON.stringify(amberModel));

    // click to pick: + Removable part, and the part under the pointer lights up – gold, the handle it leaves on drawn in
    // blue – and the readout says what it gets; a click takes it out as the finder places it, as one undo step
    console.log('\nclick to pick a part on the bat lantern');
    await b.click('#splitClearBtn');
    await settle();
    const pickColours = () =>
      b.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const o = { gold: 0, stays: 0, dark: 0, x: 0, y: 0, teal: 0, tx: 0, ty: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, bl] = [d[i], d[i + 1], d[i + 2]];
          // the model's own surface tinted gold, and the handle blue: opaque (the faint walls round the part, over the
          // page behind the view, read back as gold seen through)
          const solid = d[i + 3] > 200;
          if (solid && r > 170 && g > 130 && g < 0.92 * r && bl < 100) o.gold++;
          if (solid && bl > 120 && bl - r > 90 && bl > g) o.stays++;
          // a part that locks, tinted teal: where its middle is on screen
          if (g - r > 55 && bl > r) {
            o.teal++;
            o.tx += (i / 4) % probe.width;
            o.ty += Math.floor(i / 4 / probe.width);
          }
          // a selected part's ring handle, the dark dot on its circle
          if (r < 40 && g < 45 && bl < 60 && d[i + 3] > 200) {
            o.dark++;
            o.x += (i / 4) % probe.width;
            o.y += Math.floor(i / 4 / probe.width);
          }
        }
        const scale = c.getBoundingClientRect().width / probe.width;
        if (o.dark) [o.x, o.y] = [Math.round((o.x / o.dark) * scale), Math.round((o.y / o.dark) * scale)];
        if (o.teal) [o.tx, o.ty] = [Math.round((o.tx / o.teal) * scale), Math.round((o.ty / o.teal) * scale)];
        return o;
      });
    const pickReadout = () =>
      b.evaluate(() => {
        const el = document.querySelector('#cutReadout');
        return el.hidden ? null : { lines: [...el.children].map((c) => c.textContent), verdict: el.dataset.verdict };
      });
    const restAt = async (x, y) => {
      await b.mouse.move(x, y + 1);
      await b.mouse.move(x, y);
      await b.waitForTimeout(300);
      await settle();
    };
    await b.click('#addApartBtn');
    await listed();
    await settle();
    const pickStatus = await b.locator('#status').innerText();
    // the places to cut across, listed under the parts: each would take the handle off with the top, and says so
    const spotTexts = await b.locator('#spotList .spot').allInnerTexts();
    check(
      spotTexts.length > 0 && spotTexts.every((t) => t.endsWith(' – takes the handle with the top')),
      'the spots for a cut across the whole lantern say each would take the handle with the top',
      JSON.stringify(spotTexts),
    );
    const stage = await b.locator('#stage canvas').boundingBox();
    const px = stage.x + stage.width / 2;
    // down the middle of the view: what the readout says at each height
    const said = [];
    for (let y = stage.y + 30; y < stage.y + stage.height - 20; y += 6) {
      await b.mouse.move(px, y);
      await b.waitForTimeout(40);
      const r = await pickReadout();
      if (r) said.push([y, r.lines]);
    }
    const middleOf = (re) => {
      const pickAt = said.filter(([, lines]) => lines.some((l) => re.test(l))).map(([y]) => y);
      return pickAt[Math.floor(pickAt.length / 2)];
    };
    const pickAt = { dome: middleOf(/^Dome and cap come off/), handle: middleOf(/^The handle stays/), band: middleOf(/^A cut here would take the handle/), base: middleOf(/^Base twists off/) };
    check(
      pickStatus === 'Click a part that lights up to take it out, or the model where it should come apart – it snaps to ledges and good spots; hold Alt to place it freely. Shift+click to place more. Esc stops.' &&
        Object.values(pickAt).every(Number.isFinite) && pickAt.handle < pickAt.dome && pickAt.dome < pickAt.band && pickAt.band < pickAt.base,
      '+ Removable part says a click on a part takes it out; down the lantern the readout finds the handle, the dome, the band under them and the base',
      JSON.stringify({ pickStatus, pickAt }),
    );
    await restAt(px, pickAt.dome);
    const onDome = { ...(await pickReadout()), ...(await pickColours()) };
    await restAt(px, pickAt.handle);
    const onHandle = { ...(await pickReadout()), ...(await pickColours()) };
    await restAt(px, pickAt.band);
    const onBand = { ...(await pickReadout()), ...(await pickColours()) };
    await restAt(px, pickAt.base);
    const onBase = { ...(await pickReadout()), ...(await pickColours()) };
    await b.screenshot({ path: path.join(out, '20-pick-base.png') });
    await restAt(px, pickAt.dome);
    await b.screenshot({ path: path.join(out, '20-pick-dome.png') });
    check(
      JSON.stringify(onDome.lines) === JSON.stringify(['Dome and cap come off · twist-lock, 3 lugs, turn 27° · Ø 29 mm opening · the handle stays']) && onDome.verdict === 'full' &&
        onDome.gold > 4000 && onDome.stays > 800,
      'over the dome its readout says the dome and cap come off with their twist-lock, the handle staying; the part is gold, the handle outlined in blue',
      JSON.stringify(onDome),
    );
    check(
      onHandle.lines[0] === 'The handle stays on the lantern – click to take off the dome and cap under it' && onHandle.gold > 4000 && onHandle.stays > 800,
      'over the handle the readout says it stays on the lantern, and the dome and cap under it light up',
      JSON.stringify(onHandle),
    );
    check(
      onBand.lines[0] === 'A cut here would take the handle with the top – click the dome to take off just the lid' && onBand.verdict !== 'full' &&
        onBand.gold < onDome.gold / 2 && onBand.stays < 100,
      'under the handle a cut across would take it with the top: the readout says so first, and never shows it as a good place; nothing lights up',
      JSON.stringify(onBand),
    );
    // low on the lantern, where the top a cut takes is most of it, the readout does not say it again and again
    await restAt(px, Math.round((pickAt.band + pickAt.base) / 2));
    const lowDown = await pickReadout();
    check(!!lowDown && !lowDown.lines.some((l) => l.startsWith('A cut here would take the handle')), 'lower down the lantern the readout leaves the handle out', JSON.stringify(lowDown));
    check(
      JSON.stringify(onBase.lines) === JSON.stringify(['Base twists off underneath · Ø 43 mm opening · twist-lock, 3 lugs, turn 23°']) && onBase.gold > 1000,
      'over the base its readout says it twists off underneath, and it lights up',
      JSON.stringify(onBase),
    );
    // the walls low on the lantern, over its bottom: a cut across there would take the rest of it off as its top, so
    // the base lights up there and a click takes it out – Alt still places a cut across
    await b.keyboard.down('Alt');
    let lowY = null;
    let lowZ = null;
    for (let y = pickAt.base; y > stage.y && lowY == null; y -= 3) {
      await b.mouse.move(px, y);
      await b.waitForTimeout(40);
      const z = Number((await pickReadout())?.lines[0].match(/^Z ([\d.]+) mm/)?.[1]);
      if (z > 21 && z < 28) [lowY, lowZ] = [y, z];
    }
    await b.keyboard.up('Alt');
    await restAt(px, lowY);
    const onLowWall = { ...(await pickReadout()), ...(await pickColours()) };
    await b.mouse.click(px, lowY);
    await settle();
    const lowRows = await partRows();
    await b.click('#undoBtn');
    await settle();
    check(
      lowY != null && JSON.stringify(onLowWall.lines) === JSON.stringify(['Base twists off underneath · Ø 43 mm opening · twist-lock, 3 lugs, turn 23°']) && onLowWall.gold > 1000 &&
        lowRows.length === 1 && lowRows[0].name === 'Base' && (await partRows()).length === 0,
      "low on the lantern's walls, over its bottom, the base lights up and a click takes it out – not a cut across that takes the top off",
      JSON.stringify({ lowY, lowZ, onLowWall, lowRows }),
    );
    await b.click('#addApartBtn');
    await settle();
    // a click on the dome: its part, placed as the finder places it, selected; placing stops
    await b.mouse.click(px, pickAt.dome);
    await settle();
    const picked = { rows: await partRows(), pressed: await b.getAttribute('#addApartBtn', 'aria-pressed'), view: await pickColours() };
    await b.click('#undoBtn');
    await settle();
    const unpicked = await partRows();
    await b.click('#redoBtn');
    await settle();
    check(
      picked.rows.length === 1 && picked.rows[0].name === 'Dome and cap' && picked.rows[0].z === '86' && picked.rows[0].d === '47.3' &&
        picked.rows[0].meta === 'twist-lock, 3 lugs, 3 clicks – turn 27° · the handle stays' && picked.pressed === 'false' && picked.view.gold < 500 &&
        unpicked.length === 0 && (await partRows()).length === 1,
      'a click on the dome takes out the dome and cap where the finder puts it, twist-locking; placing stops, and one undo takes it back',
      JSON.stringify({ picked, unpicked }),
    );
    // Shift+click picks on: the base too; over the dome the readout says cut A takes it out already
    await b.click('#addApartBtn');
    await settle();
    await b.keyboard.down('Shift');
    await b.mouse.click(px, pickAt.base);
    await b.keyboard.up('Shift');
    await settle();
    await restAt(px, pickAt.dome);
    const kept = { rows: await partRows(), pressed: await b.getAttribute('#addApartBtn', 'aria-pressed'), readout: await pickReadout() };
    await b.mouse.click(px, pickAt.dome);
    await settle();
    check(
      kept.rows.map((r) => r.name).join('|') === 'Dome and cap|Base' && kept.pressed === 'true' && kept.readout?.lines[1] === 'cut A takes it out already' &&
        (await b.locator('#status').innerText()) === 'Cut A takes the dome and cap out already.' && (await partRows()).length === 2,
      'Shift+click takes the base out too and goes on picking; a part already taken out says which cut takes it, and a click on it adds no other',
      JSON.stringify(kept),
    );
    // the base's crosshair: a part picked again moves its cut, and nothing else does
    await b.locator('#cutList > li').first().locator('.cut-remove').click();
    await settle();
    await b.locator('#cutList > li').first().locator('[data-part-pick]').click();
    await settle();
    const again = { status: await b.locator('#status').innerText(), pressed: await b.locator('[data-part-pick]').first().getAttribute('aria-pressed') };
    await restAt(px, pickAt.band);
    again.band = await pickReadout();
    await b.mouse.click(px, pickAt.dome);
    await settle();
    const movedTo = await partRows();
    await b.click('#undoBtn');
    await settle();
    const movedBack = await partRows();
    await b.click('#redoBtn');
    await settle();
    check(
      again.status === 'Click a part that comes off to move cut A to it. Esc stops.' && again.pressed === 'true' &&
        again.band?.lines[0] === 'No part comes off here – point at one to move cut A there' && movedTo.length === 1 && movedTo[0].name === 'Dome and cap' &&
        movedTo[0].z === '86' && movedBack[0].name === 'Base',
      "a part's crosshair picks it again on the model: the base's cut moved to the dome, as one undo step",
      JSON.stringify({ again, movedTo, movedBack }),
    );
    // the selected part's ring handle: a white knob with a dark arrow across it – nothing like a hole – that says what
    // it does; pressed and let go where it was, nothing changes: the part keeps its lock's words and its lug marks
    await b.locator('#cutList > li').first().locator('.part-name').click();
    await b.mouse.move(stage.x + 20, stage.y + stage.height - 20);
    await b.waitForTimeout(300);
    const knob = await pickColours();
    const seatedRow = (await partRows())[0];
    await b.mouse.move(stage.x + knob.x, stage.y + knob.y);
    await b.waitForTimeout(200);
    const tip = await b.evaluate(() => document.querySelector('#stage canvas').title);
    await b.mouse.down();
    await b.mouse.move(stage.x + knob.x - 20, stage.y + knob.y, { steps: 4 });
    await b.mouse.move(stage.x + knob.x, stage.y + knob.y, { steps: 4 });
    await b.mouse.up();
    await settle();
    await b.mouse.move(stage.x + 20, stage.y + stage.height - 20);
    await b.waitForTimeout(300);
    const letGo = { row: (await partRows())[0], view: await pickColours() };
    check(
      knob.dark > 30 && knob.dark < 250 && tip === 'Drag to make the circle wider or narrower' && seatedRow.meta === 'twist-lock, 3 lugs, 3 clicks – turn 27° · the handle stays' &&
        letGo.row.meta === seatedRow.meta && letGo.row.d === seatedRow.d && letGo.view.teal > 0.9 * knob.teal,
      "the ring handle is a knob that says what it does; pressed and let go where it was, the part keeps its lock and its lug marks",
      JSON.stringify({ knob, tip, seatedRow, letGo }),
    );
    // a width typed with a pause in it is drawn as it is typed, and the cut changes only once it is entered: a half-
    // typed Ø 6 builds nothing and says nothing; entered as 60, it is held at the edge of its band, still twist-locking
    const widthBox = b.locator('[data-part-d]').first();
    await widthBox.click({ clickCount: 3 });
    await b.keyboard.type('6');
    await b.waitForTimeout(800);
    await settle();
    const halfTyped = { row: (await partRows())[0], notes: await b.locator('#splitNotes').innerText() };
    await b.keyboard.type('0');
    await b.keyboard.press('Enter');
    await settle();
    const entered = { row: (await partRows())[0], status: await b.locator('#status').innerText() };
    await b.locator('#cutList > li').first().locator('.part-name').click();
    await b.click('#undoBtn');
    await settle();
    check(
      halfTyped.row.meta === seatedRow.meta && halfTyped.row.d === '6' && !/cuts nothing/.test(halfTyped.notes) && entered.row.d === '47.3' &&
        entered.status === 'Ø 47.3 is as wide as fits here.' && entered.row.meta === seatedRow.meta && (await partRows())[0].d === seatedRow.d,
      'a Ø half typed builds nothing: the part keeps its lock until the number is entered, then is held where it prints apart',
      JSON.stringify({ halfTyped, entered }),
    );
    // the Clearance raised as the fit test says to: the part the finder placed is placed again for it, a layer up where
    // its edge needs the room, its lock's words kept – no warning about a face the finder chose
    await b.evaluate(() => (document.querySelector('[data-split="clearance"]').closest('details').open = true));
    const clearance = b.locator('[data-split="clearance"]');
    await clearance.fill('0.2');
    await clearance.dispatchEvent('change');
    await settle();
    await b.waitForTimeout(300);
    await settle();
    const refit = { row: (await partRows())[0], status: await b.locator('#status').innerText() };
    await clearance.fill('0.15');
    await clearance.dispatchEvent('change');
    await settle();
    await b.waitForTimeout(300);
    await settle();
    const refitBack = (await partRows())[0];
    check(
      refit.row.z === '86.2' && /^twist-lock, 3 lugs/.test(refit.row.meta) && !/moved/.test(refit.status) && refitBack.z === '86',
      'raising the Clearance places the finder\'s part again for it: Z 86.2, still twist-locking, no warning; lowered again, back at 86',
      JSON.stringify({ refit, refitBack }),
    );
    // and so does a change of the printer's layers: the face goes onto the new layers where its edge prints apart
    await b.evaluate(() => (document.querySelector('#printing').open = true));
    await b.fill('#layerHeight', '0.28');
    await b.dispatchEvent('#layerHeight', 'change');
    await settle();
    await b.waitForTimeout(300);
    await settle();
    const layered = (await partRows())[0];
    await b.fill('#layerHeight', '0.2');
    await b.dispatchEvent('#layerHeight', 'change');
    await settle();
    await b.waitForTimeout(300);
    await settle();
    const layeredBack = (await partRows())[0];
    check(
      layered.z !== '86' && Math.abs(Number(layered.z) - 86) < 1 && /^twist-lock, 3 lugs/.test(layered.meta) && layeredBack.z === '86',
      "0.28 mm layers place the finder's part again on them, still twist-locking; 0.2 mm again, back at 86",
      JSON.stringify({ layered, layeredBack }),
    );

    // its face typed too low: on the printer's layers, then moved up to where it prints apart, with the note's words
    const faceBox = b.locator('[data-part-z]').first();
    await faceBox.fill('85.3');
    await faceBox.press('Enter');
    await b.waitForTimeout(300);
    await settle();
    const low = { row: (await partRows())[0], status: await b.locator('#status').innerText() };
    check(
      low.row.z === '86' && low.row.meta === "the circle runs too close to the handle's feet at Z 85.2 – moved to Z 86" &&
        low.status === "Cut A: at Z 85.2 the dome and cap's edge runs into the handle's feet – it needs 0.9 mm to print apart. Moved to Z 86.",
      "a face typed under where the part prints apart goes onto the layers, then up to where it does, and the row and the page say why",
      JSON.stringify(low),
    );
    // the ring handle: the dark dot on the selected part's circle; dragged far out, held at the edge of its band – a
    // little over the lowest face, where the band round the dome widens past the handle's feet
    await faceBox.fill('87.4');
    await faceBox.press('Enter');
    await b.waitForTimeout(300);
    await settle();
    const higher = (await partRows())[0];
    await b.locator('#cutList > li').first().locator('.part-name').click();
    await b.mouse.move(stage.x + 20, stage.y + stage.height - 20);
    await b.waitForTimeout(300);
    const dot = await pickColours();
    await b.mouse.move(stage.x + dot.x, stage.y + dot.y);
    await b.waitForTimeout(200);
    const grab = await b.evaluate(() => document.querySelector('#stage canvas').style.cursor);
    // outwards: from the middle of the part through the dot, and on
    const away = Math.hypot(dot.x - dot.tx, dot.y - dot.ty) || 1;
    const [ux, uy] = [(dot.x - dot.tx) / away, (dot.y - dot.ty) / away];
    await b.mouse.down();
    await b.mouse.move(stage.x + dot.x + 60 * ux, stage.y + dot.y + 60 * uy, { steps: 6 });
    await b.mouse.move(stage.x + dot.x + 160 * ux, stage.y + dot.y + 160 * uy, { steps: 6 });
    await b.waitForTimeout(100);
    const dragging = (await partRows())[0].d;
    await b.mouse.up();
    await settle();
    const wide = { row: (await partRows())[0], status: await b.locator('#status').innerText() };
    await b.screenshot({ path: path.join(out, '21-ring-handle.png') });
    await b.click('#undoBtn');
    await settle();
    check(
      higher.z === '87.4' && dot.dark > 10 && grab === 'grab' && dragging === wide.row.d && Number(wide.row.d) > 48 && Number(wide.row.d) < 60 &&
        wide.status === `Ø ${wide.row.d} is as wide as fits here.` && (await partRows())[0].d === '47.3',
      "the selected part's ring handle drags its circle wider, held where it still prints apart, and the page says so; one undo takes it back",
      JSON.stringify({ higher, dot, grab, dragging, wide }),
    );

    // the card put away once the model is turned with no part taken out: turning it changes no part, and the engine is
    // not asked for the parts again ahead of the text's previews
    await b.click('#splitClearBtn');
    await settle();
    await b.click('#suggestSpotsBtn');
    await listed();
    await settle();
    await clearPosts();
    await b.evaluate(() => document.querySelector('[data-fix="rotZ"]').click());
    await settle();
    await b.waitForTimeout(300);
    await settle();
    const turnedAsked = (await posts()).filter((x) => x === 'split.plan:parts').length;
    check(turnedAsked === 0 && (await b.locator('#partsCard').isHidden()), 'turning the model with no part taken out puts the card away and asks for no parts', JSON.stringify({ turnedAsked, posts: await posts() }));

    // a closed hollow ball: its base is listed, but no lock fits it at any size, so the card offers nothing to press –
    // the note under it says to pick a place on the model, not to use a part above
    const ball = Manifold.difference(Manifold.sphere(40, 96), Manifold.sphere(37, 96));
    const ballFile = writeFixture('hollowball.stl', soupOf(ball));
    ball.delete();
    await b.setInputFiles('#stlFile', ballFile);
    await b.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('hollowball:'), null, { timeout: 60000 });
    await settle();
    await b.click('#suggestSpotsBtn');
    await listed();
    await settle();
    await b.waitForFunction(() => !document.querySelector('#spotsNote').hidden && !document.querySelector('#spotsNote').classList.contains('busy'), null, { timeout: 120000 });
    const ballCard = { card: await card(), note: await b.locator('#spotsNote').innerText() };
    check(
      ballCard.card.parts.length > 0 && ballCard.card.parts.every((x) => x.buttons.length === 0) && ballCard.note.startsWith('No good spot found – pick one on the model yourself:'),
      "a hollow ball's card offers nothing to press, and the spots' note says to pick a place on the model, not to use a part",
      JSON.stringify(ballCard),
    );
    // a click on the model while its parts are still being found waits for them, and then takes what it landed on: on
    // the base, too small at 100 %, no cut across that would take the top off – its row, lit
    {
      const w = await batContext.newPage();
      w.on('pageerror', (e) => batProblems.push(`pageerror: ${e.message}`));
      const idleW = async () => {
        await w.waitForTimeout(80);
        await w.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
      };
      await w.goto(url);
      await w.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
      await w.setInputFiles('#stlFile', batFile);
      await w.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('batlantern:'), null, { timeout: 60000 });
      await idleW();
      await w.evaluate(() => (document.querySelector('#toast').hidden = true));
      await w.click('#itemList li:first-child');
      await w.keyboard.press('Delete');
      await idleW();
      // the base where the first page found it at this size: the model is framed alike on loading
      const st = await w.locator('#stage canvas').boundingBox();
      await w.evaluate(() => (window.__holdParts = true));
      await w.click('#addApartBtn');
      await w.waitForFunction(() => document.querySelector('#partsNote').classList.contains('busy'), null, { timeout: 60000 });
      await w.waitForFunction(() => window.__heldParts.length > 0, null, { timeout: 120000 });
      const finding = await w.locator('#status').innerText();
      await w.mouse.move(st.x + st.width / 2, smallY + 1);
      await w.mouse.click(st.x + st.width / 2, smallY);
      const waiting = { status: await w.locator('#status').innerText(), rows: await w.locator('#cutList > li').count() };
      await w.evaluate(() => {
        window.__holdParts = false;
        window.__heldParts.splice(0).forEach((deliver) => deliver());
      });
      await w.waitForFunction(() => !document.querySelector('#partsNote').classList.contains('busy') && document.querySelectorAll('#partList li').length > 0, null, { timeout: 120000 });
      await idleW();
      const after = { status: await w.locator('#status').innerText(), rows: await w.locator('#cutList > li').count(), pressed: await w.getAttribute('#addApartBtn', 'aria-pressed') };
      check(
        finding.startsWith('Finding the parts that come off… Then click one that lights up') &&
          waiting.status === 'Finding the parts that come off – your click takes what it landed on once they are in.' && waiting.rows === 0 &&
          after.rows === 0 && after.pressed === 'true' && after.status.startsWith('The base is too small for its twist-lock at this size – it twists off underneath from 215 %.'),
        'a click while the parts are still being found waits for them: on the base, too small at 100 %, it places no cut across but offers the base',
        JSON.stringify({ smallY, finding, waiting, after }),
      );
      await w.close();
    }
    check(batProblems.length === 0, 'no page errors with parts that come off', batProblems.join(' | '));
    await batContext.close();
  }

  console.log("\na base's tea-light seat");
  {
    // the bat lantern with nothing on its floor: at 400 % a 38 mm tea light stands in a seat on its base
    const seatFile = writeFixture('bat-seat.stl', soupOf(batLanternSolid({ cup: false })));
    const seatContext = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
    // let the test read the view's WebGL pixels back, for the seat's colour in it
    await seatContext.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
    });
    const s = await seatContext.newPage();
    const seatProblems = [];
    s.on('pageerror', (e) => seatProblems.push(`pageerror: ${e.message}`));
    s.on('console', (m) => m.type() === 'error' && seatProblems.push(`console: ${m.text()}`));
    const settle = async () => {
      await s.waitForTimeout(80);
      await s.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
      await s.waitForTimeout(80);
      await s.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
    };
    const row = () =>
      s.evaluate(() => {
        const li = document.querySelector('#cutList > li.part');
        const box = li?.querySelector('[data-part-seat]');
        const label = box?.closest('label');
        return (
          li && {
            seat: { checked: box.checked, disabled: box.disabled, text: label.textContent, title: label.title, struck: label.classList.contains('struck'), aria: box.getAttribute('aria-label') },
            meta: li.querySelector('.meta').textContent,
          }
        );
      });
    const piecesText = async () => (await s.locator('#pieceList').innerText()).split('\n').filter(Boolean);
    await s.goto(url);
    await s.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await s.setInputFiles('#stlFile', seatFile);
    await s.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('bat-seat:'), null, { timeout: 60000 });
    await settle();
    await s.evaluate(() => (document.querySelector('#toast').hidden = true));
    await s.click('#itemList li:first-child');
    await s.keyboard.press('Delete');
    await settle();
    const listedParts = () => s.waitForFunction(() => !document.querySelector('#partsCard').hidden && !document.querySelector('#partsNote').classList.contains('busy') && document.querySelectorAll('#partList li').length > 0, null, { timeout: 120000 });
    await s.click('#addApartBtn');
    await listedParts();
    await settle();
    await s.keyboard.press('Escape');
    await settle();
    await s.locator('#partList li').first().locator('button', { hasText: 'Make it 400 %' }).click();
    await settle();
    await listedParts();
    await settle();
    const baseTitle = await s.locator('#partList li', { hasText: /^Base/ }).locator('.part-title').innerText();
    check(
      baseTitle.replace(/\u00a0/g, ' ') === 'Base – twists off underneath · twist-lock · Ø 58 mm opening, takes a 38 mm tea light · a seat for it on top',
      "at 400 % the card's base takes a 38 mm tea light in a seat on its top",
      baseTitle,
    );
    // Use: the base's row has its tea-light seat on, with its size, and says so under it
    await s.locator('#partList li', { hasText: /^Base/ }).locator('button', { hasText: /^Use$/ }).click();
    await settle();
    const used = await row();
    check(
      used?.seat.checked && !used.seat.disabled && used.seat.text === 'Tea-light seat Ø 39.5 mm' && used.meta === 'twist-lock, 3 lugs – turn 17° · coin slot · tea-light seat Ø 39.5 mm',
      "Use on a base with room for one gives it a tea-light seat, on by default: the row's box with its size, and its words",
      JSON.stringify(used),
    );
    // its pieces: the seat on the base, the notes saying where the light goes and how the base goes in with it
    await s.check('#resultToggle');
    await settle();
    await s.waitForTimeout(500);
    await settle();
    const withSeat = { pieces: await piecesText(), notes: await s.locator('#splitNotes').innerText(), legend: await s.evaluate(() => [...document.querySelectorAll('.legend > span')].filter((x) => !x.hidden).map((x) => x.textContent.trim())) };
    check(
      withSeat.pieces.length === 2 && /^2 · Base · .* · twist-lock, 3 lugs, coin slot · tea-light seat Ø 39\.5 mm$/.test(withSeat.pieces[1]) &&
        withSeat.notes.includes("the base (piece 2) twists off underneath, and a 38 mm tea light sits in the seat on top of it (Ø 39.5 mm, 3 mm deep). To fit it: stand the light in the seat") &&
        withSeat.notes.includes('Use an LED tea light') && withSeat.legend.includes('tea-light seat'),
      'Show pieces lists the seat on the base, the notes say a 38 mm tea light sits in it and how the base goes in with it, and the legend keys it',
      JSON.stringify(withSeat),
    );
    // the base alone, the top left on: Download fit test saves a ring of its bore and a short plug with its lock, and
    // the status says what they are and how they go together
    {
      const [dl] = await Promise.all([s.waitForEvent('download', { timeout: 60000 }).catch(() => null), s.click('#splitFitTestBtn')]);
      let shells = [];
      if (dl) {
        const file = path.join(out, 'bat-seat-fit-test.stl');
        await dl.saveAs(file);
        const buf = fs.readFileSync(file);
        const m = geometryToManifold(parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        shells = m.decompose().map((x) => {
          const b = x.boundingBox();
          x.delete();
          return [+(b.max[0] - b.min[0]).toFixed(1), +b.min[2].toFixed(3)];
        });
        m.delete();
      }
      await settle();
      const said = await s.locator('#status').innerText();
      check(
        !!dl && /^bat-seat.*-fit-test\.stl$/.test(dl.suggestedFilename()) && shells.length === 2 && shells.every(([, z]) => z === 0) &&
          /A ring Ø 75 mm and a plug with the base's twist-lock at this size \(about \d+ g\): looking at the plug's coin slot, it should go into the ring's bottom \(the side it printed on\) turned 17° to the left, turn right until it clicks/.test(said) &&
          withSeat.notes.includes("a ring Ø 75 mm and a plug with the base's twist-lock"),
        "with only the base taken out, Download fit test saves a file: a ring and a plug with the base's twist-lock, which the status and the notes describe",
        JSON.stringify({ file: dl?.suggestedFilename() ?? null, shells, said }),
      );
    }
    // the view: Look at the lock, then the seat from over the base, its word on it; the base's own ▶ brings the base
    // back into view from wherever the camera is, the seat showing through the pieces faded round it
    const violet = () =>
      s.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 150 && d[i + 1] < 0.75 * d[i + 2] && d[i + 2] > d[i] - 10 && d[i] > 0.45 * d[i + 2]) n++;
        return n;
      });
    // the view's pixels by hue, as shares of the canvas: the base's tan, the seat's violet as the legend keys it, and the
    // pink a violet turns lit orange
    const hues = () =>
      s.evaluate(() => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const n = { tan: 0, violet: 0, pink: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max - min < 30) continue;
          const h = max === r ? (60 * ((g - b) / (max - min)) + 360) % 360 : max === g ? 60 * ((b - r) / (max - min)) + 120 : 60 * ((r - g) / (max - min)) + 240;
          if (h >= 38 && h < 70) n.tan++;
          else if (h >= 245 && h < 275) n.violet++;
          else if (h >= 275 && h < 335) n.pink++;
        }
        const all = d.length / 4;
        return { tan: +((100 * n.tan) / all).toFixed(2), violet: +((100 * n.violet) / all).toFixed(2), pink: +((100 * n.pink) / all).toFixed(2) };
      });
    const lookWords = () => s.evaluate(() => [...document.querySelectorAll('#stage .lock-word')].filter((x) => !x.hidden).map((x) => x.textContent).sort().join('|'));
    const looks = [];
    for (let k = 0; k < 3; k++) {
      const label = await s.locator('#lookLockBtn').innerText();
      await s.click('#lookLockBtn');
      await s.waitForTimeout(300);
      looks.push({ label, words: await lookWords(), violet: await violet(), hues: await hues() });
    }
    check(
      looks[0].label === 'Look at the lock' && looks[0].words === 'click tab|lug|slot' && looks[1].label === 'Look at the seat' && looks[1].words === 'tea-light seat' &&
        looks[1].violet > 20000 && looks[1].violet > 50 * Math.max(looks[0].violet, 100) && looks[2].label === 'Look at the lock' && looks[2].words === 'click tab|lug|slot',
      "after the base's lock, Look at the seat shows the seat from over the base, named, filling the view; then the lock again",
      JSON.stringify(looks),
    );
    // looked at, the seat is the violet the legend keys it, not lit pink as the lock is lit orange
    check(
      looks[1].hues.violet > 2 && looks[1].hues.pink < 0.1 * looks[1].hues.violet,
      'Look at the seat shows it violet, as the legend keys it, not pink',
      JSON.stringify(looks[1].hues),
    );
    await s.hover('#cutList li.part .part-name');
    await s.locator('#cutList li.part [data-part-play]').click();
    await s.waitForTimeout(3000);
    const played = await violet();
    await s.mouse.move(700, 840);
    await s.waitForTimeout(200);
    check(played > 1500, "the base's own ▶, from close on its lock, frames the base dropping out, its seat showing", JSON.stringify({ played, lock: looks[2].violet }));
    // off while it is looked at, and back with undo and redo, one step each: the view stays on the base, its top bare,
    // then its seat again
    for (let k = 0; k < 3 && (await lookWords()) !== 'tea-light seat'; k++) {
      await s.click('#lookLockBtn');
      await s.waitForTimeout(300);
    }
    const looking = { words: await lookWords(), hues: await hues() };
    await s.locator('[data-part-seat]').uncheck();
    await settle();
    await s.waitForTimeout(400);
    await settle();
    const off = { row: await row(), pieces: await piecesText(), words: await lookWords(), label: await s.locator('#lookLockBtn').innerText(), hues: await hues() };
    await s.click('#undoBtn');
    await settle();
    await s.waitForTimeout(400);
    await settle();
    const undone = { row: await row(), pieces: await piecesText(), words: await lookWords(), hues: await hues() };
    check(
      looking.words === 'tea-light seat' && off.hues.tan > 0.8 * looking.hues.tan && off.hues.violet < 0.05 * looking.hues.violet && off.words === '' &&
        off.label === 'Look at the lock' && undone.words === 'tea-light seat' && undone.hues.violet > 0.8 * looking.hues.violet,
      'unticking the seat while it is looked at leaves the view on the base, its top bare; undo shows the seat there again',
      JSON.stringify({ looking, off: { words: off.words, label: off.label, hues: off.hues }, undone: { words: undone.words, hues: undone.hues } }),
    );
    await s.click('#redoBtn');
    await settle();
    const redone = await row();
    await s.click('#undoBtn');
    await settle();
    await s.waitForTimeout(400);
    await settle();
    check(
      !off.row.seat.checked && !off.row.seat.disabled && off.row.meta === 'twist-lock, 3 lugs – turn 17° · coin slot' && !/tea-light/.test(off.pieces[1]) &&
        undone.row.seat.checked && /tea-light seat Ø 39\.5 mm$/.test(undone.pieces[1]) && !redone.seat.checked && (await row()).seat.checked,
      "unticking the seat takes it off the base in one step, and undo and redo put it back and take it off again",
      JSON.stringify({ off, undone, redone }),
    );
    // the download: the base has its seat, a round pocket 39.5 mm across and 3 mm deep in the middle of its top; the
    // glue sheet says where the light goes
    const [dl] = await Promise.all([s.waitForEvent('download', { timeout: 120000 }), s.click('#downloadBtn')]);
    const zipFile = path.join(out, 'bat-seat.zip');
    await dl.saveAs(zipFile);
    await settle();
    const zip = unzipSync(new Uint8Array(fs.readFileSync(zipFile)));
    const baseEntry = Object.keys(zip).find((n) => /piece-2-of-2\.stl$/.test(n));
    const pocket = (() => {
      const bytes = zip[baseEntry];
      const m = geometryToManifold(parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      const bb = m.boundingBox();
      const at = (z) => {
        const cs = m.slice(bb.min[2] + z);
        const hole = cs.toPolygons().filter((p) => {
          let a = 0;
          for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
          return a < 0;
        });
        const xs = hole.flat().map((p) => p[0]);
        cs.delete();
        return { holes: hole.length, across: xs.length ? Math.max(...xs) - Math.min(...xs) : 0 };
      };
      const out = { shells: m.decompose().map((x) => (x.delete(), 1)).length, height: bb.max[2] - bb.min[2], floor: at(23.3), seat: at(24.9) };
      m.delete();
      return out;
    })();
    const glue = strFromU8(zip[Object.keys(zip).find((n) => n.endsWith('.txt'))]);
    check(
      pocket.shells === 1 && Math.abs(pocket.height - 26.4) < 0.01 && pocket.floor.holes === 0 && pocket.seat.holes === 1 && Math.abs(pocket.seat.across - 39.5) < 0.05 &&
        glue.includes('a 38 mm tea light sits in the seat on top of the base') && glue.includes('tea-light seat Ø 39.5 mm on top'),
      "the downloaded base has its seat: a round pocket Ø 39.5 mm down to 3 mm under its top, solid under it, and the glue sheet says the light sits in it",
      JSON.stringify({ baseEntry, pocket }),
    );
    // at 280 % a 38 mm tea light still goes in through the base, but there is no room for a seat's wall round it: the
    // card and the row say why, the box stays there to untick, the note says why and is no warning – the status line
    // stays grey – and Look at the lock goes on to the base's top, where the light stands
    await s.evaluate(() => {
      document.querySelector('#scalePercent').value = '70';
      document.querySelector('#scaleBtn').click();
    });
    await settle();
    await listedParts();
    await settle();
    await s.check('#resultToggle');
    await settle();
    await s.waitForTimeout(500);
    await settle();
    const small = {
      size: await s.evaluate(() => document.querySelector('#modelInfo').textContent.match(/: ([\d.]+ × [\d.]+ × [\d.]+) mm/)?.[1] ?? null),
      card: (await s.locator('#partList li', { hasText: /^Base/ }).locator('.part-title').innerText()).replace(/\u00a0/g, ' '),
      row: await row(),
      status: await s.evaluate(() => ({ text: document.querySelector('#status').textContent, error: document.querySelector('#status').classList.contains('error') })),
      notes: await s.locator('#splitNotes').innerText(),
      words: await lookWords(),
      label: await s.locator('#lookLockBtn').innerText(),
    };
    check(
      small.size === '70.0 × 70.0 × 140.0' && small.card === 'Base – twists off underneath · twist-lock · Ø 40 mm opening, takes a 38 mm tea light · no seat for it on top: too narrow for one' &&
        small.row.seat.checked && !small.row.seat.disabled && small.row.seat.struck && small.row.seat.text === 'Tea-light seat' &&
        small.row.seat.title === 'No tea-light seat fits: it is too narrow to keep a wall round one – that takes a Ø 42.6 mm opening' &&
        small.row.seat.aria === "A tea-light seat on top of cut A's base – none fits: it is too narrow to keep a wall round one – that takes a Ø 42.6 mm opening" &&
        small.row.meta === 'twist-lock, 3 lugs – turn 24° · coin slot · no tea-light seat: too narrow for one' && !small.status.error && !/tea-light/.test(small.status.text) &&
        small.notes.includes('Cut A: no tea-light seat on the base (piece 2) – it is too narrow to keep a wall round one – that takes a Ø 42.6 mm opening.') &&
        small.notes.includes("its Ø 40 mm opening takes a 38 mm tea light. To fit it: stand the light on the middle of the base, hold") &&
        small.words === '' && small.label === 'Look at the lock',
      'at 280 % the card, the row and a note say why no seat fits – no warning, and the box still there to untick',
      JSON.stringify(small),
    );
    const tops = [];
    for (let k = 0; k < 2; k++) {
      const label = await s.locator('#lookLockBtn').innerText();
      await s.click('#lookLockBtn');
      await s.waitForTimeout(300);
      tops.push({ label, words: await lookWords(), hues: await hues() });
    }
    await s.locator('[data-part-seat]').uncheck();
    await settle();
    await s.waitForTimeout(400);
    await settle();
    const unasked = { row: await row(), notes: await s.locator('#splitNotes').innerText() };
    check(
      tops[0].label === 'Look at the lock' && tops[0].words === 'click tab|lug|slot' && tops[1].label === "Look at the base's top" && tops[1].words === '' && tops[1].hues.tan > 5 &&
        tops[1].hues.violet < 0.2 &&
        !unasked.row.seat.checked && !unasked.row.seat.disabled && unasked.row.meta === 'twist-lock, 3 lugs – turn 24° · coin slot' && !/no tea-light seat/.test(unasked.notes),
      "Look at the lock goes on to the base's top where no seat fits; unticking the seat there asks for none, and the note goes",
      JSON.stringify({ tops, unasked }),
    );
    check(seatProblems.length === 0, "no page errors with a base's tea-light seat", seatProblems.join(' | '));
    await seatContext.close();
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
    // how each cut holds – Locks … Lifts off, a part's Twist-lock and Lifts off – inside its row, none of it cut off
    const holdsFit = () =>
      n.evaluate(() =>
        [...document.querySelectorAll('#cutList > li')].map((li) => {
          const row = li.getBoundingClientRect();
          const seg = li.querySelector('.cut-hold').getBoundingClientRect();
          const labels = [...li.querySelectorAll('.cut-hold label')];
          return { part: li.classList.contains('part'), out: Math.round(seg.right - row.right), clipped: labels.filter((l) => l.scrollWidth > l.clientWidth + 1).length, n: labels.length };
        }),
      );
    const planeHolds = await holdsFit();
    await n.setInputFiles('#stlFile', path.join(out, 'batlantern.stl'));
    await n.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('batlantern:'), null, { timeout: 60000 });
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await n.evaluate(() => document.querySelector('#suggestSpotsBtn').click());
    await n.waitForFunction(() => !document.querySelector('#partsCard').hidden && !document.querySelector('#partsNote').classList.contains('busy') && document.querySelectorAll('#partList li').length > 0, null, { timeout: 120000 });
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    await n.evaluate(() => [...document.querySelectorAll('#partList button')].find((x) => x.textContent === 'Use – it just lifts off').click());
    await n.waitForTimeout(500);
    await n.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    const partHolds = await holdsFit();
    check(
      planeHolds.length === 1 && planeHolds[0].n === 4 && partHolds.length === 1 && partHolds[0].part && partHolds[0].n === 2 &&
        [...planeHolds, ...partHolds].every((h) => h.out <= 0 && h.clipped === 0),
      "on a 320 px phone how a cut holds fits its row: a plane's four holds and a part's two, none cut off",
      JSON.stringify({ planeHolds, partHolds }),
    );
    await narrow.close();
  }

  console.log("\nthe lock on a phone");
  {
    // a phone's view is short, and the legend over it and the lock's tools under it take a good share: the lock looked
    // at, and the pieces as printed, are framed in what they leave clear
    const phone = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await phone.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
    });
    const q = await phone.newPage();
    const settled = async () => {
      await q.waitForTimeout(80);
      await q.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
      await q.waitForTimeout(80);
      await q.waitForSelector('body[data-engine="idle"]', { timeout: 120000 });
    };
    const press = (selector, text = null) =>
      q.evaluate(([selector, text]) => [...document.querySelectorAll(selector)].find((x) => text === null || x.textContent === text).click(), [selector, text]);
    await q.goto(url);
    await settled();
    await q.setInputFiles('#stlFile', path.join(out, 'batlantern.stl'));
    await q.waitForFunction(() => document.querySelector('#modelInfo').textContent.startsWith('batlantern:'), null, { timeout: 60000 });
    await settled();
    await press('#suggestSpotsBtn');
    await q.waitForFunction(() => !document.querySelector('#partsCard').hidden && !document.querySelector('#partsNote').classList.contains('busy') && document.querySelectorAll('#partList li').length > 0, null, { timeout: 120000 });
    await settled();
    await press('#partList li:first-child button', 'Make it 300 %');
    await settled();
    await q.waitForFunction(() => [...document.querySelectorAll('#partList button')].some((x) => x.textContent === 'Use'), null, { timeout: 120000 });
    await press('#partList li:first-child button', 'Use');
    await settled();
    await q.evaluate(() => document.querySelector('#resultToggle').click());
    await settled();
    await q.waitForTimeout(300);
    // the lock's orange on the canvas, and how much of it, or of the pieces, lies under an element over the view
    const under = (selector) =>
      q.evaluate((selector) => {
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const cr = c.getBoundingClientRect();
        const k = probe.width / cr.width;
        const boxes = [...document.querySelectorAll(selector)].filter((x) => !x.closest('[hidden]')).map((x) => x.getBoundingClientRect());
        const out = { lock: 0, lockUnder: 0, piece: 0, pieceUnder: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, bl] = [d[i], d[i + 1], d[i + 2]];
          const x = ((i / 4) % probe.width) / k + cr.left;
          const y = Math.floor(i / 4 / probe.width) / k + cr.top;
          const hidden = boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
          const lock = r > 150 && bl < 70 && g < 0.62 * r && g > 0.25 * r;
          const piece = lock || (bl > 150 && bl - r > 100) || (r > 200 && g > 120 && bl > 60 && bl < 140 && r - bl > 80);
          if (lock) {
            out.lock++;
            if (hidden) out.lockUnder++;
          }
          if (piece) {
            out.piece++;
            if (hidden) out.pieceUnder++;
          }
        }
        return out;
      }, selector);
    await press('#lookLockBtn');
    await q.waitForTimeout(400);
    const looked = await under('#stage .legend, #stage .stage-tools, #lockPanel .lock-tools > *');
    await press('#frameBtn');
    await press('#asPrintedToggle');
    await q.waitForTimeout(400);
    const printedOn = await under('#stage .legend, #stage .stage-tools, #lockPanel .lock-tools > *');
    check(
      looked.lock > 300 && looked.lockUnder < 0.05 * looked.lock && printedOn.piece > 300 && printedOn.pieceUnder < 0.05 * printedOn.piece,
      "on a phone Look at the lock and As printed frame the pieces clear of the legend and the lock's tools over the view",
      JSON.stringify({ looked, printedOn }),
    );
    await phone.close();
  }

  console.log('\nthe look: cyberpunk by default, Classic on the switch');
  {
    const lookProblems = [];
    const preserve = () => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl' || type === 'webgl2') attrs = { ...attrs, preserveDrawingBuffer: true };
        return getContext.call(this, type, attrs);
      };
    };
    const lookContext = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    await lookContext.addInitScript(preserve);
    const p = await lookContext.newPage();
    p.on('pageerror', (e) => lookProblems.push(`pageerror: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && lookProblems.push(`console: ${m.text()}`));
    const ready = async () => {
      await p.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
      await p.waitForTimeout(150);
      await p.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    };
    /** The page's look as the browser has it: the attribute, the switch, the font, tokens, the legend's chips, storage, focus. */
    const look = () =>
      p.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        // a token as the colour it computes to (the build writes #ffffff as #fff)
        const colorOf = (token) => {
          const probe = document.createElement('i');
          probe.style.color = `var(${token})`;
          document.body.append(probe);
          const c = getComputedStyle(probe).color;
          probe.remove();
          return c;
        };
        const chip = (c) => getComputedStyle(document.querySelector(`.legend .dot.${c}`)).backgroundColor;
        let stored;
        try {
          stored = localStorage.getItem('stltext.theme');
        } catch {
          stored = 'throws';
        }
        return {
          theme: document.documentElement.dataset.theme ?? null,
          checked: document.querySelector('#classicLook').checked,
          font: getComputedStyle(document.body).fontFamily,
          panel: colorOf('--panel'),
          accent: colorOf('--accent'),
          raised: chip('emboss'),
          cutText: chip('engrave'),
          meanings: ['cut', 'apart', 'lock', 'lug', 'seat', 'over'].map(chip).join(' ') + ` | ${getComputedStyle(document.querySelector('.legend .dot.bridge')).boxShadow}`,
          themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null,
          stored,
          focus: document.activeElement?.id ?? null,
        };
      });
    /**
     * What a look does beyond its colours, as the browser has it: the scroll bars' thumb against the panel (and with more
     * contrast asked for), the bar at the foot of the panel in forced colours, and the line editor's text box.
     */
    const details = async () => {
      const read = () =>
        p.evaluate(() => {
          const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
          const lum = (c) => {
            const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const ratio = (a, b) => {
            const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
            return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
          };
          const thumb = getComputedStyle(document.documentElement).scrollbarColor;
          const box = getComputedStyle(document.querySelector('#lineList .line-text'));
          return {
            thumb: thumb === 'auto' ? 'auto' : ratio(thumb.match(/rgba?\([^)]*\)/)[0], getComputedStyle(document.querySelector('.panel')).backgroundColor),
            bar: getComputedStyle(document.querySelector('.actions')).backgroundColor,
            box: `${box.borderTopWidth} ${box.borderTopStyle}, radius ${box.borderTopLeftRadius}, padding ${box.padding}`,
          };
        });
      const plain = await read();
      await p.emulateMedia({ contrast: 'more' });
      const more = await read();
      await p.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' });
      const forced = await read();
      await p.emulateMedia({ forcedColors: 'none' });
      return { thumb: plain.thumb, thumbMore: more.thumb, box: plain.box, barForced: forced.bar };
    };
    /** The text's pixels in the view, by its colour in each look: raised magenta or orange, cut acid green or pink-red. */
    const textPixels = () =>
      p.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        const n = { magenta: 0, orange: 0, acid: 0, pink: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          if (r > 200 && b > 170 && g < 90) n.magenta++;
          else if (r > 200 && g > 0.35 * r && g < 0.65 * r && b < 80) n.orange++;
          else if (g > 140 && r > 0.6 * g && r < 0.95 * g && b < 0.65 * g) n.acid++;
          else if (r > 170 && g < 0.6 * r && b > 0.45 * r && b < 0.85 * r) n.pink++;
        }
        return n;
      });
    const toggle = async () => {
      await p.focus('#classicLook');
      await p.keyboard.press('Space');
      await p.waitForTimeout(100);
    };
    await p.goto(url);
    await ready();
    const fresh = await look();
    const freshPixels = await textPixels();
    await p.emulateMedia({ colorScheme: 'dark' });
    const freshDark = (await look()).panel;
    await p.emulateMedia({ colorScheme: 'light' });
    const freshLight = (await look()).panel;
    check(
      fresh.theme === 'cyber' && !fresh.checked && fresh.font.startsWith('Inter') && fresh.raised === 'rgb(255, 43, 214)' && fresh.cutText === 'rgb(198, 255, 61)' &&
        fresh.themeColor === '#0e0b1a' && fresh.stored === null && freshDark === 'rgb(14, 11, 26)' && freshLight === 'rgb(14, 11, 26)',
      'with nothing stored the page has the cyberpunk look, dark in either scheme, in Inter, its chips the colours the view draws text in',
      JSON.stringify({ fresh, freshDark, freshLight }),
    );
    check(freshPixels.magenta > 300 && freshPixels.orange < 20, 'the raised text is drawn magenta in the view, not orange', JSON.stringify(freshPixels));
    const freshDetails = await details();
    check(
      freshDetails.thumb >= 3 && freshDetails.thumbMore > freshDetails.thumb && freshDetails.box === '1px solid, radius 0px, padding 6px 8px' && freshDetails.barForced.startsWith('rgb('),
      "in the cyberpunk look the scroll bars' thumb is 3:1 on the panel and firmer with more contrast, the line's box is a field, and the bar at the foot of the panel stays solid in forced colours",
      JSON.stringify(freshDetails),
    );

    await toggle();
    const classic = await look();
    const classicPixels = await textPixels();
    await p.emulateMedia({ colorScheme: 'dark' });
    const classicDark = (await look()).panel;
    await p.emulateMedia({ colorScheme: 'light' });
    const classicLight = (await look()).panel;
    check(
      classic.theme === 'classic' && classic.checked && classic.accent === 'rgb(255, 122, 26)' && !classic.font.startsWith('Inter') && classic.raised === 'rgb(255, 138, 43)' &&
        classic.cutText === 'rgb(255, 59, 107)' && classic.themeColor === null && classic.stored === 'classic' && classic.focus === 'classicLook' &&
        classicLight === 'rgb(255, 255, 255)' && classicDark === 'rgb(23, 29, 43)',
      'ticking Classic (Space on the switch) brings back the old tokens, light or dark as the system is, keeps the focus and is stored',
      JSON.stringify({ classic, classicLight, classicDark }),
    );
    check(classicPixels.orange > 300 && classicPixels.magenta < 20, 'in Classic the view draws the raised text orange again, at once', JSON.stringify(classicPixels));
    const classicDetails = await details();
    check(
      classicDetails.thumb === 'auto' && /^2px inset, radius 0px, padding 1px 2px$/.test(classicDetails.box) && classicDetails.barForced.startsWith('rgb('),
      "Classic keeps the browser's own scroll bars and its own box for a line's text, as it always had, and the bar at the foot of the panel stays solid in forced colours",
      JSON.stringify(classicDetails),
    );
    check(
      classic.meanings === fresh.meanings && fresh.meanings === 'rgb(139, 92, 246) rgb(13, 148, 136) rgb(255, 106, 0) rgb(255, 214, 10) rgb(139, 92, 246) rgb(225, 29, 72) | rgb(250, 204, 21) 0px 0px 0px 2px inset',
      "the chips for a cut, a cut that comes apart and the lock (its lugs, seat, overhang and bridges) are the view's colours in either look",
      JSON.stringify({ cyber: fresh.meanings, classic: classic.meanings }),
    );

    // cut in: acid green in the cyberpunk look, the old pink-red in Classic
    await p.click('input[name="mode"][value="engrave"]', { force: true });
    await ready();
    const cutClassic = await textPixels();
    await toggle();
    const cutCyber = await textPixels();
    check(
      cutClassic.pink > 300 && cutClassic.acid < 20 && cutCyber.acid > 300 && cutCyber.pink < 20,
      'cut-in text is drawn pink-red in Classic and acid green in the cyberpunk look',
      JSON.stringify({ cutClassic, cutCyber }),
    );
    await toggle();
    await p.click('input[name="mode"][value="emboss"]', { force: true });
    await ready();

    // reloaded, Classic is there before the app's script runs: the head's own script set it, before the first paint
    await p.reload();
    await ready();
    const reloaded = await look();
    const reloadedPixels = await textPixels();
    const early = await lookContext.newPage();
    let held = 0;
    await early.route(/\/assets\/index-[^/]*\.js$/, (route) => {
      held++;
      return route.abort();
    });
    await early.goto(url);
    const before = await early.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      panel: getComputedStyle(document.querySelector('.panel')).backgroundColor,
      engine: document.body.dataset.engine,
      themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null,
      orangeIcon: document.querySelector('link[rel="icon"]').href.includes('ff7a1a'),
    }));
    before.held = held;
    await early.close();
    check(
      reloaded.theme === 'classic' && reloaded.checked && reloadedPixels.orange > 300 && before.held === 1 && before.theme === 'classic' && before.panel === 'rgb(255, 255, 255)' &&
        before.engine === 'starting' && before.themeColor === null && before.orangeIcon,
      "reloaded, the page is Classic, and already was with the app's script held back: no flash of the other look, in the page, the browser's bar or the tab's icon",
      JSON.stringify({ reloaded, reloadedPixels, before }),
    );

    // the meanings on the model are the same in either look: a glued cut's handle is exactly the cut violet
    await p.evaluate(() => document.querySelector('#addCutBtn').click());
    await ready();
    const violet = () =>
      p.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const c = document.querySelector('#stage canvas');
        const probe = document.createElement('canvas');
        probe.width = c.width;
        probe.height = c.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 139) + Math.abs(d[i + 1] - 92) + Math.abs(d[i + 2] - 246) < 30) n++;
        return n;
      });
    const violetClassic = await violet();
    await toggle();
    const back = await look();
    const violetCyber = await violet();
    check(
      violetClassic > 50 && violetCyber > 50 && back.theme === 'cyber' && !back.checked && back.stored === null && back.raised === 'rgb(255, 43, 214)',
      "a glued cut is the same violet in either look; unticking Classic brings the cyberpunk look back and forgets the choice",
      JSON.stringify({ violetClassic, violetCyber, back }),
    );
    check(lookProblems.length === 0, 'no page errors switching the look', lookProblems.join(' | '));
    await lookContext.close();

    // where storage is blocked: the default look, no errors, and the switch still works for the visit
    const blocked = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    const q = await blocked.newPage();
    const blockedProblems = [];
    q.on('pageerror', (e) => blockedProblems.push(`pageerror: ${e.message}`));
    await q.goto(url);
    await q.waitForSelector('body[data-engine="idle"]', { timeout: 60000 });
    const blockedStart = await q.evaluate(() => document.documentElement.dataset.theme);
    await q.focus('#classicLook');
    await q.keyboard.press('Space');
    const blockedAfter = await q.evaluate(() => ({ theme: document.documentElement.dataset.theme, panel: getComputedStyle(document.querySelector('.panel')).backgroundColor }));
    check(
      blockedStart === 'cyber' && blockedAfter.theme === 'classic' && blockedAfter.panel === 'rgb(255, 255, 255)' && blockedProblems.length === 0,
      'with storage blocked the page opens in the cyberpunk look without errors, and Classic still works for the visit',
      JSON.stringify({ blockedStart, blockedAfter, blockedProblems }),
    );
    await blocked.close();
  }

  check(problems.length === 0, 'no console errors or exceptions (page or worker)', problems.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
